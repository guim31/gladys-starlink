// -----------------------------------------------------------------------------
// End to end: the SDK's fake Gladys, the integration, a fake dish answering
// recorded protobuf answers over real gRPC (HTTP/2) on 127.0.0.1.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createWorld, waitFor } from './helpers/world.js';
import { DISH_ID } from './helpers/fakeDish.js';
import { HEARTBEAT_MS } from '../src/app.js';

const DEVICE = `ext:test-integration:dish:${DISH_ID}`;
const feature = (key) => `${DEVICE}:${key}`;

/** A clock the tests move by hand. */
function clock(start = 1_000_000) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => {
    current += ms;
  };
  return now;
}

test('the dish is discovered with its own id, and its states published once added', async (t) => {
  const world = await createWorld();
  t.after(() => world.close());
  const { gladys } = world;

  assert.equal(world.device.external_id, DEVICE);
  assert.equal(world.device.name, 'Starlink rev3');
  assert.equal(world.device.should_poll, true);
  assert.equal(world.device.poll_frequency, 30000);
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });

  // Feature names in the configured language (French by default).
  const names = Object.fromEntries(
    world.device.features.map((f) => [f.external_id.split(':').pop(), f.name]),
  );
  assert.equal(names.latency, 'Latence');
  assert.equal(names.obstruction, 'Ciel obstrué');

  assert.equal(world.state('connected'), 1);
  assert.equal(world.state('state'), 'Connectée');
  // Averaged over the last 30 s of history, even right after the first poll.
  assert.equal(world.state('latency'), 34.8);
  assert.equal(world.state('download'), 64.5);
  assert.equal(world.state('uptime'), 223.4);
  assert.equal(world.state('snow_melt'), 'auto');
  assert.equal(world.state('heating'), 0);
  assert.equal(
    world.state('software_version'),
    '191e4dfa-d63a-46b1-a73b-9fa907733864.uterm.release',
  );
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: DEVICE,
    transport: 'local',
  });
});

test('an answer without a dish id is not a dish: nothing is published', async (t) => {
  const world = await createWorld({ dishOptions: { status: 'reboot.bin' } });
  t.after(() => world.close());
  assert.equal(world.gladys.fake.discoveredDevices.length, 0);
  assert.equal(world.gladys.fake.connectionStatus.connected, false);
  assert.match(world.gladys.fake.connectionStatus.message.en, /not a Starlink dish/);
});

test('a device Gladys refused is published again at the next poll', async (t) => {
  const now = clock();
  const world = await createWorld({ now, create: false });
  t.after(() => world.close());
  const { gladys, app } = world;
  const original = gladys.publishDiscoveredDevices.bind(gladys);
  let refuse = true;
  t.mock.method(gladys, 'publishDiscoveredDevices', async (devices) => {
    if (refuse) {
      throw new Error('400 BAD_REQUEST');
    }
    return original(devices);
  });
  await gladys.fake.configUpdated({ host: world.dish.address, language: 'es' });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.es, /400 BAD_REQUEST/);
  refuse = false;
  now.advance(30_000);
  await app.tick();
  assert.equal(world.device.features[0].name, 'Starlink en línea');
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
});

test('nothing is published for a dish the user has not added', async (t) => {
  const world = await createWorld({ create: false });
  t.after(() => world.close());
  assert.equal(world.gladys.fake.discoveredDevices.length, 1);
  assert.equal(world.gladys.fake.states.length, 0);
});

test('the latency, loss and throughput are averaged over the poll period from the history', async (t) => {
  // Added before the start: the first reading is published, with the last
  // 30 seconds of history.
  const world = await createWorld({ precreated: true });
  t.after(() => world.close());
  assert.equal(world.state('latency'), 34.8, 'mean latency, the fully lost second left out');
  assert.equal(world.state('packet_loss'), 5, '1.5 lost seconds out of 30');
  assert.equal(world.state('download'), 64.5);
  assert.equal(world.state('upload'), 6.45);
  assert.equal(world.state('power'), 31);
});

