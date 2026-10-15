import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { buildDevice, dishIds } from '../src/dish.js';
import { normalizeConfig } from '../src/config.js';
import { RESPONSE, parseStatus, responseMember } from '../src/starlink/schema.js';
import { alertSummary, buildStatusContent } from '../src/widgets.js';
import { fixture } from './helpers/fakeDish.js';

const status = (name) => parseStatus(responseMember(fixture(name), RESPONSE.DISH_GET_STATUS));
const gladys = createFakeGladys();

test('every content fits the core vocabulary and budget, in every language', () => {
  for (const language of ['en', 'fr', 'de', 'es', 'it']) {
    for (const name of ['status-connected.bin', 'status-obstructed.bin', 'status-stowed.bin']) {
      const dish = status(name);
      for (const ids of [null, dishIds(gladys, dish.id)]) {
        for (const state of [null, 'unreachable']) {
          const content = buildStatusContent({
            configured: true,
            reading: { status: dish, summary: null, snowMeltMode: 'always_on' },
            state,
            ids,
            language,
            ttlSeconds: 30,
          });
          assert.deepEqual(validateWidgetContent(content), [], `${name} ${language} ${state}`);
          assert.ok(content.components.length <= 8);
        }
      }
    }
  }
  for (const configured of [true, false]) {
    const empty = buildStatusContent({
      configured,
      reading: null,
      state: null,
      ids: null,
      language: 'es',
      ttlSeconds: 5,
    });
    assert.deepEqual(validateWidgetContent(empty), []);
    assert.equal(empty.ttl_seconds, 10, 'the core floor');
  }
});

test('the live tiles point at features the device really has', () => {
  const dish = status('status-connected.bin');
  const device = buildDevice(gladys, dish, normalizeConfig());
  const featureIds = new Set(device.features.map((feature) => feature.external_id));
  const content = buildStatusContent({
    configured: true,
    reading: { status: dish, summary: null, snowMeltMode: null },
    state: null,
    ids: dishIds(gladys, dish.id),
    language: 'en',
    ttlSeconds: 30,
  });
  const bound = content.components.filter((component) => component.device_feature);
  assert.equal(bound.length, 4);
  for (const component of bound) {
    assert.ok(featureIds.has(component.device_feature), component.device_feature);
  }
});

test('without the device in Gladys, the tiles carry the values', () => {
  const content = buildStatusContent({
    configured: true,
    reading: {
      status: status('status-obstructed.bin'),
      summary: {
        samples: 30,
        latencyMs: 41.25,
        dropRate: 0,
        downlinkBps: 1.5e8,
        uplinkBps: 1e7,
        powerW: 40,
      },
      snowMeltMode: 'auto',
    },
    state: null,
    ids: null,
    language: 'fr',
    ttlSeconds: 30,
  });
  const [latency, download, , obstruction, statusList] = content.components;
  assert.deepEqual(latency, {
    type: 'value',
    label: 'Latence',
    icon: 'activity',
    value: 41.3,
    unit: 'ms',
  });
  assert.equal(download.value, 150);
  assert.equal(obstruction.value, 1.2);
  assert.deepEqual(statusList.items[0], { label: 'État', value: 'Obstruée', color: 'warning' });
  assert.equal(statusList.items[2].value, 'Automatique');
  assert.equal(statusList.items[3].value, '5 h');
});

test('the alerts are named while 40 characters hold them, then counted', () => {
  const none = alertSummary({ is_heating: false }, 'en');
  assert.deepEqual(none, { value: 'None', color: 'success' });
  const two = alertSummary({ is_heating: true, install_pending: true }, 'en');
  assert.equal(two.value, 'Update pending, Heating');
  const many = alertSummary(
    {
      motors_stuck: true,
      thermal_throttle: true,
      install_pending: true,
      is_heating: true,
      dbf_telem_stale: true,
    },
    'es',
  );
  assert.ok(many.value.length <= 40, many.value);
  assert.match(many.value, /\+\d más$/);
  assert.equal(many.color, 'warning');
});
