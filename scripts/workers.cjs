#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { UnixWebSocket, MAX } = require('./unix-ws.cjs');
const { Notifications, records: notificationRecords } = require('./notifications.cjs');

const VERSION = '0.4.1';
const ACTIVE = new Set(['starting', 'running', 'waiting_for_input']);
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'disconnected', 'stopped']);
const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
const SCRIPTS = __dirname;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function timed(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const stateOf = folder => read(path.join(folder, 'state.json'));
const quote = value => "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
const shell = argv => argv.map(quote).join(' ');
function output(value) { console.log(JSON.stringify(value, null, 2)); }
function atomic(p, data) {
  const temp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temp, p);
}
function git(repo, args, check = true) {
  const p = cp.spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 8 * MAX });
  if (p.error) throw p.error;
  if (check && p.status !== 0) throw new Error((p.stderr || p.stdout).trim());
  return p;
}
function repository(repo) {
  const root = fs.realpathSync(git(path.resolve(repo), ['rev-parse', '--show-toplevel']).stdout.trim());
  const common = git(root, ['rev-parse', '--git-common-dir']).stdout.trim();
  const base = path.join(fs.realpathSync(path.resolve(root, common)), 'parallel-worktrees');
  return { root, base };
}
function id(value) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value || '')) throw new Error('Chip ID: 1-64 lowercase letters, digits or hyphens');
  return value;
}
function inventory(base) {
  return fs.readdirSync(base).sort().filter(n => fs.existsSync(path.join(base, n, 'state.json')))
    .map(n => stateOf(path.join(base, n)));
}
function descendants(states, ident) {
  const found = []; const seen = new Set([ident]); let frontier = [ident];
  while (frontier.length) {
    const next = states.filter(s => frontier.includes(s.parent_id) && !seen.has(s.id));
    for (const s of next) { seen.add(s.id); found.push(s); }
    frontier = next.map(s => s.id);
  }
  return found;
}
function clean(repo) {
  if (git(repo, ['status', '--porcelain', '--untracked-files=all']).stdout.trim()) throw new Error('Uncommitted or untracked changes exist: ' + repo);
}
function validateTree(state) {
  const tree = fs.realpathSync(state.worktree);
  if (tree === fs.realpathSync(state.repo)) throw new Error('Each chip must have a separate Git worktree');
  if (fs.realpathSync(git(tree, ['rev-parse', '--show-toplevel']).stdout.trim()) !== tree || !fs.statSync(path.join(tree, '.git')).isFile()) throw new Error('Chip path is not its own registered Git worktree');
  if (git(tree, ['symbolic-ref', '--short', 'HEAD']).stdout.trim() !== state.branch) throw new Error('Chip branch changed unexpectedly');
}
function executable(value) {
  const candidates = value.includes('/') ? [path.resolve(value)] : (process.env.PATH || '').split(path.delimiter).map(p => path.resolve(p, value));
  for (const p of candidates) { try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {} }
  throw new Error('Existing Codex executable not found: ' + value);
}
function socketPath(folder, server = false) {
  const parent = path.join(os.tmpdir(), 'pw-' + process.getuid());
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(parent);
  if (st.isSymbolicLink() || st.uid !== process.getuid()) throw new Error('Unsafe runtime directory');
  fs.chmodSync(parent, 0o700);
  const digest = crypto.createHash('sha256').update(path.resolve(folder, ...(server ? ['app-server'] : []))).digest('hex').slice(0, 24);
  return path.join(parent, digest + '.sock');
}
function control(folder, request, timeout = 40000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath(folder)); socket.setEncoding('utf8'); let data = ''; let done = false;
    const end = (error, result) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => end(new Error('Controller timeout; inspect status before retrying input')), timeout);
    socket.on('error', error => end(error));
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      data += chunk.toString(); if (Buffer.byteLength(data) > MAX) return end(new Error('Controller response exceeds size limit'));
      if (!data.includes('\n')) return;
      try { const value = JSON.parse(data.slice(0, data.indexOf('\n'))); end(value.error ? new Error(value.error) : null, value.result); } catch (e) { end(e); }
    });
    socket.on('close', () => end(new Error('Controller disconnected; inspect status before retrying input')));
  });
}
async function snapshot(folder) {
  const state = stateOf(folder);
  try { return await control(folder, { op: 'status' }, 2000); }
  catch { return ACTIVE.has(state.status) ? { ...state, status: 'disconnected', error: 'Controller unavailable; worktree preserved' } : state; }
}
async function lock(folder, callback, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (true) {
    try { fs.mkdirSync(folder, { mode: 0o700 }); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (Date.now() >= deadline) throw new Error('Operation lock is busy; inspect ' + folder + ' before retrying'); await sleep(50); }
  }
  fs.writeFileSync(path.join(folder, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  try { return await callback(); } finally { fs.rmSync(folder, { recursive: true }); }
}
async function terminate(proc) {
  if (!proc || !proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise(resolve => proc.once('exit', resolve)); proc.kill('SIGTERM');
  const timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
  await exited; clearTimeout(timer);
}
async function openServer(codex, cwd, address, stderr) {
  if (fs.existsSync(address)) throw new Error('App-server socket already exists; inspect the chip');
  const proc = cp.spawn(codex, ['app-server', '--listen', 'unix://' + address], { cwd, stdio: ['ignore', 'ignore', stderr] });
  let spawnError; proc.on('error', e => { spawnError = e; });
  try {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(address)) {
      if (spawnError) throw spawnError;
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error('App-server exited before opening its Unix socket');
      if (Date.now() >= deadline) throw new Error('App-server socket startup timed out'); await sleep(50);
    }
    fs.chmodSync(address, 0o600);
    return { proc, ws: await UnixWebSocket.connect(address) };
  } catch (e) { await terminate(proc); fs.rmSync(address, { force: true }); throw e; }
}
function terminalArgs(state) {
  if (!state.server_socket || !state.thread_id) throw new Error('Chip has no attachable session');
  return [state.codex, 'resume', '--remote', 'unix://' + state.server_socket, '--cd', state.worktree, state.thread_id];
}
function remoteInfo(state) {
  const attach = shell(['sh', path.join(SCRIPTS, 'attach.sh'), state.id, '--repo', state.root_repo || state.repo]);
  return { chip: state.id, parent: state.parent_id || null, session_id: state.thread_id,
    worktree: state.worktree, remote: state.server_socket ? 'unix://' + state.server_socket : null,
    status: state.status, attach_command: attach,
    terminal_command: state.thread_id && state.server_socket ? shell(terminalArgs(state)) : null };
}
class Chip {
  constructor(folder) {
    this.folder = folder; this.state = stateOf(folder); this.pending = new Map(); this.counter = 0;
    this.chain = Promise.resolve(); this.ready = false; this.stopping = false;
    this.notifications = new Notifications(this, control);
    this.stopped = new Promise(resolve => { this.finish = resolve; });
  }
  save() { this.state.updated_at = Date.now() / 1000; atomic(path.join(this.folder, 'state.json'), this.state); }
  record(message) { fs.appendFileSync(path.join(this.folder, 'events.jsonl'), JSON.stringify({ time: Date.now() / 1000, ...message }) + '\n', { mode: 0o600 }); }
  async rpc(method, params) {
    const ident = ++this.counter;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(ident); reject(new Error(method + ' timed out; input acceptance may be ambiguous')); }, 30000);
      this.pending.set(ident, { resolve, reject, timer });
    });
    try { await this.ws.send({ id: ident, method, params }); return await response; }
    catch (e) { const p = this.pending.get(ident); if (p) { clearTimeout(p.timer); this.pending.delete(ident); } throw e; }
  }
  event(msg) {
    const source = msg.params?.threadId || msg.params?.thread?.id;
    if (source && this.state.thread_id && source !== this.state.thread_id) return;
    this.record(msg); const p = msg.params || {};
    if (msg.method === 'turn/started') { Object.assign(this.state, { turn_id: p.turn.id, status: 'running', error: null, last_message: '', pending_requests: [] }); delete this.state.completed_at; }
    else if (msg.method === 'turn/completed') Object.assign(this.state, { turn_id: p.turn.id, status: p.turn.status, error: p.turn.error, pending_requests: [], completed_at: Date.now() / 1000 });
    else if (msg.method === 'item/agentMessage/delta') fs.appendFileSync(path.join(this.folder, 'messages.log'), p.delta || '', { mode: 0o600 });
    else if (msg.method === 'item/completed' && p.item?.type === 'agentMessage') this.state.last_message = p.item.text || '';
    else if (msg.method === 'error') this.state.last_error = p;
    else if (msg.method === 'serverRequest/resolved') {
      this.state.pending_requests = this.state.pending_requests.filter(r => r.id !== p.requestId);
      if (!this.state.pending_requests.length && this.state.status === 'waiting_for_input') this.state.status = 'running';
    }
    this.save();
    if (msg.method === 'turn/completed') this.notifications.completed(p.turn);
    if (['turn/started', 'turn/completed', 'serverRequest/resolved'].includes(msg.method)) this.notifications.schedule();
  }
  async readLoop() {
    try {
      while (true) {
        const msg = await this.ws.receive();
        if (msg.method && Object.hasOwn(msg, 'id')) {
          if (msg.params?.threadId && msg.params.threadId !== this.state.thread_id) continue;
          this.state.pending_requests.push(msg); this.state.status = 'waiting_for_input'; this.record(msg); this.save();
        } else if (Object.hasOwn(msg, 'id')) {
          const p = this.pending.get(msg.id);
          if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); if (msg.error) { const e = new Error(JSON.stringify(msg.error)); e.rpcError = msg.error; p.reject(e); } else p.resolve(msg.result); }
        } else this.event(msg);
      }
    } catch (e) {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); } this.pending.clear();
      if (!this.stopping && ACTIVE.has(this.state.status)) {
        Object.assign(this.state, { status: 'disconnected', error: e.message });
        this.notifications.completed({ id: this.state.turn_id || 'startup', status: 'failed', error: { message: e.message } });
      }
      this.save(); this.finish();
    }
  }
  async begin(text) {
    Object.assign(this.state, { status: 'starting', pending_requests: [], last_message: '', error: null }); this.save();
    const result = await this.rpc('turn/start', { threadId: this.state.thread_id, input: [{ type: 'text', text }] });
    if (this.state.turn_id !== result.turn.id) Object.assign(this.state, { turn_id: result.turn.id, status: 'running' });
    this.save(); return { action: 'started', thread_id: this.state.thread_id, turn_id: result.turn.id };
  }
  dispatch(req) {
    if (req.op === 'status') return Promise.resolve(this.state);
    if (req.op === 'child-completed') {
      if (this.stopping) return Promise.reject(new Error('Parent is stopping; completion remains in child outbox'));
      try { return Promise.resolve(this.notifications.accept(req.event)); } catch (e) { return Promise.reject(e); }
    }
    const task = this.chain.then(() => this.mutate(req)); this.chain = task.catch(() => {}); return task;
  }
  async mutate(req) {
    if (!this.ready || this.stopping) throw new Error('Chip is initializing or stopping');
    if (req.op === 'retry-notifications') {
      let retried = 0;
      for (const row of notificationRecords(this.folder, 'outbox').filter(r => r.state === 'failed' && r.target)) {
        row.attempts = 0; this.notifications.delivery = this.notifications.delivery.then(() => this.notifications.send(row)); retried++;
      }
      for (const row of notificationRecords(this.folder, 'inbox').filter(r => r.state === 'failed')) { row.state = 'queued'; require('./notifications.cjs').save(this.notifications.inPath(row.event.event_id), row); retried++; }
      this.notifications.schedule(); return { action: 'retry-scheduled', retried, ambiguous_replayed: false };
    }
    if (req.op === 'disconnect' && this.state.external_parent) { this.stopping = true; setTimeout(this.finish, 20); return { action: 'disconnected', parent_untouched: true }; }
    if (req.op === 'message') {
      if (['running', 'waiting_for_input'].includes(this.state.status)) return { action: 'steered', ...await this.rpc('turn/steer', {
        threadId: this.state.thread_id, expectedTurnId: this.state.turn_id, input: [{ type: 'text', text: req.text }] }) };
      return this.begin(req.text);
    }
    if (req.op === 'respond') {
      const p = this.state.pending_requests.find(r => String(r.id) === String(req.request_id));
      if (!p) throw new Error('Pending request not found');
      if (APPROVALS.has(p.method) !== Object.hasOwn(req, 'decision')) throw new Error('Use --decision for command/file approvals, --json-file for other explicit answers');
      await this.ws.send({ id: p.id, result: Object.hasOwn(req, 'decision') ? { decision: req.decision } : req.result });
      this.state.pending_requests = this.state.pending_requests.filter(r => r !== p);
      if (!this.state.pending_requests.length) this.state.status = 'running'; this.save(); this.notifications.schedule(); return { action: 'responded', request_id: p.id };
    }
    if (req.op === 'stop') {
      this.state.suppress_notifications = true; this.save();
      if (ACTIVE.has(this.state.status) && this.state.turn_id) {
        await this.rpc('turn/interrupt', { threadId: this.state.thread_id, turnId: this.state.turn_id });
        const deadline = Date.now() + 10000;
        while (ACTIVE.has(this.state.status) && Date.now() < deadline) await sleep(50);
        if (ACTIVE.has(this.state.status)) throw new Error('Interrupt unconfirmed; controller kept alive');
      }
      await this.notifications.delivery;
      this.stopping = true; setTimeout(this.finish, 20); return { action: 'stopped' };
    }
    throw new Error('Unknown controller operation');
  }
  async run() {
    const address = socketPath(this.folder); const serverAddress = socketPath(this.folder, true);
    this.server = net.createServer(socket => {
      socket.setEncoding('utf8');
      let data = '', answered = false; socket.setTimeout(5000, () => socket.destroy()); socket.on('error', () => {});
      socket.on('data', async chunk => {
        if (answered) return; data += chunk.toString(); if (Buffer.byteLength(data) > MAX) return socket.destroy();
        if (!data.includes('\n')) return; answered = true; socket.setTimeout(0);
        try { socket.end(JSON.stringify({ result: await this.dispatch(JSON.parse(data.slice(0, data.indexOf('\n')))) }) + '\n'); }
        catch (e) { socket.end(JSON.stringify({ error: e.message }) + '\n'); }
      });
    });
    try {
      if (!this.state.external_parent) validateTree(this.state);
      await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(address, resolve); }); fs.chmodSync(address, 0o600);
      this.state.controller_pid = process.pid; this.state.status = 'starting'; this.state.pending_requests = []; this.save();
      this.log = fs.openSync(path.join(this.folder, 'app-server.stderr.log'), 'a', 0o600);
      if (this.state.external_parent) this.ws = await UnixWebSocket.connect(this.state.server_socket);
      else {
        const opened = await openServer(this.state.codex, this.state.worktree, serverAddress, this.log); this.proc = opened.proc; this.ws = opened.ws;
        Object.assign(this.state, { app_server_pid: this.proc.pid, server_socket: serverAddress, transport: 'unix-websocket' });
      }
      this.reader = this.readLoop();
      this.state.server_info = await this.rpc('initialize', { clientInfo: { name: 'parallel_worktrees', title: '하위칩', version: VERSION } });
      await this.ws.send({ method: 'initialized', params: {} });
      const params = { cwd: this.state.worktree };
      if (this.state.model) params.model = this.state.model;
      if (this.state.sandbox) params.sandbox = this.state.sandbox;
      let result;
      if (this.state.external_parent) result = await this.rpc('thread/resume', { threadId: this.state.thread_id });
      else result = await this.rpc('thread/start', params);
      if (this.state.external_parent && result.thread.id !== this.state.thread_id) throw new Error('Parent resume returned a different session');
      this.state.thread_id = result.thread.id;
      if (this.state.external_parent && result.thread.cwd) this.state.worktree = result.thread.cwd;
      if (!this.state.external_parent && result.thread.cwd && fs.realpathSync(result.thread.cwd) !== fs.realpathSync(this.state.worktree)) throw new Error('Session cwd does not match mandatory Worktree');
      this.state.effective_policy = Object.fromEntries(['approvalPolicy', 'approvalsReviewer', 'sandbox', 'model'].filter(k => Object.hasOwn(result, k)).map(k => [k, result[k]]));
      this.state.terminal_command = shell(terminalArgs(this.state)); this.state.attach_command = this.state.external_parent ? this.state.terminal_command : remoteInfo(this.state).attach_command;
      this.ready = true;
      if (this.state.external_parent) {
        const active = [...(result.thread.turns || [])].reverse().find(t => t.status === 'inProgress');
        const status = result.thread.status;
        this.state.turn_id = active?.id || null;
        this.state.status = status?.type === 'active' ? status.activeFlags?.length ? 'waiting_for_input' : 'running' : 'completed';
        this.save(); this.notifications.schedule();
      } else await this.begin(this.state.prompt);
      await this.stopped;
    } catch (e) {
      Object.assign(this.state, { status: 'failed', error: e.message }); this.save();
      this.notifications.completed({ id: this.state.turn_id || 'startup', status: 'failed', error: { message: e.message } });
    }
    finally {
      this.stopping = true; await this.notifications.delivery; if (this.ws) this.ws.close(); await terminate(this.proc); if (this.reader) await this.reader;
      if (this.server.listening) await new Promise(resolve => this.server.close(resolve));
      if (this.log !== undefined) fs.closeSync(this.log);
      if (ACTIVE.has(this.state.status)) this.state.status = 'stopped'; this.save();
      fs.rmSync(address, { force: true }); fs.rmSync(serverAddress, { force: true });
    }
  }
}
async function launch(folder, bridge = false) {
  const log = fs.openSync(path.join(folder, 'controller.log'), 'a', 0o600);
  const proc = cp.spawn(process.execPath, [__filename, bridge ? '_bridge' : '_daemon', folder], { stdio: ['ignore', log, log], detached: true }); fs.closeSync(log); proc.unref();
  let spawnError; proc.on('error', e => { spawnError = e; });
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    try { const s = await control(folder, { op: 'status' }, 1000); if (s.status === 'failed') throw new Error(s.error); if (s.status !== 'starting') return s; }
    catch (e) { if (stateOf(folder).status === 'failed') throw new Error(stateOf(folder).error || e.message); }
    if (spawnError) throw spawnError;
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(stateOf(folder).error || 'Controller exited; inspect controller.log');
    await sleep(100);
  }
  throw new Error('Startup timeout; chip may still be starting. Inspect status before retrying');
}
function parse(argv) {
  const command = argv.shift(); const options = { repo: '.', ids: [] };
  const flags = new Set(['probe', 'print', 'json', 'help']);
  const values = new Set(['repo', 'codex', 'model', 'sandbox', 'prompt', 'prompt-file', 'timeout', 'interval', 'decision', 'json-file', 'parent', 'remote', 'session', 'notify']);
  while (argv.length) {
    const a = argv.shift();
    if (!a.startsWith('--')) { options.ids.push(a); continue; }
    const name = a.slice(2);
    if (flags.has(name)) options[name] = true;
    else if (values.has(name) && argv.length) options[name] = argv.shift();
    else throw new Error('Unknown or incomplete option: ' + a);
  }
  return { command, options };
}
function promptText(o) {
  if (!!o.prompt === !!o['prompt-file']) throw new Error('Provide exactly one of --prompt or --prompt-file');
  const text = o['prompt-file'] ? fs.readFileSync(o['prompt-file'], 'utf8') : o.prompt;
  if (!text.trim()) throw new Error('Prompt must not be empty'); return text;
}
function mode(value) {
  const normalized = { workspaceWrite: 'workspace-write', readOnly: 'read-only' }[value] || value;
  if (normalized && !['workspace-write', 'read-only'].includes(normalized)) throw new Error('Sandbox mode must be workspace-write or read-only'); return normalized || null;
}
async function doctor(codex, root, base, probe) {
  const out = { node: process.versions.node, codex, version: cp.execFileSync(codex, ['--version'], { encoding: 'utf8' }).trim(), repo: root, state_dir: base };
  if (probe) {
    const address = socketPath(path.join(base, 'probe-' + crypto.randomBytes(6).toString('hex')), true);
    const { proc, ws } = await openServer(codex, root, address, 'ignore');
    try {
      await ws.send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'parallel_worktrees', version: VERSION } } });
      const response = await timed(ws.receive(), 15000, 'Initialize timeout');
      if (response.error) throw new Error(JSON.stringify(response.error));
      await ws.send({ method: 'initialized', params: {} }); Object.assign(out, { initialize: 'ok', transport: 'unix-websocket', server_info: response.result });
    } finally { ws.close(); await terminate(proc); fs.rmSync(address, { force: true }); }
  }
  return out;
}
async function main(argv = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Node.js 18+ is required');
  if (process.platform === 'win32') throw new Error('This version requires macOS/Linux Unix sockets');
  const { command, options: o } = parse([...argv]);
  if (command === '_daemon' || command === '_bridge') {
    process.umask(0o077); const folder = o.ids[0];
    await lock(path.join(folder, 'daemon.lockdir'), () => new Chip(folder).run(), 0); return 0;
  }
  const commands = ['doctor', 'start', 'status', 'list', 'remote', 'attach', 'watch', 'message', 'wait', 'respond', 'stop', 'merge', 'cleanup', 'bind-parent', 'unbind-parent', 'notifications', 'notify-retry'];
  if (o.help || !command) { console.log('하위칩 / Parallel Worktrees ' + VERSION + '\nCommands: ' + commands.join(', ') + '\nUse --repo REPO; start/message need --prompt or --prompt-file. See references/commands.md.'); return 0; }
  if (!commands.includes(command)) throw new Error('Unknown command: ' + command);
  let { root, base } = repository(o.repo); fs.mkdirSync(base, { recursive: true, mode: 0o700 }); fs.chmodSync(base, 0o700);
  if (command === 'doctor') { output(await doctor(executable(o.codex || 'codex'), root, base, o.probe)); return 0; }
  if (command === 'bind-parent') {
    const bindingPath = path.join(base, 'root-parent.json');
    if (!o.remote && !o.session) { const binding = read(bindingPath); output({ ...binding, state: await snapshot(binding.folder) }); return 0; }
    if (!o.remote?.startsWith('unix:///') || !o.session) throw new Error('Provide --remote unix:///ABSOLUTE_SOCKET and --session SESSION_ID');
    const endpoint = o.remote.slice(7), st = fs.statSync(endpoint);
    if (!st.isSocket() || st.uid !== process.getuid()) throw new Error('Parent endpoint must be a local Unix socket owned by this user');
    if (fs.existsSync(bindingPath)) throw new Error('A root parent is already registered; inspect or unbind it first');
    const folder = path.join(base, '.links', 'root-' + crypto.randomBytes(6).toString('hex')); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const state = { id: '$root', external_parent: true, registry_base: base, root_repo: root, repo: root, worktree: root,
      codex: executable(o.codex || 'codex'), thread_id: o.session, server_socket: endpoint,
      status: 'starting', pending_requests: [], notify_enabled: false, created_at: Date.now() / 1000 };
    atomic(path.join(folder, 'state.json'), state); const attached = await launch(folder, true);
    const binding = { folder, remote: o.remote, session_id: attached.thread_id, registered_at: Date.now() / 1000 };
    atomic(bindingPath, binding); output({ ...binding, action: 'parent-registered', current_parent_turn_unchanged: true }); return 0;
  }
  if (command === 'unbind-parent') {
    const file = path.join(base, 'root-parent.json'), binding = read(file);
    try { await control(binding.folder, { op: 'disconnect' }); } catch (e) { if (!['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e; }
    fs.unlinkSync(file); output({ action: 'parent-unregistered', parent_untouched: true }); return 0;
  }
  if (command === 'notifications') {
    const folders = o.ids.length ? o.ids.map(i => path.join(base, id(i))) : inventory(base).map(s => path.join(base, s.id));
    const binding = path.join(base, 'root-parent.json'); if (!o.ids.length && fs.existsSync(binding)) folders.push(read(binding).folder);
    output(folders.map(folder => ({ chip: stateOf(folder).id, outbox: notificationRecords(folder, 'outbox'), inbox: notificationRecords(folder, 'inbox') }))); return 0;
  }
  if (command === 'notify-retry' && o.ids[0] === '$root') {
    output(await control(read(path.join(base, 'root-parent.json')).folder, { op: 'retry-notifications' })); return 0;
  }
  if (['status', 'list', 'wait'].includes(command)) {
    let states = inventory(base); let chosen = o.ids.length ? o.ids.map(i => id(i)) : states.map(s => s.id);
    if (command === 'wait') chosen = [...new Set(chosen.flatMap(i => [i, ...descendants(states, i).map(s => s.id)]))];
    const timeout = Number(o.timeout ?? 30); if (!Number.isFinite(timeout) || timeout < 0) throw new Error('Invalid timeout'); const deadline = Date.now() + timeout * 1000;
    while (true) {
      const rows = await Promise.all(chosen.map(i => snapshot(path.join(base, i))));
      if (command === 'list') {
        const ids = new Set(rows.map(s => s.id));
        const printTree = (s, prefix = '') => { console.log(prefix + s.id + ' [' + s.status + ']  session=' + (s.thread_id || '-')); console.log(prefix + '  Worktree: ' + s.worktree); console.log(prefix + '  열기: ' + remoteInfo(s).attach_command); for (const child of rows.filter(c => c.parent_id === s.id)) printTree(child, prefix + '  '); };
        if (o.json) output(rows.map(remoteInfo)); else if (!rows.length) console.log('하위칩이 없습니다.'); else for (const s of rows.filter(s => !s.parent_id || !ids.has(s.parent_id))) printTree(s); return 0;
      }
      if (command === 'status') { output(rows); return 0; }
      const attention = rows.some(s => s.status === 'waiting_for_input'); const done = rows.every(s => TERMINAL.has(s.status));
      if (attention || done || Date.now() >= deadline) { output(rows); return attention ? 3 : !done ? 2 : rows.every(s => s.status === 'completed') ? 0 : 1; }
      await sleep(200);
    }
  }
  const ident = id(o.ids[0]); const folder = path.join(base, ident);
  if (command === 'start') {
    return lock(path.join(base, 'start.lockdir'), async () => {
      const states = inventory(base); let parent = states.find(s => fs.existsSync(s.worktree) && fs.realpathSync(s.worktree) === root);
      if (o.parent) { parent = states.find(s => s.id === id(o.parent)); if (!parent) throw new Error('Parent chip not found'); root = fs.realpathSync(parent.worktree); }
      if (parent) validateTree(parent); clean(root);
      const codex = executable(o.codex || parent?.codex || 'codex'); const task = promptText(o); const sandbox = mode(o.sandbox || parent?.sandbox);
      if (o.notify && !['on', 'off'].includes(o.notify)) throw new Error('--notify must be on or off');
      const notifyEnabled = o.notify ? o.notify === 'on' : parent?.notify_enabled !== false;
      const rootBinding = path.join(base, 'root-parent.json');
      const notifyTarget = parent ? { kind: 'chip', folder: path.join(base, parent.id) } : fs.existsSync(rootBinding) ? { kind: 'external', folder: read(rootBinding).folder } : null;
      fs.mkdirSync(folder, { mode: 0o700 }); const tree = path.join(folder, 'worktree'); const branch = 'pw/' + ident + '-' + crypto.randomBytes(3).toString('hex');
      const state = { schema_version: 4, id: ident, parent_id: parent?.id || null, depth: (parent?.depth || 0) + 1,
        notify_enabled: notifyEnabled, notify_target: notifyTarget,
        root_repo: parent?.root_repo || parent?.repo || root, repo: root, worktree: tree, branch,
        base_commit: git(root, ['rev-parse', 'HEAD']).stdout.trim(), codex, model: o.model || parent?.model || null,
        sandbox, status: 'starting', pending_requests: [], created_at: Date.now() / 1000,
        thread_id: null, turn_id: null };
      state.prompt = 'You are 하위칩 ' + ident + ', an independent Codex session in its own Git worktree. '
        + 'Perform only your assigned task; do not push or change security/Codex configuration. '
        + 'You may create further 하위칩 for concrete independent subtasks using the bundled start.sh; each gets a separate worktree/session. '
        + 'Do not delegate an unchanged task recursively. Use globally unique chip IDs. '
        + 'Your worktree must be clean and committed before starting a child. Children inherit your committed HEAD, not your conversation or uncommitted files. '
        + 'Collect children, review and merge each child into YOUR worktree, then clean children before reporting completion. '
        + 'Use the helpers; do not run workers in a shared directory. No automatic approvals. Commit only assigned files and report checks.\n'
        + (notifyEnabled ? 'Child completion notifications are queued durably while you are busy and delivered in a separate turn when idle. Report the chip ID, completion/failure and result to the user. Notification receipt alone does not request replies to children, new work or merging. Do not duplicate already reported event IDs.\n' : 'Automatic completion notifications are disabled; use status/wait to collect child results.\n')
        + 'Scripts: ' + SCRIPTS + '\nYour ID: ' + ident + '\nCreate child: sh ' + quote(path.join(SCRIPTS, 'start.sh'))
        + ' UNIQUE_CHILD_ID --repo ' + quote(tree) + ' --prompt-file /absolute/task.txt\n'
        + 'Inspect: sh ' + quote(path.join(SCRIPTS, 'list.sh')) + ' --repo ' + quote(state.root_repo) + '\n\n' + task;
      atomic(path.join(folder, 'state.json'), state);
      try { git(root, ['worktree', 'add', '-b', branch, tree, state.base_commit]); output(await launch(folder)); }
      catch (e) { if (!fs.existsSync(path.join(folder, 'daemon.lockdir'))) atomic(path.join(folder, 'state.json'), { ...stateOf(folder), status: 'failed', error: e.message }); throw e; }
      return 0;
    });
  }
  if (command === 'remote') {
    const info = remoteInfo(await snapshot(folder));
    if (o.json) output(info);
    else console.log('하위칩: ' + info.chip + (info.parent ? ' (부모: ' + info.parent + ')' : '') + '\n세션 ID: ' + info.session_id + '\n리모트 주소: ' + info.remote + '\nWorktree: ' + info.worktree + '\n바로 열기:\n' + info.attach_command + '\n직접 접속:\n' + info.terminal_command);
    return 0;
  }
  if (command === 'attach') {
    const state = await control(folder, { op: 'status' }); validateTree(state); const args = terminalArgs(state);
    if (!fs.existsSync(state.server_socket)) throw new Error('Chip server is not running');
    if (o.print) { console.log(shell(args)); return 0; }
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run attach.sh in an interactive terminal; use --print or watch.sh');
    const child = cp.spawn(args[0], args.slice(1), { cwd: state.worktree, stdio: 'inherit' });
    const ignore = () => {}; const stop = () => child.kill('SIGTERM'); process.on('SIGINT', ignore); process.on('SIGTERM', stop);
    return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => { process.removeListener('SIGINT', ignore); process.removeListener('SIGTERM', stop); resolve(code ?? 1); }); });
  }
  if (command === 'watch') {
    const interval = Number(o.interval ?? 0.5), timeout = Number(o.timeout ?? 0);
    if (!(interval > 0) || !(timeout >= 0)) throw new Error('Invalid watch interval/timeout');
    const s = await snapshot(folder); console.log('하위칩: ' + s.id + '\nSession: ' + s.thread_id + '\nWorktree: ' + s.worktree);
    let previous, offset = 0, last, done = false; const stop = () => { done = true; }; process.on('SIGINT', stop);
    const deadline = timeout ? Date.now() + timeout * 1000 : Infinity;
    try {
      while (!done) {
        const current = await snapshot(folder); if (current.status !== previous) { console.log('\n[' + current.status + ']'); previous = current.status; }
        const log = path.join(folder, 'messages.log'); if (fs.existsSync(log)) { const data = fs.readFileSync(log); if (data.length > offset) { process.stdout.write(data.subarray(offset)); offset = data.length; } }
        if (TERMINAL.has(current.status) && current.last_message !== last) { last = current.last_message; if (last) console.log('\n' + last); }
        if (Date.now() >= deadline) return 0; await sleep(interval * 1000);
      }
    } finally { process.removeListener('SIGINT', stop); } return 0;
  }
  if (command === 'message') { output(await control(folder, { op: 'message', text: promptText(o) })); return 0; }
  if (command === 'notify-retry') { output(await control(folder, { op: 'retry-notifications' })); return 0; }
  if (command === 'respond') {
    if (!!o.decision === !!o['json-file']) throw new Error('Provide --decision or --json-file');
    if (o.decision && !['accept', 'decline', 'cancel'].includes(o.decision)) throw new Error('Invalid approval decision');
    const req = { op: 'respond', request_id: o.ids[1] }; if (o.decision) req.decision = o.decision; else req.result = read(o['json-file']);
    output(await control(folder, req)); return 0;
  }
  if (command === 'stop') {
    const children = descendants(inventory(base), ident); const states = await Promise.all(children.map(s => snapshot(path.join(base, s.id))));
    if (states.some(s => ACTIVE.has(s.status) || s.status === 'disconnected')) throw new Error('Stop active descendant chips first: ' + states.filter(s => ACTIVE.has(s.status) || s.status === 'disconnected').map(s => s.id).join(', '));
    output(await control(folder, { op: 'stop' })); return 0;
  }
  if (command === 'merge' || command === 'cleanup') {
    return lock(path.join(base, 'integration.lockdir'), async () => {
      const s = await snapshot(folder);
      const children = descendants(inventory(base), ident).filter(c => fs.existsSync(c.worktree));
      if (children.length) throw new Error('Integrate/clean descendants first: ' + children.map(c => c.id).join(', '));
      if (ACTIVE.has(s.status) || s.status === 'disconnected') throw new Error('Chip active/disconnected; resolve or stop it before integration');
      if (command === 'merge' && s.status !== 'completed') throw new Error('Only completed chips can be merged');
      const target = s.repo; if (repository(target).base !== base) throw new Error('Integration target belongs to a different repository');
      if (s.parent_id) { const parent = stateOf(path.join(base, s.parent_id)); validateTree(parent); if (fs.realpathSync(parent.worktree) !== fs.realpathSync(target)) throw new Error('Child must integrate into its immediate parent'); }
      try { await control(folder, { op: 'stop' }); } catch (e) { if (!['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e; }
      const deadline = Date.now() + 7000;
      while (fs.existsSync(path.join(folder, 'daemon.lockdir'))) { if (Date.now() >= deadline) throw new Error('Controller has not released its worktree'); await sleep(50); }
      clean(target); validateTree(s); clean(s.worktree);
      const commit = git(s.worktree, ['rev-parse', 'HEAD']).stdout.trim(); let result;
      if (command === 'merge') {
        if (commit === s.base_commit) throw new Error('Chip produced no commits');
        git(target, ['merge', '--no-edit', '--', s.branch]); result = { action: 'merged', chip: s.id, target, branch: s.branch, commit };
      } else {
        if (git(target, ['merge-base', '--is-ancestor', commit, 'HEAD'], false).status !== 0) throw new Error('Chip has unmerged commits; preserve its worktree');
        git(target, ['worktree', 'remove', '--', s.worktree]); result = { action: 'cleaned', branch_preserved: s.branch };
      }
      atomic(path.join(folder, 'state.json'), { ...stateOf(folder), last_git_action: result }); output(result); return 0;
    });
  }
  throw new Error('Unsupported command');
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(e => { console.error('error: ' + e.message); process.exitCode = 1; });
module.exports = { main, Chip, repository, descendants, remoteInfo, validateTree, socketPath, control, snapshot, git, quote, mode };