test('without history, the instant values of the status are published', async (t) => {
  const world = await createWorld({ dishOptions: { history: null } });
  t.after(() => world.close());
  assert.equal(world.state('latency'), 30.3);
  assert.equal(world.state('packet_loss'), 0);
  assert.equal(world.state('power'), undefined, 'the status has no power reading');
});

test('older firmware: the snow melt mode is read through dish_get_config', async (t) => {
  const world = await createWorld({ dishOptions: { status: 'status-obstructed.bin' } });
  t.after(() => world.close());
  assert.ok(world.dish.kinds().includes('DISH_GET_CONFIG'));
  assert.equal(world.state('snow_melt'), 'always_off');
  assert.equal(world.state('connected'), 0);
  assert.equal(world.state('state'), 'Obstruée');
  assert.equal(world.state('obstructed'), 1);
  assert.equal(world.state('obstruction'), 1.2);
  assert.equal(world.state('heating'), 1);
  assert.equal(world.state('update_pending'), 1);
});

test('the container refreshes the dish on its own timer, without onPoll (Gladys#3198)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const world = await createWorld({ timers: true });
  t.after(() => world.close());
  const statusReads = () => world.dish.kinds().filter((kind) => kind === 'GET_STATUS').length;
  const before = statusReads();

  world.dish.status = 'status-searching.bin';
  t.mock.timers.tick(30_000);
  await waitFor(() => world.state('state') === 'Recherche de satellites', 'the new state');
  assert.equal(statusReads(), before + 1, 'read once more after one period');
  assert.equal(world.state('connected'), 0);

  // The core's onPoll right after: skipped, the timer just read the dish.
  assert.deepEqual(await world.gladys.fake.poll(world.device), { success: true });
  assert.equal(statusReads(), before + 1);

  t.mock.timers.tick(30_000);
  await waitFor(() => statusReads() === before + 2, 'a second timer poll');
});

test("the core's onPoll still refreshes the dish when the timer is late", async (t) => {
  const now = clock();
  const world = await createWorld({ now });
  t.after(() => world.close());
  const statusReads = () => world.dish.kinds().filter((kind) => kind === 'GET_STATUS').length;
  const before = statusReads();
  now.advance(28_000);
  await world.gladys.fake.poll(world.device);
  assert.equal(statusReads(), before + 1);
});

test('a dish that stops answering: offline after two failed reads, then "lost" and "restored" events', async (t) => {
  const now = clock();
  const world = await createWorld({ now });
  t.after(() => world.close());
  const { gladys, dish, app } = world;

  await dish.unplug();
  now.advance(30_000);
  await app.tick();
  assert.equal(world.state('connected'), 1, 'one failed read is not an outage');
  assert.equal(gladys.fake.sceneEvents.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);

  now.advance(30_000);
  await app.tick();
  assert.equal(world.state('connected'), 0);
  assert.equal(world.state('state'), 'Injoignable');
  assert.equal(gladys.fake.transports.at(-1).transport, 'unreachable');
  assert.deepEqual(gladys.fake.sceneEvents.at(-1), {
    key: 'connection_lost',
    data: { device: DEVICE, cause: 'unreachable', state: 'Injoignable' },
  });

  // Still down: no second event, no new status message.
  const statuses = gladys.fake.connectionStatuses.length;
  now.advance(30_000);
  await app.tick();
  assert.equal(gladys.fake.sceneEvents.length, 1);
  assert.equal(gladys.fake.connectionStatuses.length, statuses);

  await dish.plug();
  now.advance(30_000);
  await app.tick();
  assert.equal(world.state('connected'), 1);
  assert.deepEqual(gladys.fake.sceneEvents.at(-1), {
    key: 'connection_restored',
    data: { device: DEVICE, cause: 'unreachable', outage_seconds: 90 },
  });
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');
});

