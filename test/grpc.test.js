// -----------------------------------------------------------------------------
// The gRPC transport against a real HTTP/2 server on 127.0.0.1.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { GrpcError, frame, unaryCall, unframe } from '../src/starlink/grpc.js';
import { createDishClient } from '../src/starlink/client.js';
import { GRPC_PATH, requests } from '../src/starlink/schema.js';
import { DISH_ID, createFakeDish } from './helpers/fakeDish.js';

test('frames round-trip; a short or compressed body is refused', () => {
  const payload = Buffer.from('dish');
  assert.deepEqual(unframe(frame(payload)), payload);
  assert.throws(() => unframe(Buffer.alloc(2)), /empty answer/);
  assert.throws(() => unframe(Buffer.from([1, 0, 0, 0, 0])), /compressed/);
  assert.throws(() => unframe(Buffer.from([0, 0, 0, 0, 9, 1])), /truncated/);
});

test('the client reads the dish through real gRPC', async (t) => {
  const dish = await createFakeDish();
  t.after(() => dish.close());
  const client = createDishClient({ host: '127.0.0.1', port: dish.port });
  const status = await client.getStatus();
  assert.equal(status.id, DISH_ID);
  assert.equal((await client.getHistory()).current, 119395);
  assert.equal((await client.getConfig()).snowMeltMode, 'always_off');
  await client.reboot();
  await client.stow(true);
  await client.setSnowMeltMode('always_on');
  assert.deepEqual(dish.kinds(), [
    'GET_STATUS',
    'GET_HISTORY',
    'DISH_GET_CONFIG',
    'REBOOT',
    'DISH_STOW',
    'DISH_SET_CONFIG',
  ]);
});

test('a gRPC error status is reported with its name and message', async (t) => {
  const dish = await createFakeDish({ history: null });
  t.after(() => dish.close());
  const client = createDishClient({ host: '127.0.0.1', port: dish.port });
  await assert.rejects(client.getHistory(), (err) => {
    assert.ok(err instanceof GrpcError);
    assert.equal(err.code, 12);
    assert.equal(err.unreachable, false);
    assert.equal(err.message, 'gRPC UNIMPLEMENTED: Unimplemented request');
    return true;
  });
});

test('an HTTP server that is not gRPC is reported as such', async (t) => {
  const dish = await createFakeDish();
  t.after(() => dish.close());
  dish.mode = 'http404';
  const client = createDishClient({ host: '127.0.0.1', port: dish.port });
  await assert.rejects(client.getStatus(), /HTTP 404 .*not a gRPC server/);
});

test('no answer within the timeout: unreachable', async (t) => {
  const dish = await createFakeDish();
  t.after(() => dish.close());
  dish.mode = 'hang';
  const client = createDishClient({ host: '127.0.0.1', port: dish.port, timeoutMs: 100 });
  await assert.rejects(client.getStatus(), (err) => {
    assert.equal(err.unreachable, true);
    assert.match(err.message, /no answer from 127\.0\.0\.1:\d+ within 0\.1 s/);
    return true;
  });
});

test('nothing listening: unreachable at once', async () => {
  // A port that was free a moment ago.
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const client = createDishClient({ host: '127.0.0.1', port });
  await assert.rejects(client.getStatus(), (err) => {
    assert.equal(err.unreachable, true);
    assert.match(err.message, /cannot reach 127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
    return true;
  });
});

test('a server that is not HTTP/2 at all fails cleanly', async (t) => {
  const server = net.createServer((socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await assert.rejects(
    unaryCall({
      host: '127.0.0.1',
      port: server.address().port,
      path: GRPC_PATH,
      message: requests.getStatus(),
      timeoutMs: 2000,
    }),
    GrpcError,
  );
});
