'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const cp = require('node:child_process'); const { promisify } = require('node:util');
const execFile = promisify(cp.execFile); const SCRIPT = path.resolve(__dirname, '../scripts/workers.cjs');
const FAKE = path.join(__dirname, 'fake-codex.cjs');
const { UnixWebSocket } = require('../scripts/unix-ws.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-node-')); const repo = path.join(temp, 'repo with spaces'); fs.mkdirSync(repo);
  const git = (args, cwd = repo, check = true) => { const p = cp.spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); if (check && p.status) throw new Error(p.stderr || p.stdout); return p; };
  git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'baseline\n'); git(['add', '.']); git(['commit', '-qm', 'baseline']);
  async function raw(command, ...args) { try { const p = await execFile(process.execPath, [SCRIPT, command, '--repo', repo, ...args], { timeout: 45000, maxBuffer: 8 * 1024 * 1024 }); return { code: 0, ...p }; } catch (e) { return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' }; } }
  async function cli(command, ...args) { const p = await raw(command, ...args); assert.equal(p.code, 0, p.stderr + p.stdout); return p.stdout.trim() ? JSON.parse(p.stdout) : null; }
  const state = async ident => (await cli('status', ident))[0];
  const start = (ident, prompt, ...args) => cli('start', ident, '--codex', FAKE, '--prompt', prompt, ...args);
  const wait = ident => cli('wait', ident, '--timeout', '5');
  t.after(async () => {
    const base = path.join(repo, '.git/parallel-worktrees');
    if (fs.existsSync(base)) {
      const states = fs.readdirSync(base).filter(n => fs.existsSync(path.join(base, n, 'state.json'))).map(n => JSON.parse(fs.readFileSync(path.join(base, n, 'state.json'))));
      for (const s of states.sort((a, b) => b.depth - a.depth)) await raw('stop', s.id);
    }
    await sleep(100); fs.rmSync(temp, { recursive: true, force: true });
  });
  return { repo, git, raw, cli, state, start, wait };
}
test('parallel chips: isolation, steer, same-session follow-up, merge and cleanup', async t => {
  const h = await setup(t); const a = await h.start('alpha', 'SLOW\nMAKE alpha.txt a'); const b = await h.start('beta', 'SLOW\nMAKE beta.txt b');
  assert.notEqual(a.thread_id, b.thread_id); assert.notEqual(a.app_server_pid, b.app_server_pid); assert.notEqual(a.worktree, b.worktree);
  assert.equal(fs.existsSync(path.join(h.repo, 'alpha.txt')), false);
  assert.equal((await h.cli('message', 'alpha', '--prompt', 'MAKE steered.txt yes')).action, 'steered'); await h.wait('alpha');
  assert.equal((await h.cli('message', 'alpha', '--prompt', 'MAKE followup.txt yes')).thread_id, a.thread_id); await h.wait('alpha'); await h.wait('beta');
  await h.cli('merge', 'alpha'); await h.cli('merge', 'beta');
  for (const file of ['alpha.txt', 'beta.txt', 'steered.txt', 'followup.txt']) assert.ok(fs.existsSync(path.join(h.repo, file)));
  await h.cli('cleanup', 'alpha'); await h.cli('cleanup', 'beta'); assert.equal(h.git(['status', '--porcelain']).stdout, '');
});
test('child and grandchild: inheritance, mandatory isolation, bottom-up integration', async t => {
  const h = await setup(t); const parent = await h.start('parent', 'FAST'); await h.wait('parent');
  fs.writeFileSync(path.join(parent.worktree, 'unfinished.txt'), 'preserve');
  assert.notEqual((await h.raw('start', 'dirtychild', '--parent', 'parent', '--prompt', 'FAST')).code, 0);
  assert.equal(fs.readFileSync(path.join(parent.worktree, 'unfinished.txt'), 'utf8'), 'preserve'); fs.unlinkSync(path.join(parent.worktree, 'unfinished.txt'));
  const child = await h.cli('start', 'child', '--repo', parent.worktree, '--prompt', 'FAST'); await h.wait('child');
  const leaf = await h.cli('start', 'leaf', '--parent', 'child', '--prompt', 'MAKE leaf.txt grandchild'); await h.wait('leaf');
  assert.equal(child.parent_id, 'parent'); assert.equal(leaf.parent_id, 'child'); assert.equal(leaf.depth, 3);
  assert.equal((await h.cli('list', 'leaf', '--json'))[0].parent, 'child');
  assert.equal(child.codex, FAKE); assert.equal(leaf.codex, FAKE); assert.equal(leaf.repo, child.worktree);
  assert.equal(new Set([parent.worktree, child.worktree, leaf.worktree]).size, 3);
  assert.equal(new Set([parent.thread_id, child.thread_id, leaf.thread_id]).size, 3);
  assert.notEqual((await h.raw('cleanup', 'parent')).code, 0);
  assert.equal((await h.cli('merge', 'leaf')).target, child.worktree); await h.cli('cleanup', 'leaf');
  assert.equal(fs.existsSync(path.join(h.repo, 'leaf.txt')), false);
  assert.equal((await h.cli('merge', 'child')).target, parent.worktree); await h.cli('cleanup', 'child');
  assert.equal((await h.cli('merge', 'parent')).target, fs.realpathSync(h.repo)); await h.cli('cleanup', 'parent');
  assert.equal(fs.readFileSync(path.join(h.repo, 'leaf.txt'), 'utf8'), 'grandchild\n');
});
test('parent cannot stop with an active descendant; wait includes descendants', async t => {
  const h = await setup(t); const p = await h.start('p', 'FAST'); await h.wait('p');
  await h.cli('start', 'c', '--repo', p.worktree, '--prompt', 'SLOW');
  assert.notEqual((await h.raw('stop', 'p')).code, 0);
  assert.equal((await h.raw('wait', 'p', '--timeout', '0')).code, 2);
  await h.cli('stop', 'c'); await h.cli('stop', 'p');
});
test('remote details and tree listing require no memorized remote URI', async t => {
  const h = await setup(t); const s = await h.start('api', 'SLOW');
  const info = await h.cli('remote', 'api', '--json'); assert.equal(info.remote, 'unix://' + s.server_socket); assert.equal(info.session_id, s.thread_id);
  assert.ok(info.attach_command.includes('attach.sh')); assert.ok(info.attach_command.includes("'api'"));
  const printed = await h.raw('attach', 'api', '--print'); assert.ok(printed.stdout.includes(s.thread_id)); assert.ok(printed.stdout.includes(s.worktree)); assert.ok(printed.stdout.includes('--remote'));
  assert.equal(fs.statSync(s.server_socket).mode & 0o777, 0o600);
  const list = await h.raw('list'); assert.ok(list.stdout.includes('api')); assert.ok(list.stdout.includes(s.worktree));
});
test('explicit approval is pending until accepted; decline reports failure', async t => {
  const h = await setup(t); await h.start('yes', 'APPROVE\nMAKE allowed.txt yes');
  assert.equal((await h.raw('wait', 'yes', '--timeout', '1')).code, 3); assert.equal((await h.state('yes')).pending_requests.length, 1);
  await h.cli('respond', 'yes', '900', '--decision', 'accept'); await h.wait('yes');
  await h.start('no', 'APPROVE'); await h.cli('respond', 'no', '900', '--decision', 'decline'); assert.equal((await h.raw('wait', 'no', '--timeout', '2')).code, 1);
});
test('dirty original and duplicate/invalid IDs preserve user files', async t => {
  const h = await setup(t); fs.writeFileSync(path.join(h.repo, 'user.txt'), 'keep');
  assert.notEqual((await h.raw('start', 'dirty', '--codex', FAKE, '--prompt', 'FAST')).code, 0); fs.unlinkSync(path.join(h.repo, 'user.txt'));
  assert.notEqual((await h.raw('start', '../bad', '--codex', FAKE, '--prompt', 'FAST')).code, 0);
  const s = await h.start('same', 'SLOW'); assert.notEqual((await h.raw('start', 'same', '--codex', FAKE, '--prompt', 'FAST')).code, 0); assert.equal((await h.state('same')).thread_id, s.thread_id);
});
test('dirty chip and unmerged commits cannot be removed', async t => {
  const h = await setup(t); const s = await h.start('keep', 'MAKE kept.txt yes'); await h.wait('keep');
  assert.notEqual((await h.raw('cleanup', 'keep')).code, 0); fs.writeFileSync(path.join(s.worktree, 'user.txt'), 'keep');
  assert.notEqual((await h.raw('merge', 'keep')).code, 0); assert.notEqual((await h.raw('cleanup', 'keep')).code, 0); assert.ok(fs.existsSync(path.join(s.worktree, 'user.txt')));
});
test('merge conflicts remain visible and abort restores parent changes', async t => {
  const h = await setup(t); await h.start('conflict', 'MAKE base.txt worker'); await h.wait('conflict');
  fs.writeFileSync(path.join(h.repo, 'base.txt'), 'parent\n'); h.git(['add', 'base.txt']); h.git(['commit', '-qm', 'parent']);
  assert.notEqual((await h.raw('merge', 'conflict')).code, 0); assert.ok(h.git(['diff', '--name-only', '--diff-filter=U']).stdout.trim()); h.git(['merge', '--abort']);
  assert.equal(fs.readFileSync(path.join(h.repo, 'base.txt'), 'utf8'), 'parent\n');
});
test('watching and attachment do not start a new turn; changed branch is refused', async t => {
  const h = await setup(t); const s = await h.start('watched', 'SLOW');
  const watched = await h.raw('watch', 'watched', '--timeout', '0.1', '--interval', '0.05'); assert.equal(watched.code, 0); assert.ok(watched.stdout.includes(s.thread_id));
  assert.equal((await h.state('watched')).turn_id, s.turn_id); await h.wait('watched');
  h.git(['checkout', '-qb', 'changed'], s.worktree); assert.notEqual((await h.raw('attach', 'watched', '--print')).code, 0);
});
test('a second connection observes the same session and externally started turn', async t => {
  const h = await setup(t); const s = await h.start('observed', 'SLOW'); const ws = await UnixWebSocket.connect(s.server_socket);
  async function rpc(id, method, params) { await ws.send({ id, method, params }); while (true) { const m = await ws.receive(); if (m.id === id) return m.result; } }
  try {
    await rpc(1, 'initialize', { clientInfo: { name: 'test', version: '1' } }); await ws.send({ method: 'initialized', params: {} });
    assert.equal((await rpc(2, 'thread/resume', { threadId: s.thread_id })).thread.id, s.thread_id);
    await h.cli('message', 'observed', '--prompt', 'follow-up criterion');
    while ((await ws.receive()).method !== 'turn/completed') {} await h.wait('observed');
    const turn = (await rpc(3, 'turn/start', { threadId: s.thread_id, input: [{ type: 'text', text: 'SLOW external turn' }] })).turn;
    const tracked = await h.state('observed'); assert.equal(tracked.turn_id, turn.id); assert.equal(tracked.last_message, ''); assert.equal(tracked.completed_at, undefined);
    while ((await ws.receive()).method !== 'turn/completed') {} await h.wait('observed');
  } finally { ws.close(); }
});
test('fast completion, crash, interrupt and bounded waits are distinct', async t => {
  const h = await setup(t); await h.start('fast', 'FAST'); await h.wait('fast'); assert.equal((await h.state('fast')).status, 'completed');
  const crashed = await h.raw('start', 'crash', '--codex', FAKE, '--prompt', 'CRASH'); assert.notEqual(crashed.code, 0);
  await h.start('slow', 'SLOW'); assert.equal((await h.raw('wait', 'slow', '--timeout', '0')).code, 2); await h.cli('stop', 'slow'); assert.equal((await h.state('slow')).status, 'interrupted');
});
test('doctor has no chip/model turn and sandbox wire aliases normalize', async t => {
  const h = await setup(t); const d = await h.cli('doctor', '--codex', FAKE, '--probe'); assert.equal(d.initialize, 'ok'); assert.ok(d.node); assert.equal((await h.cli('status')).length, 0);
  const s = await h.start('sandbox', 'FAST', '--sandbox', 'workspaceWrite'); assert.equal(s.sandbox, 'workspace-write'); await h.wait('sandbox');
});