test('an outage reported by the dish carries its cause; a short drop fires nothing', async (t) => {
  const now = clock();
  const world = await createWorld({ now });
  t.after(() => world.close());
  const { gladys, dish, app } = world;

  // One reading down, then up again: a short drop.
  dish.status = 'status-searching.bin';
  now.advance(30_000);
  await app.tick();
  assert.equal(world.state('connected'), 0, 'the feature follows every reading');
  dish.status = 'status-connected.bin';
  now.advance(30_000);
  await app.tick();
  assert.equal(gladys.fake.sceneEvents.length, 0);

  dish.status = 'status-stowed.bin';
  for (let i = 0; i < 3; i += 1) {
    now.advance(30_000);
    await app.tick();
  }
  assert.deepEqual(
    gladys.fake.sceneEvents.map((event) => event.key),
    ['connection_lost'],
  );
  assert.equal(gladys.fake.sceneEvents[0].data.cause, 'stowed');
  assert.equal(gladys.fake.sceneEvents[0].data.state, 'Rangée');

  dish.status = 'status-connected.bin';
  now.advance(30_000);
  await app.tick();
  assert.deepEqual(gladys.fake.sceneEvents.at(-1).data, {
    device: DEVICE,
    cause: 'stowed',
    outage_seconds: 90,
  });
});

test('Gladys starting during an outage reports no loss, and the dish found later is published', async (t) => {
  const now = clock();
  const world = await createWorld({ now, dishOptions: { status: 'status-searching.bin' } });
  t.after(() => world.close());
  const { gladys, dish, app } = world;
  for (let i = 0; i < 3; i += 1) {
    now.advance(30_000);
    await app.tick();
  }
  assert.equal(gladys.fake.sceneEvents.length, 0);
  dish.status = 'status-connected.bin';
  now.advance(30_000);
  await app.tick();
  assert.equal(gladys.fake.sceneEvents.length, 0, 'no "restored" without a reported loss');
});

test('an obstruction fires one event per episode, at most every 10 minutes', async (t) => {
  const now = clock();
  const world = await createWorld({ now });
  t.after(() => world.close());
  const { gladys, dish, app } = world;
  const obstructions = () =>
    gladys.fake.sceneEvents.filter((event) => event.key === 'obstruction_detected');

  dish.status = 'status-obstructed.bin';
  now.advance(30_000);
  await app.tick();
  assert.deepEqual(obstructions().at(-1).data, { device: DEVICE, obstruction_percent: 1.2 });

  now.advance(30_000);
  await app.tick();
  assert.equal(obstructions().length, 1, 'the same episode');

  dish.status = 'status-connected.bin';
  now.advance(30_000);
  await app.tick();
  dish.status = 'status-obstructed.bin';
  now.advance(30_000);
  await app.tick();
  assert.equal(obstructions().length, 1, 'a new episode within 10 minutes: quiet');

  dish.status = 'status-connected.bin';
  now.advance(10 * 60_000);
  await app.tick();
  dish.status = 'status-obstructed.bin';
  now.advance(30_000);
  await app.tick();
  assert.equal(obstructions().length, 2);
});

test('the heartbeat re-sends unchanged values well before Gladys calls them stale (48 h)', () => {
  assert.ok(HEARTBEAT_MS <= 12 * 60 * 60 * 1000);
});

test('a device added later receives every state at once', async (t) => {
  const world = await createWorld({ create: false });
  t.after(() => world.close());
  await world.gladys.fake.deviceCreated(world.device);
  assert.equal(world.state('connected'), 1);
  assert.equal(world.state('snow_melt'), 'auto');
  assert.ok(world.gladys.fake.widgetRefreshes.includes('dish_status'));
});

test('a new configuration (language, interval) republishes the device', async (t) => {
  const world = await createWorld();
  t.after(() => world.close());
  await world.gladys.fake.configUpdated({
    host: world.dish.address,
    language: 'de',
    poll_interval: '10',
  });
  assert.equal(world.device.poll_frequency, 10000);
  assert.equal(
    world.device.features.find((f) => f.external_id.endsWith(':latency')).name,
    'Latenz',
  );
  assert.equal(world.state('state'), 'Verbunden');
});

