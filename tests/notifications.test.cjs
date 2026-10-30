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
