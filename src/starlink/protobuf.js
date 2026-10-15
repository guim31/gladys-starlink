// -----------------------------------------------------------------------------
// A minimal Protocol Buffers codec: just what the Starlink dish API needs.
//
// The dish speaks gRPC with protobuf messages. Instead of a protobuf library
// (and the .proto files of a reverse-engineered, ever-moving API), the few
// messages the integration reads are decoded by field number (see
// src/starlink/schema.js). Unknown fields are skipped, so a newer firmware
// that adds fields changes nothing; protobuf never reuses a field number.
//
// Wire types: 0 varint, 1 fixed64, 2 length-delimited, 5 fixed32. The group
// wire types (3, 4) are obsolete and never used by the dish.
// -----------------------------------------------------------------------------

const VARINT = 0;
const FIXED64 = 1;
const LENGTH = 2;
const FIXED32 = 5;

/** Read a varint at `offset`, as a BigInt (64-bit values do not fit a Number). */
function readVarint(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  let position = offset;
  for (;;) {
    if (position >= buffer.length) {
      throw new Error('protobuf: truncated varint');
    }
    const byte = buffer[position];
    position += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, offset: position };
    }
    shift += 7n;
    if (shift > 63n) {
      throw new Error('protobuf: varint too long');
    }
  }
}

/**
 * A decoded message: the raw values of every field, by field number, in wire
 * order. The typed getters interpret them; a field absent from the wire reads
 * as the proto3 default (0, false, '', an empty message).
 */
export class Message {
  /** @param {Map<number, Array<{ wire: number, value: bigint | Buffer }>>} fields */
  constructor(fields = new Map()) {
    this.fields = fields;
  }

  /** @param {Buffer | Uint8Array} bytes */
  static decode(bytes) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const fields = new Map();
    let offset = 0;
    while (offset < buffer.length) {
      const key = readVarint(buffer, offset);
      offset = key.offset;
      const number = Number(key.value >> 3n);
      const wire = Number(key.value & 7n);
      if (number < 1) {
        throw new Error('protobuf: invalid field number');
      }
      let value;
      if (wire === VARINT) {
        const read = readVarint(buffer, offset);
        value = read.value;
        offset = read.offset;
      } else if (wire === FIXED64 || wire === FIXED32) {
        const size = wire === FIXED64 ? 8 : 4;
        if (offset + size > buffer.length) {
          throw new Error('protobuf: truncated fixed field');
        }
        value = buffer.subarray(offset, offset + size);
        offset += size;
      } else if (wire === LENGTH) {
        const length = readVarint(buffer, offset);
        const end = length.offset + Number(length.value);
        if (end > buffer.length) {
          throw new Error('protobuf: truncated length-delimited field');
        }
        value = buffer.subarray(length.offset, end);
        offset = end;
      } else {
        throw new Error(`protobuf: unsupported wire type ${wire}`);
      }
      if (!fields.has(number)) {
        fields.set(number, []);
      }
      fields.get(number).push({ wire, value });
    }
    return new Message(fields);
  }

  /** @param {number} number */
  has(number) {
    return this.fields.has(number);
  }

  // The last occurrence wins for a scalar, as protobuf specifies.
  last(number, wire) {
    const values = (this.fields.get(number) ?? []).filter((entry) => entry.wire === wire);
    return values.length > 0 ? values[values.length - 1].value : undefined;
  }

  /** uint32/uint64/enum: a Number (exact up to 2^53, plenty for counters). */
  uint(number) {
    const value = this.last(number, VARINT);
    return value === undefined ? 0 : Number(BigInt.asUintN(64, value));
  }

  /** int32/int64: two's complement on 64 bits. */
  int(number) {
    const value = this.last(number, VARINT);
    return value === undefined ? 0 : Number(BigInt.asIntN(64, value));
  }

  bool(number) {
    const value = this.last(number, VARINT);
    return value !== undefined && value !== 0n;
  }

  float(number) {
    const value = this.last(number, FIXED32);
    return value === undefined ? 0 : value.readFloatLE(0);
  }

  string(number) {
    const value = this.last(number, LENGTH);
    return value === undefined ? '' : value.toString('utf8');
  }

  /** A sub-message; an absent one decodes as empty (all defaults). */
  message(number) {
    const value = this.last(number, LENGTH);
    return value === undefined ? new Message() : Message.decode(value);
  }

  /** repeated float, packed (proto3 default) or not. */
  floats(number) {
    const result = [];
    for (const { wire, value } of this.fields.get(number) ?? []) {
      if (wire === LENGTH) {
        for (let offset = 0; offset + 4 <= value.length; offset += 4) {
          result.push(value.readFloatLE(offset));
        }
      } else if (wire === FIXED32) {
        result.push(value.readFloatLE(0));
      }
    }
    return result;
  }

  /** repeated sub-messages. */
  messages(number) {
    return (this.fields.get(number) ?? [])
      .filter((entry) => entry.wire === LENGTH)
      .map((entry) => Message.decode(entry.value));
  }
}

// --- Encoding -----------------------------------------------------------------

function varint(value) {
  let rest = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest > 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (rest > 0n);
  return Buffer.from(bytes);
}

const tag = (number, wire) => varint((BigInt(number) << 3n) | BigInt(wire));

function float32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value, 0);
  return buffer;
}

/**
 * Encode a message from a list of fields. Each entry is
 * `[fieldNumber, type, value]`, type being one of: `varint` (uint, enum,
 * int64), `bool`, `float`, `string`, `bytes`, `message` (a nested list of
 * entries, or an already encoded Buffer), `floats` (packed repeated float).
 * Entries whose value is `undefined` are skipped.
 * @param {Array<[number, string, unknown]>} entries
 * @returns {Buffer}
 */
export function encode(entries) {
  const parts = [];
  for (const [number, type, value] of entries) {
    if (value === undefined) {
      continue;
    }
    switch (type) {
      case 'varint':
        parts.push(tag(number, VARINT), varint(value));
        break;
      case 'bool':
        parts.push(tag(number, VARINT), varint(value ? 1 : 0));
        break;
      case 'float':
        parts.push(tag(number, FIXED32), float32(value));
        break;
      case 'string':
      case 'bytes':
      case 'message': {
        const payload =
          type === 'string'
            ? Buffer.from(String(value), 'utf8')
            : Buffer.isBuffer(value)
              ? value
              : encode(value);
        parts.push(tag(number, LENGTH), varint(payload.length), payload);
        break;
      }
      case 'floats': {
        const payload = Buffer.concat(value.map(float32));
        parts.push(tag(number, LENGTH), varint(payload.length), payload);
        break;
      }
      default:
        throw new Error(`protobuf: unknown type ${type}`);
    }
  }
  return Buffer.concat(parts);
}
