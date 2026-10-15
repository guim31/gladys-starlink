import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Message, encode } from '../src/starlink/protobuf.js';

test('scalars round-trip, absent fields read as their proto3 default', () => {
  const bytes = encode([
    [1, 'varint', 300],
    [2, 'bool', true],
    [3, 'float', 1.5],
    [4, 'string', 'été'],
    [5, 'message', [[1, 'varint', 7]]],
    [1001, 'varint', 2 ** 40],
  ]);
  const message = Message.decode(bytes);
  assert.equal(message.uint(1), 300);
  assert.equal(message.bool(2), true);
  assert.equal(message.float(3), 1.5);
  assert.equal(message.string(4), 'été');
  assert.equal(message.message(5).uint(1), 7);
  assert.equal(message.uint(1001), 2 ** 40);

  assert.equal(message.uint(9), 0);
  assert.equal(message.bool(9), false);
  assert.equal(message.float(9), 0);
  assert.equal(message.string(9), '');
  assert.equal(message.message(9).has(1), false);
  assert.deepEqual(message.floats(9), []);
});

test('negative int64 values (10-byte varints) decode as signed', () => {
  const message = Message.decode(encode([[2, 'varint', -1n]]));
  assert.equal(message.int(2), -1);
  assert.equal(message.uint(2), 2 ** 64 - 1);
});

test('repeated floats decode packed and unpacked', () => {
  const packed = Message.decode(encode([[1001, 'floats', [0.5, 1, 2.25]]]));
  assert.deepEqual(packed.floats(1001), [0.5, 1, 2.25]);
  const unpacked = Message.decode(
    encode([
      [1001, 'float', 0.5],
      [1001, 'float', 1],
    ]),
  );
  assert.deepEqual(unpacked.floats(1001), [0.5, 1]);
});

test('unknown fields of every wire type are skipped, the last scalar wins', () => {
  const fixed64 = Buffer.from([(9 << 3) | 1, 1, 2, 3, 4, 5, 6, 7, 8]);
  const bytes = Buffer.concat([
    encode([[1, 'varint', 1]]),
    fixed64,
    encode([[2, 'bytes', Buffer.from([1, 2, 3])]]),
    encode([[1, 'varint', 2]]),
  ]);
  const message = Message.decode(bytes);
  assert.equal(message.uint(1), 2);
});

test('truncated or malformed input throws instead of reading garbage', () => {
  const whole = encode([[4, 'string', 'starlink']]);
  assert.throws(() => Message.decode(whole.subarray(0, whole.length - 2)), /truncated/);
  assert.throws(() => Message.decode(Buffer.from([0x08, 0x80])), /truncated varint/);
  assert.throws(() => Message.decode(Buffer.from([(1 << 3) | 5, 1, 2])), /truncated fixed/);
  assert.throws(() => Message.decode(Buffer.from([(1 << 3) | 3])), /wire type 3/);
  assert.throws(() => Message.decode(Buffer.from([0x00])), /invalid field number/);
});

test('undefined entries are left out of the encoding', () => {
  assert.equal(encode([[1, 'bool', undefined]]).length, 0);
  assert.throws(() => encode([[1, 'double', 1]]), /unknown type/);
});
