'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { execute, registry } = require('../scripts/app.cjs');
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-ledger-')), repo = path.join(temp, 'repo with spaces'); fs.mkdirSync(repo);
  const git = args => cp.execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'baseline\n'); git(['add', '.']); git(['commit', '-qm', 'baseline']);
  // Git fixtures only test structural isolation. Actual app-managed creation is
  // validated separately through the official create_worktree tool.
  function tree(name) { const p = path.join(temp, name); git(['worktree', 'add', '--detach', p, 'HEAD']); return fs.realpathSync(p); }
  function run(command, extra = {}) { return execute(command, { repo, ids: [], ...extra }); }
  function register(id, extra = {}) { return run('register', { ids: [id], thread: 'thread-' + id, host: 'local', worktree: tree(id), source: repo,
    'parent-thread': 'main-thread', 'parent-host': 'local', 'authorization-thread': 'human-origin', ...extra }); }
  function complete(id, turn = 'turn-1', summary = id + ' completed') { const f = path.join(temp, 'summary-' + id + '-' + turn + '.txt'); fs.writeFileSync(f, summary); return run('complete', { ids: [id], turn, status: 'completed', 'summary-file': f }); }
  function claim(state = 'idle') { return run('claim', { 'parent-thread': 'main-thread', 'parent-host': 'local', 'parent-state': state }); }
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { temp, repo, git, tree, run, register, complete, claim };
}
test('registers a separate detached worktree and preserves app thread identity', t => {
  const h = fixture(t), row = h.register('one');
  assert.equal(row.mode, 'app-native'); assert.equal(row.thread_id, 'thread-one'); assert.equal(row.parent_thread_id, 'main-thread');
  assert.equal(h.run('status')[0].live_status, 'unknown');
  assert.throws(() => h.run('register', { ids: ['one'] }), /already registered/);
  assert.equal(h.run('remote', { ids: ['one'] })[0].terminal_command, null);
});
test('shared and duplicate worktrees are refused', t => {
  const h = fixture(t); assert.throws(() => h.register('same', { worktree: h.repo }), /separate/);
  const a = h.register('a'); assert.throws(() => h.register('b', { worktree: a.worktree }), /unique/);
  assert.throws(() => h.register('c', { thread: a.thread_id }), /unique/);
});
test('nested chips retain their immediate parent and source', t => {
  const h = fixture(t), p = h.register('parent');
  const child = h.register('child', { parent: 'parent', source: p.worktree, 'parent-thread': p.thread_id });
  assert.equal(child.parent_id, 'parent'); assert.equal(child.parent_thread_id, p.thread_id);
  assert.throws(() => h.register('bad', { parent: 'parent', source: h.repo, 'parent-thread': p.thread_id }), /immediate parent/);
});
test('busy and unknown parents keep a durable FIFO queue; duplicate completion is idempotent', t => {
  const h = fixture(t); h.register('z'); h.register('a');
  const first = h.complete('z'), second = h.complete('a'); assert.equal(h.complete('z').duplicate, true);
  assert.equal(h.claim('busy').action, 'deferred'); assert.equal(h.claim('unknown').queued, 2);
  const rows = h.run('notifications'); assert.deepEqual(rows.map(r => r.event.child_id), ['z', 'a']); assert.ok(rows.every(r => r.state === 'queued'));
  const disk = JSON.parse(fs.readFileSync(path.join(registry(h.repo).folder, 'state.json'))); assert.equal(disk.events.length, 2);
  assert.notEqual(first.event.event_id, second.event.event_id);
});
test('only an idle parent yields a native send request; concurrent claim cannot duplicate it', t => {
  const h = fixture(t); h.register('a'); h.register('b'); h.complete('a'); h.complete('b');
  const claim = h.claim(); assert.equal(claim.tool, 'send_message_to_thread'); assert.equal(claim.arguments.threadId, 'main-thread');
  const payload = JSON.parse(claim.arguments.prompt.split('\n')[1]); assert.deepEqual(payload.events.map(e => e.child_id), ['a', 'b']);
  assert.equal(h.claim().action, 'in-flight');
  const receipt = path.join(h.temp, 'receipt.txt'); fs.writeFileSync(receipt, 'native tool receipt');
  const ack = h.run('ack', { delivery: claim.delivery_id, status: 'accepted', 'receipt-file': receipt });
  assert.equal(ack.user_report_confirmed, false); assert.equal(h.claim().action, 'empty');
});
test('arrivals during a report stay in the next queue and do not replay ambiguous input', t => {
  const h = fixture(t); h.register('one'); h.complete('one'); const first = h.claim();
  h.complete('one', 'turn-2'); assert.equal(h.claim('busy').queued, 1);
  const receipt = path.join(h.temp, 'receipt.txt'); fs.writeFileSync(receipt, 'Connection lost after request');
  h.run('ack', { delivery: first.delivery_id, status: 'ambiguous', 'receipt-file': receipt });
  const next = h.claim(), payload = JSON.parse(next.arguments.prompt.split('\n')[1]); assert.equal(payload.events.length, 1); assert.equal(payload.events[0].child_turn_id, 'turn-2');
  assert.throws(() => h.run('retry', { event: JSON.parse(first.arguments.prompt.split('\n')[1]).events[0].event_id }), /Only an explicitly failed/);
});
test('failed delivery retries are explicit and stale locks are preserved', t => {
  const h = fixture(t); h.register('one'); const event = h.complete('one'), claim = h.claim();
  const receipt = path.join(h.temp, 'receipt.txt'); fs.writeFileSync(receipt, 'Tool explicitly rejected request before acceptance');
  h.run('ack', { delivery: claim.delivery_id, status: 'failed', 'receipt-file': receipt });
  assert.equal(h.claim().action, 'empty'); h.run('retry', { event: event.event.event_id }); assert.equal(h.claim('busy').queued, 1);
  const lock = path.join(registry(h.repo).folder, 'ledger.lockdir'); fs.mkdirSync(lock); assert.throws(() => h.run('doctor'), /stale lock/); assert.equal(fs.existsSync(lock), true); fs.rmdirSync(lock);
});
test('old independent CLI entrypoints fail closed', t => {
  const h = fixture(t); for (const cmd of ['start', 'message', 'merge', 'cleanup', 'stop', 'attach', 'bind-parent']) assert.throws(() => h.run(cmd), /App-only skill/);
});
