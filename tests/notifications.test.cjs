'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Notifications, eventId, records, save } = require('../scripts/notifications.cjs');

test('ambiguous parent RPC failure is durable and never automatically replayed', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ambiguous-')); t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const event = { event_id: eventId('child', 'turn-1'), child_id: 'child', child_turn_id: 'turn-1', status: 'completed', summary: 'done' };
  save(path.join(folder, 'inbox', event.event_id + '.json'), { event, state: 'queued' });
  let calls = 0;
  const chip = { folder, state: { status: 'completed', thread_id: 'parent' }, ready: true, stopping: false,
    save() {}, record() {}, async begin() { calls++; throw new Error('Connection lost after submit'); } };
  const notifications = new Notifications(chip, null); await notifications.drain();
  assert.equal(records(folder, 'inbox')[0].state, 'ambiguous'); await notifications.drain(); assert.equal(calls, 1);
});

test('completed event IDs are stable per child turn and distinct across turns', () => {
  assert.equal(eventId('child', 'turn-1'), eventId('child', 'turn-1'));
  assert.notEqual(eventId('child', 'turn-1'), eventId('child', 'turn-2'));
  assert.notEqual(eventId('a', 'bc'), eventId('ab', 'c'));
});

test('a completion arriving during a notification turn stays queued for the next report', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-next-report-')); t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const first = { event_id: eventId('first', 'turn-1'), child_id: 'first', status: 'completed' };
  const second = { event_id: eventId('second', 'turn-1'), child_id: 'second', status: 'completed' };
  save(path.join(folder, 'inbox', first.event_id + '.json'), { event: first, state: 'queued', sequence: 1 });
  const calls = [];
  const chip = { folder, state: { status: 'completed' }, ready: true, stopping: false, save() {}, record() {},
    rpc() { assert.fail('Notifications must never steer an active turn'); },
    async begin(text) { this.state.status = 'running'; calls.push(text); return { turn_id: 'report-' + calls.length }; } };
  const notifications = new Notifications(chip, null); await notifications.drain();
  save(path.join(folder, 'inbox', second.event_id + '.json'), { event: second, state: 'queued', sequence: 2 });
  await notifications.drain(); assert.equal(calls.length, 1);
  assert.equal(records(folder, 'inbox').find(r => r.event.child_id === 'second').state, 'queued');
  chip.state.status = 'completed'; await notifications.drain(); assert.equal(calls.length, 2);
  assert.ok(calls[0].includes(first.event_id) && !calls[0].includes(second.event_id));
  assert.ok(calls[1].includes(second.event_id) && !calls[1].includes(first.event_id));
});
