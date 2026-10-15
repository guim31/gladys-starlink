// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from realistic
// fixtures: the recorded dish answers (Gen 2 and Gen 3 hardware), every
// refresh interval, in every feature-name language — and the device the
// integration actually published to the fake Gladys.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig } from '../src/config.js';
import { buildDevice, readingStates } from '../src/dish.js';
import { RESPONSE, parseStatus, responseMember } from '../src/starlink/schema.js';
import { fixture } from './helpers/fakeDish.js';
import { createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

const FIXTURES = [
  'status-connected.bin',
  'status-obstructed.bin',
  'status-searching.bin',
  'status-stowed.bin',
];

function checkDevice(device, where) {
  // should_poll: true if and only if poll_frequency is provided, in ms.
  if (device.poll_frequency === undefined) {
    assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
  } else {
    assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
    assert.ok(
      table.poll_frequencies_ms.includes(device.poll_frequency),
      `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
    );
  }

  assert.ok(device.features.length > 0, `${where}: no feature`);
  const externalIds = new Set();
  const names = new Set();
  for (const feature of device.features) {
    const at = `${where} / ${feature.name}`;
    const pair = table.pairs[`${feature.category}/${feature.type}`];
    assert.ok(pair, `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`);
    assert.ok(pair.label_en && pair.label_fr && pair.icon, `${at}: couple without label or icon`);

    assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
    assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
    assert.ok(
      Number.isFinite(feature.min) && Number.isFinite(feature.max),
      `${at}: finite min/max`,
    );
    assert.ok(feature.min <= feature.max, `${at}: min > max`);
    assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
    assert.equal(typeof feature.has_feedback, 'boolean', `${at}: has_feedback must be a boolean`);
    if (feature.unit !== undefined) {
      assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
    }

    assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
    externalIds.add(feature.external_id);
    assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
    names.add(feature.name);
  }
  return externalIds;
}

for (const language of ['en', 'fr', 'de', 'es']) {
  for (const interval of ['10', '15', '30', '60']) {
    test(`every dish device follows the Gladys rules (${language}, ${interval} s)`, () => {
      const gladys = createFakeGladys();
      const config = normalizeConfig({ language, poll_interval: interval });
      for (const name of FIXTURES) {
        const status = parseStatus(responseMember(fixture(name), RESPONSE.DISH_GET_STATUS));
        const device = buildDevice(gladys, status, config);
        const ids = checkDevice(device, `${name} (${language})`);

        // Every state of a reading targets a feature of the device, with the
        // value type the feature expects (a number, or a non-empty text).
        const states = readingStates(
          gladys,
          { status, summary: null, snowMeltMode: 'auto' },
          config,
        );
        for (const state of states) {
          assert.ok(ids.has(state.device_feature_external_id), state.device_feature_external_id);
          if (state.text !== undefined) {
            assert.ok(state.text.length > 0, `${state.device_feature_external_id}: empty text`);
          } else {
            assert.ok(Number.isFinite(state.state), `${state.device_feature_external_id}: NaN`);
          }
        }
      }
    });
  }
}

test('the device published to Gladys follows the rules, and Gladys accepted it', async (t) => {
  const world = await createWorld();
  t.after(() => world.close());
  // The SDK's fake Gladys validates like the host API: a refused payload
  // would not be in discoveredDevices.
  assert.equal(world.gladys.fake.discoveredDevices.length, 1);
  checkDevice(world.device, 'published');
  assert.ok(world.gladys.fake.requests.every((request) => request.status < 400));
});
