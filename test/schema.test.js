// -----------------------------------------------------------------------------
// The dish protocol against answers encoded by the official protobuf
// implementation from the published .proto files (test/fixtures/starlink).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RESPONSE,
  checkSetConfig,
  parseConfig,
  parseHistory,
  parseStatus,
  requests,
  responseMember,
  summarizeHistory,
} from '../src/starlink/schema.js';
import { DISH_ID, fixture } from './helpers/fakeDish.js';

const expectedRequests = JSON.parse(
  readFileSync(new URL('./fixtures/starlink/requests.json', import.meta.url), 'utf8'),
);
const status = (name) => parseStatus(responseMember(fixture(name), RESPONSE.DISH_GET_STATUS));

test('the requests are byte for byte those of the official implementation', () => {
  const built = {
    getStatus: requests.getStatus(),
    getHistory: requests.getHistory(),
    getConfig: requests.getConfig(),
    reboot: requests.reboot(),
    stow: requests.stow(false),
    unstow: requests.stow(true),
    'setSnowMeltMode:auto': requests.setSnowMeltMode('auto'),
    'setSnowMeltMode:always_on': requests.setSnowMeltMode('always_on'),
    'setSnowMeltMode:always_off': requests.setSnowMeltMode('always_off'),
  };
  for (const [name, bytes] of Object.entries(built)) {
    assert.equal(bytes.toString('hex'), expectedRequests[name], name);
  }
  assert.throws(() => requests.setSnowMeltMode('turbo'), /Unknown snow melt mode/);
});

test('a connected dish (values of the Home Assistant test fixture)', () => {
  const dish = status('status-connected.bin');
  assert.equal(dish.id, DISH_ID);
  assert.equal(dish.hardwareVersion, 'rev3_proto2');
  assert.equal(dish.state, 'connected');
  assert.equal(dish.outageDurationS, null);
  assert.equal(dish.uptimeS, 804138);
  assert.equal(dish.latencyMs, 30.285715103149414);
  assert.equal(dish.downlinkBps, 10108.2724609375);
  assert.equal(dish.uplinkBps, 11802.771484375);
  assert.equal(dish.dropRate, 0);
  assert.equal(dish.fractionObstructed, 0);
  assert.equal(dish.currentlyObstructed, false);
  assert.equal(dish.softwareUpdateState, 'idle');
  assert.equal(dish.snowMeltMode, 'auto', 'recent firmware: in the status');
  assert.ok(Object.values(dish.alerts).every((active) => active === false));
});

test('an obstructed dish: outage cause, alerts, older firmware without config', () => {
  const dish = status('status-obstructed.bin');
  assert.equal(dish.state, 'obstructed');
  assert.equal(dish.outageDurationS, 12.5);
  assert.equal(dish.currentlyObstructed, true);
  assert.ok(Math.abs(dish.fractionObstructed - 0.0123) < 1e-6);
  assert.equal(dish.alerts.is_heating, true);
  assert.equal(dish.alerts.install_pending, true);
  assert.equal(dish.alerts.slow_ethernet_speeds, true);
  assert.equal(dish.alerts.thermal_throttle, false);
  assert.equal(dish.softwareUpdateState, 'reboot_required');
  assert.equal(dish.snowMeltMode, null);
});

test('NO_SCHEDULE is "searching", like the Starlink app says; STOWED is stowed', () => {
  assert.equal(status('status-searching.bin').state, 'searching');
  assert.equal(status('status-stowed.bin').state, 'stowed');
  assert.equal(status('status-stowed.bin').hardwareVersion, 'rev4_prod1');
});

test('the configuration answer gives the snow melt mode', () => {
  const config = parseConfig(responseMember(fixture('config.bin'), RESPONSE.DISH_GET_CONFIG));
  assert.deepEqual(config, { snowMeltMode: 'always_off' });
});

test('errors: a Status error, a missing member, a refused setting', () => {
  assert.throws(
    () => responseMember(fixture('status-error.bin'), RESPONSE.DISH_GET_STATUS),
    /Dish error 12: unsupported request/,
  );
  assert.throws(
    () => responseMember(fixture('reboot.bin'), RESPONSE.DISH_GET_STATUS),
    /not a Starlink dish/,
  );
  assert.throws(
    () =>
      checkSetConfig(responseMember(fixture('set-config-refused.bin'), RESPONSE.DISH_SET_CONFIG)),
    /snow melt mode not supported/,
  );
  checkSetConfig(responseMember(fixture('set-config.bin'), RESPONSE.DISH_SET_CONFIG));
});

const history = parseHistory(responseMember(fixture('history.bin'), RESPONSE.DISH_GET_HISTORY));

test('the history ring buffer is read from its counter, oldest to newest', () => {
  assert.equal(history.current, 119395);
  assert.equal(history.dropRate.length, 900);
  const last30 = summarizeHistory(history, { window: 30 });
  assert.equal(last30.samples, 30);
  assert.equal(last30.end, 119395);
  assert.equal(last30.dropRate, 0.05);
  assert.ok(Math.abs(last30.latencyMs - 1010 / 29) < 1e-9, 'the fully lost second is left out');
  assert.equal(last30.downlinkBps, 64.5e6);
  assert.equal(last30.powerW, 31);
});

test('a late poll averages every sample since the previous one, an early one a whole window', () => {
  const late = summarizeHistory(history, { since: 119395 - 60, window: 30 });
  assert.equal(late.samples, 60);
  const early = summarizeHistory(history, { since: 119390, window: 30 });
  assert.equal(early.samples, 30, 'polled 5 s after the previous one: still the last 30 s');
  const short = summarizeHistory(history, { since: 119390, window: 3 });
  assert.equal(short.samples, 5);
  assert.equal(short.latencyMs, 22);
  const stalled = summarizeHistory(history, { since: 0, window: 30 });
  assert.equal(stalled.samples, 900, 'never more than the buffer');
});

test('a counter higher than the current one (the dish rebooted) takes the last window', () => {
  const rebooted = summarizeHistory(history, { since: 500000, window: 30 });
  assert.equal(rebooted.samples, 30);
});

test('just after a boot, only the samples written so far count', () => {
  const young = { ...history, current: 10 };
  assert.equal(summarizeHistory(young, { window: 30 }).samples, 10);
  const missing = { ...history, powerW: [] };
  assert.equal(summarizeHistory(missing, { window: 30 }).powerW, null);
});
