// -----------------------------------------------------------------------------
// A fake Starlink dish: a real gRPC server (HTTP/2 without TLS, like the dish)
// answering `SpaceX.API.Device.Device/Handle` with the recorded answers of
// test/fixtures/starlink (encoded by the official protobuf implementation,
// see the README there). Listens on 127.0.0.1, a random port.
// -----------------------------------------------------------------------------

import http2 from 'node:http2';
import { readFileSync } from 'node:fs';
import { Message } from '../../src/starlink/protobuf.js';
import { REQUEST } from '../../src/starlink/schema.js';
import { frame, unframe } from '../../src/starlink/grpc.js';

export const DISH_ID = 'ut01000000-00000000-00c0ffee';

/** A recorded answer of test/fixtures/starlink. */
export const fixture = (name) =>
  readFileSync(new URL(`../fixtures/starlink/${name}`, import.meta.url));

const KINDS = Object.fromEntries(Object.entries(REQUEST).map(([kind, field]) => [field, kind]));

/**
 * @param {object} [options]
 * @param {string} [options.status] the fixture answering get_status
 * @param {string | null} [options.history] the fixture answering get_history, null: UNIMPLEMENTED
 * @param {string} [options.config] the fixture answering dish_get_config
 */
export async function createFakeDish({
  status = 'status-connected.bin',
  history = 'history.bin',
  config = 'config.bin',
} = {}) {
  const sessions = new Set();
  const dish = {
    status,
    history,
    config,
    setConfig: 'set-config.bin',
    /** 'answer' | 'hang' (no answer: a timeout) | 'http404' | 'grpc-error' */
    mode: 'answer',
    /** Every request received: { kind, body } (body: the decoded request member). */
    requests: [],
    port: 0,
    get address() {
      return `127.0.0.1:${dish.port}`;
    },
    kinds() {
      return dish.requests.map((request) => request.kind);
    },
    /** Stop answering: refused connections, as a dish without power. */
    async unplug() {
      for (const session of sessions) {
        session.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
    async plug() {
      await new Promise((resolve) => server.listen(dish.port, '127.0.0.1', resolve));
    },
    async close() {
      for (const session of sessions) {
        session.destroy();
      }
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };

  const server = http2.createServer();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      if (dish.mode === 'hang') {
        return;
      }
      if (dish.mode === 'http404' || headers[':path'] !== '/SpaceX.API.Device.Device/Handle') {
        stream.respond({ ':status': 404 });
        stream.end();
        return;
      }
      const request = Message.decode(unframe(Buffer.concat(chunks)));
      const field = [...request.fields.keys()].find((number) => KINDS[number]);
      const kind = KINDS[field] ?? `field ${[...request.fields.keys()]}`;
      dish.requests.push({ kind, body: field ? request.message(field) : null });

      const answers = {
        GET_STATUS: dish.status,
        GET_HISTORY: dish.history,
        DISH_GET_CONFIG: dish.config,
        REBOOT: 'reboot.bin',
        DISH_STOW: 'stow.bin',
        DISH_SET_CONFIG: dish.setConfig,
      };
      const answer = answers[kind];
      if (dish.mode === 'grpc-error' || !answer) {
        // A trailers-only answer, as gRPC servers send an error.
        stream.respond(
          {
            ':status': 200,
            'content-type': 'application/grpc',
            'grpc-status': '12',
            'grpc-message': 'Unimplemented%20request',
          },
          { endStream: true },
        );
        return;
      }
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc' },
        { waitForTrailers: true },
      );
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(frame(fixture(answer)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  dish.port = server.address().port;
  return dish;
}
