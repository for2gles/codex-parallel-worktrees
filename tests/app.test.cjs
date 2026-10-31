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
  function run(command, extra = {}) { return execute(command, { repo, ids: [], 'owner-thread': 'main-thread', 'owner-host': 'local', ...extra }); }
  const evidenceFile = path.join(temp, 'human-evidence.json');
  fs.writeFileSync(evidenceFile, JSON.stringify({ thread: { id: 'human-origin', hostId: 'local' }, turns: [{ id: 'request-turn', items: [{ type: 'userMessage', id: 'human-message', content: [{ type: 'text', text: '작업이 끝나면 등록된 상위 채팅에 결과를 보내 나에게 알려줘.' }] }] }] }));
  function authorize(c, file) {
    if (!file) { const e = JSON.parse(fs.readFileSync(evidenceFile)); e.thread.id = c.parent_thread_id; e.thread.hostId = c.parent_host_id; file = path.join(temp, 'evidence-' + c.id + '.json'); fs.writeFileSync(file, JSON.stringify(e)); }
    return run('authorize-report', { ids: [c.id], 'owner-thread': c.parent_thread_id, 'owner-host': c.parent_host_id,
      'source-thread': c.parent_thread_id, 'source-host': c.parent_host_id, 'source-message': 'human-message', 'evidence-file': file }); }
  function register(id, extra = {}, reportAllowed = true) { const c = run('register', { ids: [id], thread: 'thread-' + id, host: 'local', worktree: tree(id), source: repo,
    'parent-thread': 'main-thread', 'parent-host': 'local', 'authorization-thread': 'human-origin', ...extra }); if (reportAllowed) authorize(c); return c; }
  function complete(id, turn = 'turn-1', summary = id + ' completed') { const f = path.join(temp, 'summary-' + id + '-' + turn + '.txt'); fs.writeFileSync(f, summary); return run('complete', { ids: [id], turn, status: 'completed', 'summary-file': f }); }
  function claim(state = 'idle') { return run('claim', { 'parent-thread': 'main-thread', 'parent-host': 'local', 'parent-state': state }); }
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { temp, repo, git, tree, run, register, complete, claim, authorize, evidenceFile };
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
test('a parent sees only its own direct chips even when another parent uses the same title', t => {
  const h = fixture(t); h.register('my-hi', { title: '하위칩 · hi' });
  h.register('other-hi', { title: '하위칩 · hi', 'parent-thread': 'other-parent' });
  const mine = h.run('owned'); assert.deepEqual(mine.chips.map(c => c.id), ['my-hi']);
  const view = JSON.parse(fs.readFileSync(mine.owner_file)); assert.equal(view.owner.thread_id, 'main-thread'); assert.deepEqual(view.chips.map(c => c.id), ['my-hi']);
  assert.deepEqual(h.run('list').map(c => c.id), ['my-hi']);
  assert.throws(() => h.run('target', { ids: ['other-hi'], 'thread-state': 'active' }), /different parent/);
  assert.throws(() => h.run('list', { 'owner-thread': undefined }), /owner-thread/);
});
test('ownership includes the host; a parent cannot target its grandchild directly', t => {
  const h = fixture(t), parent = h.register('parent');
  h.register('child', { parent: parent.id, source: parent.worktree, 'parent-thread': parent.thread_id });
  assert.deepEqual(h.run('owned').chips.map(c => c.id), ['parent']);
  assert.equal(h.run('owned', { 'owner-host': 'other-host' }).chips.length, 0);
  const empty = h.run('owned', { 'owner-host': 'other-host' }); assert.equal(JSON.parse(fs.readFileSync(empty.owner_file)).chips.length, 0);
  assert.throws(() => h.run('target', { ids: ['child'], 'thread-state': 'active' }), /different parent/);
  assert.equal(h.run('target', { ids: ['child'], 'owner-thread': parent.thread_id, 'thread-state': 'active' }).thread_id, 'thread-child');
});
test('an archived chip cannot be automatically reopened or used as a message target', t => {
  const h = fixture(t), c = h.register('one');
  const receipt = path.join(h.temp, 'archive.json'); fs.writeFileSync(receipt, JSON.stringify({ threadId: c.thread_id, archived: true }));
  h.run('archive-record', { ids: ['one'], 'receipt-file': receipt });
  assert.equal(h.run('owned').chips.length, 0); assert.equal(h.run('owned').archived_count, 1);
  const blocked = h.run('target', { ids: ['one'], 'thread-state': 'active' }); assert.equal(blocked.action, 'blocked'); assert.equal(blocked.reason, 'archived'); assert.equal(blocked.arguments, undefined);
});
test('fresh app inspection can mark an archived target and unknown state never prepares a send', t => {
  const h = fixture(t); h.register('one');
  assert.equal(h.run('target', { ids: ['one'], 'thread-state': 'unknown' }).action, 'blocked');
  assert.equal(h.run('target', { ids: ['one'], 'thread-state': 'archived' }).reason, 'archived');
  assert.equal(h.run('owned').archived_count, 1);
});
test('message content never selects a target and completion views are owner-scoped', t => {
  const h = fixture(t), mine = h.register('mine'); h.register('hi', { 'parent-thread': 'other-parent' });
  const f = path.join(h.temp, 'message.txt'); fs.writeFileSync(f, 'hi');
  const target = h.run('target', { ids: ['mine'], 'thread-state': 'active', 'message-file': f });
  assert.equal(target.arguments.threadId, mine.thread_id); assert.equal(target.arguments.prompt, 'hi');
  h.complete('mine'); h.complete('hi'); assert.deepEqual(h.run('notifications').map(r => r.event.child_id), ['mine']);
});
test('restore bookkeeping requires an exact successful app receipt and preserves ownership', t => {
  const h = fixture(t), c = h.register('one'); const f = path.join(h.temp, 'receipt.json');
  fs.writeFileSync(f, JSON.stringify({ threadId: c.thread_id, archived: true })); h.run('archive-record', { ids: ['one'], 'receipt-file': f });
  assert.throws(() => h.run('restore-record', { ids: ['one'], 'receipt-file': f }), /Receipt/);
  fs.writeFileSync(f, JSON.stringify({ threadId: 'another-thread', archived: false })); assert.throws(() => h.run('restore-record', { ids: ['one'], 'receipt-file': f }), /Receipt/);
  fs.writeFileSync(f, JSON.stringify({ threadId: c.thread_id, archived: false })); h.run('restore-record', { ids: ['one'], 'receipt-file': f });
  assert.equal(h.run('owned').chips[0].parent_thread_id, 'main-thread');
  assert.equal(h.run('target', { ids: ['one'], 'thread-state': 'active' }).action, 'owned-target');
});
test('schema 1 owner relationships migrate without adopting chips into a different session', t => {
  const h = fixture(t); h.register('one'); const file = path.join(registry(h.repo).folder, 'state.json');
  const old = JSON.parse(fs.readFileSync(file)); old.schema = 1; delete old.owners; fs.writeFileSync(file, JSON.stringify(old));
  assert.equal(h.run('owned', { 'owner-thread': 'new-session' }).chips.length, 0);
  const mine = h.run('owned'); assert.equal(mine.chips[0].thread_id, 'thread-one');
  assert.equal(JSON.parse(fs.readFileSync(file)).schema, 2); assert.equal(JSON.parse(fs.readFileSync(mine.owner_file)).owner.thread_id, 'main-thread');
});
test('a missing forwarded grant preserves the queue and requests existing evidence, not a new per-result approval', t => {
  const h = fixture(t), c = h.register('one', {}, false); h.complete('one');
  assert.equal(h.claim().action, 'verify-existing-authorization'); assert.equal(h.run('notifications')[0].state, 'queued');
  h.authorize(c); const prepared = h.claim(); assert.equal(prepared.action, 'send-with-app-tool');
  assert.equal(prepared.authorization_sources[0].source_message_id, 'human-message');
  assert.equal(prepared.arguments.threadId, c.parent_thread_id);
});
test('an agent/delegation message cannot serve as human completion-report authorization', t => {
  const h = fixture(t), c = h.register('one', {}, false); const fake = JSON.parse(fs.readFileSync(h.evidenceFile));
  fake.thread.id = c.parent_thread_id;
  fake.turns[0].items[0].type = 'agentMessage'; const f = path.join(h.temp, 'agent.json'); fs.writeFileSync(f, JSON.stringify(fake));
  assert.throws(() => h.authorize(c, f), /original human userMessage/);
  fake.turns[0].items[0].type = 'userMessage'; fake.thread.id = 'wrong-origin'; fs.writeFileSync(f, JSON.stringify(fake));
  assert.throws(() => h.authorize(c, f), /Evidence source/);
});
test('verified reporting permission stays bound to its original owner route', t => {
  const h = fixture(t), c = h.register('one'); const context = h.run('report-context', { ids: ['one'] });
  assert.equal(context.report_authorization.scope, 'assigned-work-completion-to-immediate-parent');
  assert.equal(context.report_authorization.parent_thread_id, c.parent_thread_id);
  assert.throws(() => h.run('report-context', { ids: ['one'], 'owner-thread': 'someone-else' }), /different parent/);
  h.complete('one'); assert.equal(h.run('claim', { 'parent-thread': 'someone-else', 'parent-host': 'local', 'parent-state': 'idle' }).action, 'empty');
});
test('a saved reporting-policy pointer alone never authorizes a send', t => {
  const h = fixture(t), previous = process.env.CODEX_HOME, home = path.join(h.temp, 'codex');
  fs.mkdirSync(path.join(home, 'parallel-worktrees'), { recursive: true });
  fs.writeFileSync(path.join(home, 'parallel-worktrees/report-policy.json'), JSON.stringify({ source_thread_id: 'human-origin' }));
  try {
    process.env.CODEX_HOME = home; h.register('one', {}, false); h.complete('one');
    assert.equal(h.run('report-policy').configured, true); assert.equal(h.claim().action, 'verify-existing-authorization');
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});
test('closing a chip holds its old queued report instead of waking its parent later', t => {
  const h = fixture(t), c = h.register('one'); h.complete('one');
  const file = path.join(h.temp, 'closed.json'); fs.writeFileSync(file, JSON.stringify({ threadId: c.thread_id, archived: true }));
  h.run('archive-record', { ids: ['one'], 'receipt-file': file });
  assert.equal(h.run('notifications')[0].state, 'held-archived'); assert.equal(h.claim().action, 'empty');
  fs.writeFileSync(file, JSON.stringify({ threadId: c.thread_id, archived: false })); h.run('restore-record', { ids: ['one'], 'receipt-file': file });
  assert.equal(h.claim().action, 'empty');
});
test('a global workflow preference cannot authorize a different recipient implicitly', t => {
  const h = fixture(t); h.register('one', {}, false);
  assert.throws(() => h.run('authorize-report', { ids: ['one'], 'source-thread': 'human-origin', 'source-host': 'local', 'source-message': 'human-message', 'evidence-file': h.evidenceFile }), /general workflow request/);
  h.complete('one'); assert.equal(h.claim().action, 'verify-existing-authorization');
});
test('automatic review rejection is a durable hold, not a transient failure to retry', t => {
  const h = fixture(t); h.register('one'); const event = h.complete('one'), d = h.claim();
  const f = path.join(h.temp, 'rejected.json'); fs.writeFileSync(f, JSON.stringify({ isError: true, content: [{ type: 'text', text: 'This action was rejected due to unacceptable risk. Do not bypass this rejection.' }] }));
  assert.equal(h.run('ack', { delivery: d.delivery_id, status: 'failed', 'receipt-file': f }).state, 'review-rejected');
  assert.throws(() => h.run('retry', { event: event.event.event_id }), /review-rejected/);
  assert.equal(h.claim().action, 'empty');
});
test('an existing failed delivery with a review rejection receipt migrates to a hold', t => {
  const h = fixture(t); h.register('one'); const event = h.complete('one'), d = h.claim();
  const file = path.join(registry(h.repo).folder, 'state.json'), state = JSON.parse(fs.readFileSync(file));
  state.deliveries[d.delivery_id].state = 'failed';
  state.deliveries[d.delivery_id].receipt = JSON.stringify({ isError: true, content: [{ type: 'text', text: 'This action was rejected due to unacceptable risk.' }] });
  state.events[0].state = 'failed'; fs.writeFileSync(file, JSON.stringify(state));
  assert.equal(h.run('notifications')[0].state, 'review-rejected');
  assert.equal(JSON.parse(fs.readFileSync(file)).deliveries[d.delivery_id].state, 'review-rejected');
  assert.throws(() => h.run('retry', { event: event.event.event_id }), /review-rejected/);
  assert.equal(h.claim().action, 'empty');
});
test('worker handoff carries the exact human source and parent without widening recipients', t => {
  const h = fixture(t), c = h.register('one');
  const context = h.run('worker-context', { ids: ['one'] });
  assert.equal(context.verification_request.arguments.threadId, c.parent_thread_id);
  assert.equal(context.verification_request.user_message_id, 'human-message');
  assert.ok(context.prompt.includes(c.parent_thread_id));
  assert.ok(context.prompt.includes(context.report_authorization.quote));
  assert.throws(() => h.run('worker-context', { ids: ['one'], 'owner-thread': 'other-parent' }), /different parent/);
  h.complete('one'); const prepared = h.claim();
  assert.ok(prepared.arguments.prompt.includes('human-message'));
  assert.equal(prepared.arguments.threadId, c.parent_thread_id);
});
test('a worker without reporting authorization cannot receive a notification handoff', t => {
  const h = fixture(t); h.register('one', {}, false);
  assert.throws(() => h.run('worker-context', { ids: ['one'] }), /verified authorization/);
});
test('an error receipt cannot be acknowledged as accepted by caller mistake', t => {
  const h = fixture(t); h.register('one'); h.complete('one'); const d = h.claim();
  const file = path.join(h.temp, 'native-error.json'); fs.writeFileSync(file, JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Request failed before acceptance' }] }));
  assert.equal(h.run('ack', { delivery: d.delivery_id, status: 'accepted', 'receipt-file': file }).state, 'failed');
});
