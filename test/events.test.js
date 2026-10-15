import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../src/events.js';

const up = (at, extra = {}) => ({ connected: true, cause: 'connected', at, ...extra });
const down = (at, cause = 'searching', extra = {}) => ({ connected: false, cause, at, ...extra });
const keys = (events) => events.map((event) => event.key);

test('an outage is reported on its second reading, its end with its duration', () => {
  const tracker = createTracker();
  assert.deepEqual(tracker.observe(up(0)), []);
  assert.deepEqual(tracker.observe(down(30_000)), []);
  assert.deepEqual(tracker.observe(down(60_000, 'obstructed')), [
    { key: 'connection_lost', data: { cause: 'obstructed' } },
  ]);
  assert.equal(tracker.outage, true);
  assert.deepEqual(tracker.observe(down(90_000)), [], 'reported once');
  assert.deepEqual(tracker.observe(up(120_000)), [
    { key: 'connection_restored', data: { cause: 'obstructed', outage_seconds: 90 } },
  ]);
  assert.equal(tracker.outage, false);
});

test('a single bad reading is a short drop: nothing', () => {
  const tracker = createTracker();
  tracker.observe(up(0));
  assert.deepEqual(tracker.observe(down(30_000)), []);
  assert.deepEqual(tracker.observe(up(60_000)), []);
});

test('an outage already under way at startup is not news', () => {
  const tracker = createTracker();
  assert.deepEqual(keys(tracker.observe(down(0))), []);
  assert.deepEqual(keys(tracker.observe(down(30_000))), []);
  assert.deepEqual(keys(tracker.observe(up(60_000))), []);
  // Armed from now on.
  tracker.observe(down(90_000));
  assert.deepEqual(keys(tracker.observe(down(120_000))), ['connection_lost']);
});

test('obstruction: once per episode, quiet for 10 minutes, unknown readings ignored', () => {
  const tracker = createTracker();
  const obstructed = (at, value) =>
    keys(tracker.observe(up(at, { obstructed: value, obstructionPercent: 2 })));
  assert.deepEqual(obstructed(0, true), [], 'the first reading sets the baseline');
  assert.deepEqual(obstructed(30_000, false), []);
  assert.deepEqual(obstructed(60_000, true), ['obstruction_detected']);
  assert.deepEqual(obstructed(90_000, true), []);
  assert.deepEqual(obstructed(120_000, false), []);
  assert.deepEqual(obstructed(150_000, true), [], 'within 10 minutes of the last one');
  assert.deepEqual(keys(tracker.observe(down(180_000, 'unreachable'))), []);
  assert.deepEqual(obstructed(700_000, false), []);
  assert.deepEqual(obstructed(730_000, true), ['obstruction_detected']);
  const [event] = createTrackerEvent();
  assert.deepEqual(event.data, { obstruction_percent: 3.5 });
});

function createTrackerEvent() {
  const tracker = createTracker();
  tracker.observe(up(0, { obstructed: false }));
  return tracker.observe(up(30_000, { obstructed: true, obstructionPercent: 3.5 }));
}
