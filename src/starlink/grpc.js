// -----------------------------------------------------------------------------
// A unary gRPC call over plain HTTP/2, with Node's built-in `http2` module.
//
// The dish serves gRPC without TLS (h2c, "prior knowledge"). A unary call is a
// POST of one length-prefixed message; the answer is one length-prefixed
// message followed by trailers carrying `grpc-status`. That is the whole
// protocol for what the integration does: no @grpc/grpc-js, no protobuf
// runtime, nothing to install in the 256 MB sandbox.
//
// One connection per call: the integration talks to the dish twice every
// poll period, and a connection kept open across a dish reboot would hang the
// next call until its timeout instead of failing at once.
// -----------------------------------------------------------------------------

import http2 from 'node:http2';

// A status answer is ~1 KB, a history ~25 KB (900 samples); older firmware
// kept 12 hours of samples. Anything bigger is not the dish.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** gRPC status codes worth a name in a log line. */
const GRPC_CODES = {
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  16: 'UNAUTHENTICATED',
};

export class GrpcError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: number, cause?: unknown, unreachable?: boolean }} [details]
   */
  constructor(message, { code, cause, unreachable = false } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GrpcError';
    this.code = code;
    // True when nothing answered (refused, timeout, no route): the dish is
    // off or out of reach. False when something answered, but wrongly.
    this.unreachable = unreachable;
  }
}

/** Frame a message: compression flag (0), big-endian length, payload. */
export function frame(payload) {
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/** Read the first framed message of a body. */
export function unframe(body) {
  if (body.length < 5) {
    throw new GrpcError('gRPC: empty answer');
  }
  if (body.readUInt8(0) !== 0) {
    throw new GrpcError('gRPC: compressed answer, not supported');
  }
  const length = body.readUInt32BE(1);
  if (body.length < 5 + length) {
    throw new GrpcError('gRPC: truncated answer');
  }
  return body.subarray(5, 5 + length);
}

// Nothing answered at that address: the dish is off, unplugged or out of reach.
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/** The network error code behind an error (http2 wraps it in its own). */
function networkCode(err) {
  for (let current = err; current; current = current.cause) {
    if (NETWORK_CODES.has(current.code)) {
      return current.code;
    }
  }
  return null;
}

function decodeGrpcMessage(value) {
  try {
    return decodeURIComponent(String(value ?? ''));
  } catch {
    return String(value ?? '');
  }
}

/**
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.path e.g. /SpaceX.API.Device.Device/Handle
 * @param {Buffer} options.message the encoded request
 * @param {number} [options.timeoutMs]
 * @param {typeof http2.connect} [options.connect] injected by the tests
 * @returns {Promise<Buffer>} the encoded answer
 */
export function unaryCall({
  host,
  port,
  path,
  message,
  timeoutMs = 5000,
  connect = http2.connect,
}) {
  // IPv6 literals need brackets in an authority.
  const authority = host.includes(':') ? `http://[${host}]:${port}` : `http://${host}:${port}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let session;
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (session && !session.destroyed) {
        session.destroy();
      }
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new GrpcError(`no answer from ${host}:${port} within ${timeoutMs / 1000} s`, {
            unreachable: true,
          }),
        ),
      timeoutMs,
    );

    try {
      session = connect(authority);
    } catch (err) {
      finish(new GrpcError(`cannot connect to ${host}:${port}: ${err.message}`, { cause: err }));
      return;
    }
    const failed = (err) => {
      const code = networkCode(err);
      finish(
        code
          ? new GrpcError(`cannot reach ${host}:${port} (${code})`, {
              cause: err,
              unreachable: true,
            })
          : new GrpcError(`gRPC failure with ${host}:${port}: ${err.message}`, { cause: err }),
      );
    };
    session.on('error', failed);

    const stream = session.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/grpc',
      te: 'trailers',
      'grpc-timeout': `${Math.max(1, Math.ceil(timeoutMs))}m`,
    });
    const chunks = [];
    let size = 0;
    let headers = {};
    let trailers = {};
    stream.on('response', (received) => {
      headers = received;
    });
    stream.on('trailers', (received) => {
      trailers = received;
    });
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        finish(new GrpcError('gRPC: answer too large'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', failed);
    stream.on('end', () => {
      const httpStatus = Number(headers[':status']);
      if (httpStatus !== 200) {
        finish(new GrpcError(`HTTP ${httpStatus || '?'} from ${host}:${port}: not a gRPC server?`));
        return;
      }
      // A "trailers-only" answer (an error) carries grpc-status in the headers.
      const rawStatus = trailers['grpc-status'] ?? headers['grpc-status'];
      const code = rawStatus === undefined ? NaN : Number(rawStatus);
      if (code !== 0) {
        const name = GRPC_CODES[code] ?? `code ${rawStatus ?? 'missing'}`;
        const text = decodeGrpcMessage(trailers['grpc-message'] ?? headers['grpc-message']);
        finish(new GrpcError(`gRPC ${name}${text ? `: ${text}` : ''}`, { code }));
        return;
      }
      try {
        finish(null, unframe(Buffer.concat(chunks)));
      } catch (err) {
        finish(err);
      }
    });
    stream.end(frame(message));
  });
}
