'use strict';
const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const MAX = 4 * 1024 * 1024;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class UnixWebSocket extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.buffer = Buffer.alloc(0); this.parts = []; this.partSize = 0;
    this.fragmented = false; this.queue = []; this.waiters = []; this.failure = null;
    socket.on('data', data => { this.buffer = Buffer.concat([this.buffer, data]); this.parse(); });
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('Codex app-server disconnected')));
  }
  static connect(path) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(path); const key = crypto.randomBytes(16).toString('base64');
      let header = Buffer.alloc(0);
      const timer = setTimeout(() => stop(new Error('WebSocket handshake timed out')), 10000);
      const stop = error => { clearTimeout(timer); socket.destroy(); reject(error); };
      const onError = error => stop(error);
      socket.on('error', onError);
      socket.once('connect', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + key + '\r\n\r\n'));
      const onData = data => {
        header = Buffer.concat([header, data]); const end = header.indexOf('\r\n\r\n');
        if (end < 0) { if (header.length > 16384) stop(new Error('Oversize WebSocket handshake')); return; }
        const lines = header.subarray(0, end).toString('ascii').split('\r\n'); const fields = {};
        for (const line of lines.slice(1)) { const p = line.indexOf(':'); if (p >= 0) fields[line.slice(0, p).toLowerCase()] = line.slice(p + 1).trim(); }
        const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
        if (lines[0].split(' ')[1] !== '101' || fields['sec-websocket-accept'] !== expected || fields.upgrade?.toLowerCase() !== 'websocket') { stop(new Error('App-server rejected the WebSocket handshake')); return; }
        clearTimeout(timer); socket.removeListener('error', onError); socket.removeListener('data', onData);
        const ws = new UnixWebSocket(socket); ws.buffer = header.subarray(end + 4); ws.parse(); resolve(ws);
      };
      socket.on('data', onData);
      socket.once('close', () => { clearTimeout(timer); reject(new Error('Socket closed during handshake')); });
    });
  }
  frame(opcode, payload = Buffer.alloc(0)) {
    if (this.failure) return Promise.reject(this.failure);
    if (payload.length > MAX) return Promise.reject(new Error('WebSocket message exceeds size limit'));
    const n = payload.length; const h = Buffer.alloc(n < 126 ? 2 : n <= 65535 ? 4 : 10);
    h[0] = 0x80 | opcode;
    if (n < 126) h[1] = 0x80 | n;
    else if (n <= 65535) { h[1] = 0xfe; h.writeUInt16BE(n, 2); }
    else { h[1] = 0xff; h.writeBigUInt64BE(BigInt(n), 2); }
    const mask = crypto.randomBytes(4); const body = Buffer.alloc(n);
    for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i % 4];
    return new Promise((resolve, reject) => this.socket.write(Buffer.concat([h, mask, body]), error => error ? reject(error) : resolve()));
  }
  send(value) { return this.frame(1, Buffer.from(JSON.stringify(value))); }
  receive() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  deliver(value) { const waiter = this.waiters.shift(); if (waiter) waiter.resolve(value); else this.queue.push(value); }
  fail(error) { if (this.failure) return; this.failure = error; for (const w of this.waiters.splice(0)) w.reject(error); this.socket.destroy(); }
  parse() {
    try {
      while (this.buffer.length >= 2) {
        const a = this.buffer[0], b = this.buffer[1], opcode = a & 15, final = !!(a & 128);
        if ((a & 112) || (b & 128)) throw new Error('Unexpected WebSocket extension or server masking');
        let n = b & 127, offset = 2;
        if (n === 126) { if (this.buffer.length < 4) return; n = this.buffer.readUInt16BE(2); offset = 4; }
        else if (n === 127) { if (this.buffer.length < 10) return; const big = this.buffer.readBigUInt64BE(2); if (big > BigInt(MAX)) throw new Error('WebSocket response exceeds size limit'); n = Number(big); offset = 10; }
        if (n > MAX || this.partSize + n > MAX) throw new Error('WebSocket response exceeds size limit');
        if (opcode >= 8 && (!final || n > 125)) throw new Error('Invalid WebSocket control frame');
        if (this.buffer.length < offset + n) return;
        const data = this.buffer.subarray(offset, offset + n); this.buffer = this.buffer.subarray(offset + n);
        if (opcode === 8) throw new Error('App-server closed its WebSocket');
        if (opcode === 9) { this.frame(10, data).catch(e => this.fail(e)); continue; }
        if (opcode === 10) continue;
        if (opcode === 1 && !this.fragmented) this.fragmented = true;
        else if (opcode !== 0 || !this.fragmented) throw new Error('Expected WebSocket text/continuation');
        this.parts.push(data); this.partSize += n;
        if (final) {
          const text = Buffer.concat(this.parts).toString('utf8'); this.parts = []; this.partSize = 0; this.fragmented = false;
          this.deliver(JSON.parse(text));
        }
      }
    } catch (error) { this.fail(error); }
  }
  close() { this.socket.destroy(); }
}
module.exports = { UnixWebSocket, MAX };