test('an invalid address says so in the Configuration screen and reads nothing', async (t) => {
  const world = await createWorld({ config: { host: 'not an address!' } });
  t.after(() => world.close());
  assert.equal(world.dish.requests.length, 0);
  assert.equal(world.gladys.fake.connectionStatus.connected, false);
  assert.match(world.gladys.fake.connectionStatus.message.fr, /n'est pas une adresse valide/);
  const ack = await world.gladys.fake.action('test_connection', {});
  assert.match(ack.data.message.en, /not a valid address/);
});

test('test_connection tells what answered', async (t) => {
  const world = await createWorld();
  t.after(() => world.close());
  const ack = await world.gladys.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  assert.equal(
    ack.data.message.fr,
    'Antenne trouvée (matériel rev3_proto2, logiciel 191e4dfa-d63a-46b1-a73b-9fa907733864.uterm.release) : Connectée.',
  );
  await world.dish.unplug();
  const down = await world.gladys.fake.action('test_connection', {});
  assert.match(down.data.message.en, /does not answer at 127\.0\.0\.1:\d+/);
});

test('reboot and stow are refused until allowed, and reach the dish once allowed', async (t) => {
  const world = await createWorld();
  t.after(() => world.close());
  const { gladys, dish } = world;

  for (const key of ['reboot_dish', 'stow_dish', 'unstow_dish']) {
    const ack = await gladys.fake.action(key, {});
    assert.equal(ack.success, false, key);
    assert.match(ack.error, /Autoriser les commandes qui coupent Internet/);
    const scene = await gladys.fake.sceneAction(key, { device: DEVICE });
    assert.equal(scene.success, false, key);
  }
  assert.ok(!dish.kinds().some((kind) => ['REBOOT', 'DISH_STOW'].includes(kind)));

  await gladys.fake.configUpdated({ host: dish.address, allow_power_commands: true });
  const reboot = await gladys.fake.action('reboot_dish', {});
  assert.equal(reboot.success, true);
  assert.match(reboot.data.message.en, /Reboot requested/);
  assert.equal((await gladys.fake.sceneAction('stow_dish', { device: DEVICE })).success, true);
  assert.equal((await gladys.fake.sceneAction('unstow_dish', { device: DEVICE })).success, true);
  const stows = dish.requests.filter((request) => request.kind === 'DISH_STOW');
  assert.deepEqual(
    stows.map((request) => request.body.bool(1)),
    [false, true],
    'stow, then unstow',
  );
  assert.ok(dish.kinds().includes('REBOOT'));
});

test('a scene action aimed at another dish is refused', async (t) => {
  const world = await createWorld({ config: { allow_power_commands: true } });
  t.after(() => world.close());
  const ack = await world.gladys.fake.sceneAction('reboot_dish', {
    device: 'ext:test-integration:dish:ut99999999-99999999-99999999',
  });
  assert.equal(ack.success, false);
  assert.match(ack.error, /n'est pas l'antenne/);
  assert.ok(!world.dish.kinds().includes('REBOOT'));
});

test('the snow melt mode is set from the device or a scene, and read back', async (t) => {
  const world = await createWorld();
  t.after(() => world.close());
  const { gladys, dish } = world;
  const snowMelt = world.device.features.find((f) => f.external_id === feature('snow_melt'));
  assert.deepEqual(
    snowMelt.supported_options.map((option) => option.value),
    ['auto', 'always_on', 'always_off'],
  );

  const ack = await gladys.fake.setValue(world.device, snowMelt, 'always_on');
  assert.equal(ack.success, true);
  const set = dish.requests.filter((request) => request.kind === 'DISH_SET_CONFIG');
  assert.equal(set.at(-1).body.message(1).uint(1), 1, 'ALWAYS_ON');
  assert.equal(set.at(-1).body.message(1).bool(1001), true, 'apply_snow_melt_mode');

  const scene = await gladys.fake.sceneAction('set_snow_melt_mode', {
    device: DEVICE,
    mode: 'always_off',
  });
  assert.equal(scene.success, true);
  assert.equal(dish.requests.filter((r) => r.kind === 'DISH_SET_CONFIG').length, 2);

  const wrong = await gladys.fake.setValue(world.device, snowMelt, 'turbo');
  assert.equal(wrong.success, false);

  dish.setConfig = 'set-config-refused.bin';
  const refused = await gladys.fake.setValue(world.device, snowMelt, 'auto');
  assert.equal(refused.success, false);
  assert.match(refused.error, /snow melt mode not supported/);
});

test('the other features are read-only', async (t) => {
  const world = await createWorld();
  t.after(() => world.close());
  const latency = world.device.features.find((f) => f.external_id === feature('latency'));
  const ack = await world.gladys.fake.setValue(world.device, latency, 3);
  assert.equal(ack.success, false);
});

test('the widget shows the dish, bound to the live features once added', async (t) => {
  const world = await createWorld();
  t.after(() => world.close());
  const ack = await world.gladys.fake.widgetGet('dish_status', { settings: {}, language: 'en' });
  const content = ack.data.content;
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components[0].device_feature, feature('latency'));
  const status = content.components.find((c) => c.type === 'status');
  assert.deepEqual(status.items[0], { label: 'State', value: 'Connected', color: 'success' });
  assert.equal(status.items[1].value, 'None');

  // Another dish chosen in the settings: nothing to show yet.
  const other = await world.gladys.fake.widgetGet('dish_status', {
    settings: { device: 'ext:test-integration:dish:other' },
    language: 'fr',
  });
  assert.equal(other.data.content.components[0].type, 'text');
});

