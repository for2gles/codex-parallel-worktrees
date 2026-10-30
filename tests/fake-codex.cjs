#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
if (process.argv.includes('--version')) { console.log('fake-codex 1.0'); process.exit(0); }
const address = process.argv[process.argv.indexOf('--listen') + 1];
if (!address?.startsWith('unix://')) throw new Error('Fixture requires Unix listener');
const clients = new Set(); const thread = 'fake-' + process.pid;
let turn, number = 0, timer, task = '', approval = false;
const history = [];
function wire(socket, value) {
  const data = Buffer.from(JSON.stringify(value)); const n = data.length; let head;
  if (n < 126) head = Buffer.from([0x81, n]);
  else if (n <= 65535) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  socket.write(Buffer.concat([head, data]));
}
function event(method, params) { for (const c of clients) wire(c, { method, params }); }
function complete(status = 'completed') {
  clearTimeout(timer); timer = null; approval = false;
  if (history.length) history[history.length - 1].status = status;
  if (status === 'completed') {
    for (const match of task.matchAll(/^MAKE ([\w.-]+) ([^\n]+)$/gm)) {
      fs.writeFileSync(match[1], match[2] + '\n'); cp.execFileSync('git', ['add', '--', match[1]]);
      if (cp.spawnSync('git', ['diff', '--cached', '--quiet']).status) cp.execFileSync('git', ['commit', '-qm', 'chip fixture change']);
    }
  }
  event('item/completed', { threadId: thread, item: { type: 'agentMessage', text: 'Finished: ' + task } });
  event('turn/completed', { threadId: thread, turn: { id: turn, status, error: null } });
}
function handle(socket, msg) {
  const p = msg.params || {}; let result = {};
  if (msg.method === 'initialized') return;
  if (msg.method === 'initialize') result = { userAgent: 'fake' };
  else if (['thread/start', 'thread/resume'].includes(msg.method)) {
    if (msg.method === 'thread/resume' && p.threadId !== thread) return wire(socket, { id: msg.id, error: { message: 'Thread not found' } });
    if (p.sandbox && !['workspace-write', 'read-only'].includes(p.sandbox)) return wire(socket, { id: msg.id, error: { message: 'Invalid sandbox mode' } });
    result = { thread: { id: thread, cwd: process.cwd(), turns: history, status: timer || approval ? { type: 'active', activeFlags: approval ? ['waitingOnApproval'] : [] } : { type: 'idle' } }, model: 'fake', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } };
  } else if (msg.method === 'turn/start') {
    if (timer || approval) return wire(socket, { id: msg.id, error: { message: 'Turn already active' } });
    turn = 'turn-' + ++number; task = p.input[0].text; if (task.includes('CRASH')) process.exit(7);
    history.push({ id: turn, status: 'inProgress', items: [] });
    event('turn/started', { threadId: thread, turn: { id: turn } }); result = { turn: { id: turn, status: 'inProgress' } };
    if (task.startsWith('[하위칩 완료 알림]')) timer = setTimeout(complete, 250);
    else if (task.includes('APPROVE')) { approval = true; wire(socket, { id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: thread, turnId: turn, command: 'fixture only' } }); }
    else if (task.includes('FAST')) complete();
    else timer = setTimeout(complete, task.includes('HOLD') ? 30000 : task.includes('SLOW') ? 2000 : 250);
  } else if (msg.method === 'turn/steer') {
    if (!timer || p.expectedTurnId !== turn) return wire(socket, { id: msg.id, error: { message: 'No matching active turn' } });
    task += '\n' + p.input[0].text; clearTimeout(timer); timer = setTimeout(complete, 200); result = { turnId: turn };
  } else if (msg.method === 'test/complete') complete();
  else if (msg.method === 'turn/interrupt') complete('interrupted');
  else if (!msg.method && msg.id === 900) { complete(msg.result.decision === 'accept' ? 'completed' : 'failed'); return; }
  else return wire(socket, { id: msg.id, error: { message: 'Unknown method' } });
  wire(socket, { id: msg.id, result });
}
const server = net.createServer(socket => {
  let data = Buffer.alloc(0), upgraded = false; socket.on('error', () => {});
  socket.on('close', () => clients.delete(socket));
  socket.on('data', chunk => {
    data = Buffer.concat([data, chunk]);
    if (!upgraded) {
      const end = data.indexOf('\r\n\r\n'); if (end < 0) return;
      const key = data.subarray(0, end).toString().match(/Sec-WebSocket-Key:\s*(.+)/i)[1].trim();
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      data = data.subarray(end + 4); upgraded = true; clients.add(socket);
    }
    while (data.length >= 2) {
      const opcode = data[0] & 15; if (!(data[1] & 128)) throw new Error('Client must mask');
      let n = data[1] & 127, offset = 2;
      if (n === 126) { if (data.length < 4) return; n = data.readUInt16BE(2); offset = 4; }
      if (n === 127) { if (data.length < 10) return; n = Number(data.readBigUInt64BE(2)); offset = 10; }
      if (data.length < offset + 4 + n) return;
      const mask = data.subarray(offset, offset + 4); const body = Buffer.from(data.subarray(offset + 4, offset + 4 + n));
      data = data.subarray(offset + 4 + n); for (let i = 0; i < n; i++) body[i] ^= mask[i % 4];
      if (opcode === 8) return socket.end(); if (opcode !== 1) continue; handle(socket, JSON.parse(body.toString()));
    }
  });
});
server.listen(address.slice(7));
process.on('SIGTERM', () => { for (const c of clients) c.destroy(); server.close(() => process.exit(0)); });
