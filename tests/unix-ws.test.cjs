'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { EventEmitter } = require('node:events');
const { UnixWebSocket, MAX } = require('../scripts/unix-ws.cjs');
class Socket extends EventEmitter {
  constructor() { super(); this.sent = []; }
  write(data, callback) { this.sent.push(data); if (callback) callback(); }
  destroy() { this.emit('close'); }
}
function serverFrame(opcode, data, final = true) {
  const h = Buffer.alloc(data.length < 126 ? 2 : 4); h[0] = (final ? 128 : 0) | opcode;
  if (data.length < 126) h[1] = data.length; else { h[1] = 126; h.writeUInt16BE(data.length, 2); }
  return Buffer.concat([h, data]);
}
function decodeClient(data) {
  assert.ok(data[1] & 128); let n = data[1] & 127, offset = 2;
  if (n === 126) { n = data.readUInt16BE(2); offset = 4; }
  if (n === 127) { n = Number(data.readBigUInt64BE(2)); offset = 10; }
  const mask = data.subarray(offset, offset + 4); const body = Buffer.from(data.subarray(offset + 4));
  assert.equal(body.length, n); for (let i = 0; i < n; i++) body[i] ^= mask[i % 4]; return { opcode: data[0] & 15, body };
}
test('fragmentation, split network chunks and interleaved ping/pong preserve Unicode JSON', async () => {
  const socket = new Socket(), ws = new UnixWebSocket(socket); const expected = { text: '하위칩'.repeat(100) }; const payload = Buffer.from(JSON.stringify(expected));
  const wire = Buffer.concat([serverFrame(1, payload.subarray(0, 101), false), serverFrame(9, Buffer.from('ping')), serverFrame(0, payload.subarray(101))]);
  for (let i = 0; i < wire.length; i += 13) socket.emit('data', wire.subarray(i, i + 13));
  assert.deepEqual(await ws.receive(), expected); const pong = decodeClient(socket.sent[0]); assert.equal(pong.opcode, 10); assert.equal(pong.body.toString(), 'ping');
});
test('outbound long messages are masked with 64-bit frame length', async () => {
  const socket = new Socket(), ws = new UnixWebSocket(socket); const expected = { text: 'x'.repeat(70000) }; await ws.send(expected);
  const data = decodeClient(socket.sent[0]); assert.equal(data.opcode, 1); assert.deepEqual(JSON.parse(data.body.toString()), expected);
});
test('oversized inbound frames are rejected before reading payload', async () => {
  const socket = new Socket(), ws = new UnixWebSocket(socket); const h = Buffer.alloc(10); h[0] = 129; h[1] = 127; h.writeBigUInt64BE(BigInt(MAX + 1), 2); socket.emit('data', h);
  await assert.rejects(ws.receive(), /size limit/);
});
test('masked server frames are rejected', async () => {
  const socket = new Socket(), ws = new UnixWebSocket(socket); socket.emit('data', Buffer.from([129, 128])); await assert.rejects(ws.receive(), /masking/);
});