test('the widget says when the dish is unreachable', async (t) => {
  const now = clock();
  const world = await createWorld({ now });
  t.after(() => world.close());
  await world.dish.unplug();
  for (let i = 0; i < 2; i += 1) {
    now.advance(30_000);
    await world.app.tick();
  }
  const ack = await world.gladys.fake.widgetGet('dish_status', { settings: {}, language: 'de' });
  const status = ack.data.content.components.find((c) => c.type === 'status');
  assert.deepEqual(status.items[0], {
    label: 'Status',
    value: 'Nicht erreichbar',
    color: 'danger',
  });
  assert.deepEqual(validateWidgetContent(ack.data.content), []);
});

test('a normal cycle writes nothing at the info level, and never the dish serial', async (t) => {
  const lines = [];
  for (const stream of ['log', 'error']) {
    t.mock.method(console, stream, (...args) => lines.push(args.join(' ')));
  }
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'debug';
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });

  const now = clock();
  const world = await createWorld({ now });
  t.after(() => world.close());
  const startup = lines.filter((line) => line.includes('[INFO]'));
  assert.ok(
    startup.some((line) => line.includes('Starlink dish found')),
    'the lifecycle is logged',
  );

  lines.length = 0;
  for (let i = 0; i < 3; i += 1) {
    now.advance(30_000);
    await world.app.tick();
  }
  assert.ok(lines.length > 0, 'debug shows the cycle');
  assert.deepEqual(
    lines.filter((line) => !line.includes('[DEBUG]')),
    [],
    'nothing above debug for a normal cycle',
  );

  // A failure is said once, its recovery once.
  lines.length = 0;
  await world.dish.unplug();
  for (let i = 0; i < 4; i += 1) {
    now.advance(30_000);
    await world.app.tick();
  }
  await world.dish.plug();
  now.advance(30_000);
  await world.app.tick();
  const above = lines.filter((line) => !line.includes('[DEBUG]'));
  assert.equal(above.filter((line) => line.includes('unreachable at')).length, 1);
  assert.equal(above.filter((line) => line.includes('answers again')).length, 1);
  assert.equal(above.filter((line) => line.includes('connection lost')).length, 1);
  assert.equal(above.filter((line) => line.includes('connection back')).length, 1);

  process.env.LOG_LEVEL = 'debug';
  const all = lines.join('\n');
  assert.ok(!all.includes(DISH_ID), 'the dish serial stays out of the logs');
});
