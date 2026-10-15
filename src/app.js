// -----------------------------------------------------------------------------
// The integration: wires the Gladys client to the dish.
//
// One dish, at the configured address. Every poll period the container reads
// its status and its history, publishes the states that changed, and turns
// the transitions into scene events. The device is published as soon as the
// dish has answered once: its external id is the dish's own id (serial).
//
// Refreshing: the core cannot be trusted to call onPoll (Gladys#3198: a
// device created without `should_poll` is never polled, and keeps it). The
// container polls on its own timer; the core's onPoll is a fallback, skipped
// when the timer has just polled.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  FEATURE,
  buildDevice,
  dishIdOf,
  dishIds,
  readingStates,
  unreachableStates,
} from './dish.js';
import { createTracker } from './events.js';
import { STATES, TEXT } from './i18n.js';
import { createIssueLog } from './issues.js';
import { createDishClient } from './starlink/client.js';
import { SNOW_MELT_MODES, summarizeHistory } from './starlink/schema.js';
import { WIDGET, buildStatusContent } from './widgets.js';

const logger = createLogger({ name: 'starlink' });

// A value that does not change is still sent this often, so Gladys never
// shows "no recent value" (it does after 48 h).
export const HEARTBEAT_MS = 6 * 60 * 60 * 1000;

// The dish is reported unreachable after this many failed reads in a row:
// one lost answer is not an outage.
export const UNREACHABLE_AFTER = 2;

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  REBOOT: 'reboot_dish',
  STOW: 'stow_dish',
  UNSTOW: 'unstow_dish',
};
export const SCENE_ACTIONS = {
  REBOOT: 'reboot_dish',
  STOW: 'stow_dish',
  UNSTOW: 'unstow_dish',
  SET_SNOW_MELT_MODE: 'set_snow_melt_mode',
};

const localized = (message, language) => message[language] ?? message.en;

/**
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {object} [options]
 * @param {typeof createDishClient} [options.createClient]
 * @param {boolean} [options.timers] run the polling timer (tests drive it by hand)
 * @param {() => number} [options.now]
 */
export function registerHandlers(
  gladys,
  { createClient = createDishClient, timers = true, now = () => Date.now() } = {},
) {
  let config = normalizeConfig();
  let client = null;
  const issues = createIssueLog(logger);

  // What the dish told: its identity (once it answered), the last reading.
  let dish = null;
  // False when the device must be (re)published: a new dish, a new config.
  let devicePublished = false;
  let reading = null;
  let state = null; // the dish state, or "unreachable"
  let failures = 0;
  let historyEnd = null;
  let tracker = createTracker();
  let connectionOk = null;
  let transport = null;
  let widgetSignature = null;

  let timer = null;
  let stopped = false;
  let lastPollAt = -Infinity;
  let inFlight = null;

  const periodMs = () => config.pollIntervalS * 1000;
  const address = () => `${config.host}:${config.port}`;
  const configured = () => config.host !== null;

  /** The dish devices the user added to Gladys. */
  const createdDishIds = () =>
    (gladys.devices ?? [])
      .map((device) => dishIdOf(gladys, device.external_id))
      .filter((id) => id !== null);
  const isCreated = (dishId) => createdDishIds().includes(dishId);

  function resetDish() {
    dish = null;
    devicePublished = false;
    reading = null;
    state = null;
    failures = 0;
    historyEnd = null;
    tracker = createTracker();
    transport = null;
    widgetSignature = null;
  }

  function applyConfig(raw) {
    const previous = config;
    config = normalizeConfig(raw);
    // Names, poll frequency and address params follow the configuration.
    devicePublished = false;
    client = configured() ? createClient({ host: config.host, port: config.port }) : null;
    if (previous.host !== config.host || previous.port !== config.port) {
      resetDish();
    }
  }

  async function setConnection(ok, message) {
    // Only what changed: during an outage, every poll fails the same way.
    const signature = JSON.stringify([ok, message ?? null]);
    if (connectionOk === signature) {
      return;
    }
    connectionOk = signature;
    await gladys.setConnectionStatus(ok, message).catch((err) => {
      logger.debug(`setConnectionStatus failed (${err.message})`);
    });
  }

  async function publishDevice() {
    if (!dish) {
      return;
    }
    await gladys.publishDiscoveredDevices([buildDevice(gladys, dish, config)]);
  }

  async function publishTransport(dishId, value) {
    if (transport === value || !isCreated(dishId)) {
      return;
    }
    await gladys.publishTransports([
      { external_id: dishIds(gladys, dishId).device, transport: value },
    ]);
    transport = value;
  }

  async function fireEvents(dishId, events) {
    for (const event of events) {
      const data = { device: dishIds(gladys, dishId).device, ...event.data };
      if (event.key === 'connection_lost') {
        data.state = STATES[config.language][event.data.cause] ?? event.data.cause;
        logger.info(`Starlink connection lost (${event.data.cause})`);
      } else if (event.key === 'connection_restored') {
        logger.info(`Starlink connection back after ${event.data.outage_seconds} s`);
      } else {
        logger.debug(`Obstruction detected (${event.data.obstruction_percent} %)`);
      }
      await gladys.publishSceneEvent(event.key, data).catch((err) => {
        logger.warn(`Scene event ${event.key} refused (${err.message})`);
      });
    }
  }

  /** Nudge the widget when what it shows changed (the core caps it at 1 per 10 s). */
  function refreshWidget() {
    const signature = JSON.stringify([state, reading?.status.alerts, reading?.snowMeltMode]);
    if (signature !== widgetSignature) {
      widgetSignature = signature;
      // Fire and forget: dropped by the SDK while Gladys is unreachable.
      Promise.resolve()
        .then(() => gladys.requestWidgetRefresh(WIDGET.STATUS))
        .catch((err) => logger.debug(`Widget refresh not sent (${err.message})`));
    }
  }

  async function onReadFailure(err) {
    failures += 1;
    issues.fail('dish', `Starlink dish unreachable at ${address()}: ${err.message}`);
    await setConnection(false, TEXT.unreachable(address(), err.message));
    // The dish this run talked to, else the ones added to Gladys (after a
    // restart while the dish is down).
    const targets = dish ? [dish.id] : createdDishIds();
    const confirmed = failures >= UNREACHABLE_AFTER;
    if (confirmed) {
      state = 'unreachable';
    }
    for (const dishId of targets) {
      if (confirmed) {
        if (isCreated(dishId)) {
          await gladys.publishChangedStates(unreachableStates(gladys, dishId, config), {
            heartbeat: HEARTBEAT_MS,
          });
        }
        await publishTransport(dishId, DEVICE_TRANSPORTS.UNREACHABLE);
      }
      await fireEvents(
        dishId,
        tracker.observe({ connected: false, cause: 'unreachable', at: now() }),
      );
    }
    refreshWidget();
  }

  /** Read the dish once and publish what changed. Errors are logged, not thrown. */
  async function poll() {
    if (!client) {
      return;
    }
    let status;
    try {
      status = await client.getStatus();
      if (!status.id) {
        throw new Error('the device answered without a dish id: not a Starlink dish?');
      }
    } catch (err) {
      await onReadFailure(err);
      return;
    }
    failures = 0;
    issues.ok('dish', `Starlink dish answers again at ${address()}`);

    if (!dish || dish.id !== status.id || dish.hardwareVersion !== status.hardwareVersion) {
      const isNew = dish?.id !== status.id;
      dish = { id: status.id, hardwareVersion: status.hardwareVersion };
      devicePublished = false;
      if (isNew) {
        historyEnd = null;
        tracker = createTracker();
        logger.info(
          `Starlink dish found at ${address()} (hardware ${status.hardwareVersion}, ` +
            `software ${status.softwareVersion})`,
        );
      }
    }
    if (!devicePublished) {
      try {
        await publishDevice();
        devicePublished = true;
        issues.ok('device', 'The dish device is published again');
      } catch (err) {
        // Published again at the next poll.
        issues.fail('device', `Publishing the dish failed: ${err.message}`);
        await setConnection(false, TEXT.publishFailed(err.message));
        return;
      }
    }
    await setConnection(true);

    // The history gives averages over the poll period; without it, the
    // one-second sample of the status.
    let summary = null;
    try {
      const history = await client.getHistory();
      summary = summarizeHistory(history, { since: historyEnd, window: config.pollIntervalS });
      historyEnd = summary.end;
      issues.ok('history', 'Starlink history readable again');
    } catch (err) {
      issues.fail('history', `Starlink history unreadable, using instant values (${err.message})`);
    }

    let snowMeltMode = status.snowMeltMode;
    if (snowMeltMode === null) {
      snowMeltMode = await client
        .getConfig()
        .then((dishConfig) => dishConfig.snowMeltMode)
        .catch((err) => {
          logger.debug(`Snow melt mode unreadable (${err.message})`);
          return reading?.snowMeltMode ?? null;
        });
    }

    reading = { status, summary, snowMeltMode };
    state = status.state;

    let published = 0;
    if (isCreated(status.id)) {
      ({ count: published } = await gladys.publishChangedStates(
        readingStates(gladys, reading, config),
        { heartbeat: HEARTBEAT_MS },
      ));
      await publishTransport(status.id, DEVICE_TRANSPORTS.LOCAL);
    }
    logger.debug(
      `Dish read: ${status.state}, ${summary ? `${summary.samples} s of history` : 'no history'}, ` +
        `${published} state(s) published`,
    );
    await fireEvents(
      status.id,
      tracker.observe({
        connected: status.state === 'connected',
        cause: status.state,
        obstructed: status.currentlyObstructed,
        obstructionPercent: Math.round(status.fractionObstructed * 1000) / 10,
        at: now(),
      }),
    );
    refreshWidget();
  }

  /**
   * Poll unless the last poll is younger than `minGap` periods. Concurrent
   * callers share the poll in progress; a forced poll waits for it, then
   * reads again (a new config, a device just added).
   */
  async function refresh({ force = false, minGap = 0.5 } = {}) {
    while (inFlight && force) {
      await inFlight;
    }
    if (inFlight) {
      return inFlight;
    }
    if (!force && now() - lastPollAt < periodMs() * minGap) {
      logger.debug('Dish polled moments ago: skipped');
      return undefined;
    }
    lastPollAt = now();
    inFlight = poll()
      .catch((err) => {
        // Publishing failed (Gladys unreachable, 429...): the next poll retries.
        issues.fail('publish', `Publishing the dish states failed (${err.message})`);
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!timers || stopped) {
      return;
    }
    timer = setTimeout(async () => {
      timer = null;
      if (gladys.connected !== false) {
        await refresh();
      }
      schedule();
    }, periodMs());
  }

  async function restart() {
    stopped = false;
    lastPollAt = -Infinity;
    schedule();
    if (!configured()) {
      logger.info('No valid dish address: waiting for the configuration');
      await setConnection(false, TEXT.invalidHost(config.invalidHost ?? ''));
      return;
    }
    await refresh({ force: true });
  }

  const ourDevice = (device) => dishIdOf(gladys, device?.external_id);

  // --- Commands ---------------------------------------------------------------

  /** The dish a command targets: the one answering, checked against the device asked. */
  async function commandTarget(deviceExternalId) {
    if (!client) {
      throw new Error(localized(TEXT.invalidHost(config.invalidHost ?? ''), config.language));
    }
    if (deviceExternalId) {
      const wanted = dishIdOf(gladys, deviceExternalId);
      const answering = dish?.id ?? (await client.getStatus().then((status) => status.id));
      if (wanted !== answering) {
        throw new Error(localized(TEXT.otherDish(), config.language));
      }
    }
  }

  const POWER_COMMANDS = {
    reboot: { run: () => client.reboot(), done: TEXT.rebooting },
    stow: { run: () => client.stow(false), done: TEXT.stowing },
    unstow: { run: () => client.stow(true), done: TEXT.unstowing },
  };

  /** Reboot, stow or unstow: they cut the Internet access, opt-in only. */
  async function powerCommand(kind, { deviceExternalId, origin }) {
    if (!config.allowPowerCommands) {
      throw new Error(localized(TEXT.commandsDisabled(), config.language));
    }
    await commandTarget(deviceExternalId);
    logger.info(`${kind} of the dish requested (${origin})`);
    try {
      await POWER_COMMANDS[kind].run();
    } catch (err) {
      throw new Error(localized(TEXT.commandFailed(err.message), config.language), {
        cause: err,
      });
    }
    return POWER_COMMANDS[kind].done();
  }

  async function setSnowMeltMode(mode, { deviceExternalId, origin }) {
    if (!SNOW_MELT_MODES.includes(mode)) {
      throw new Error(`Unknown snow melt mode: ${mode}`);
    }
    await commandTarget(deviceExternalId);
    logger.info(`Snow melt mode set to ${mode} (${origin})`);
    try {
      await client.setSnowMeltMode(mode);
    } catch (err) {
      throw new Error(localized(TEXT.commandFailed(err.message), config.language), {
        cause: err,
      });
    }
    await refresh({ force: true });
    return TEXT.snowMeltSet(mode);
  }

  async function testConnection() {
    if (!client) {
      return TEXT.invalidHost(config.invalidHost ?? '');
    }
    try {
      const status = await client.getStatus();
      await refresh({ force: true });
      return TEXT.found({
        hardware: status.hardwareVersion || '?',
        software: status.softwareVersion || '?',
        state: Object.fromEntries(
          Object.entries(STATES).map(([lang, table]) => [lang, table[status.state]]),
        ),
      });
    } catch (err) {
      return TEXT.unreachable(address(), err.message);
    }
  }

  // --- Handlers ---------------------------------------------------------------

  gladys.onScanRequest(async () => {
    devicePublished = false;
    await refresh({ force: true });
  });

  gladys.onPoll(async (device) => {
    if (ourDevice(device) !== null) {
      await refresh({ minGap: 0.9 });
    }
  });

  // A device just added (or updated): the SDK forgot what it published for
  // it, Gladys dropped the states sent before. Send everything now.
  const onDeviceChange = async (device) => {
    if (ourDevice(device) === null) {
      return;
    }
    transport = null;
    widgetSignature = null;
    await refresh({ force: true });
  };
  gladys.onDeviceCreated(onDeviceChange);
  gladys.onDeviceUpdated(onDeviceChange);

  gladys.onSetValue(async (device, feature, value) => {
    const dishId = ourDevice(device);
    if (
      dishId === null ||
      feature.external_id !== dishIds(gladys, dishId).feature(FEATURE.SNOW_MELT)
    ) {
      throw new Error(`No command for ${feature.external_id}`);
    }
    // The value of a text/select is the selected option.
    await setSnowMeltMode(String(value), {
      deviceExternalId: device.external_id,
      origin: 'device',
    });
  });

  gladys.onAction(ACTIONS.TEST_CONNECTION, () => testConnection());
  gladys.onAction(ACTIONS.REBOOT, () => powerCommand('reboot', { origin: 'configuration' }));
  gladys.onAction(ACTIONS.STOW, () => powerCommand('stow', { origin: 'configuration' }));
  gladys.onAction(ACTIONS.UNSTOW, () => powerCommand('unstow', { origin: 'configuration' }));

  // Scene actions resolve no output: a failure throws, the scene logs it.
  const sceneCommand = (kind) => async (fields) => {
    await powerCommand(kind, { deviceExternalId: fields.device, origin: 'scene' });
  };
  gladys.onSceneAction(SCENE_ACTIONS.REBOOT, sceneCommand('reboot'));
  gladys.onSceneAction(SCENE_ACTIONS.STOW, sceneCommand('stow'));
  gladys.onSceneAction(SCENE_ACTIONS.UNSTOW, sceneCommand('unstow'));
  gladys.onSceneAction(SCENE_ACTIONS.SET_SNOW_MELT_MODE, async (fields) => {
    await setSnowMeltMode(fields.mode, { deviceExternalId: fields.device, origin: 'scene' });
  });

  gladys.onWidgetGet(WIDGET.STATUS, async ({ settings, language }) => {
    const created = reading && isCreated(reading.status.id);
    const chosen = settings?.device ? dishIdOf(gladys, settings.device) : null;
    const sameDish = chosen === null || chosen === reading?.status.id;
    return buildStatusContent({
      configured: configured(),
      reading: sameDish ? reading : null,
      state,
      ids: created && sameDish ? dishIds(gladys, reading.status.id) : null,
      language,
      ttlSeconds: config.pollIntervalS,
    });
  });

  gladys.onConfigUpdated(async (raw) => {
    logger.info('Configuration updated');
    applyConfig(raw);
    await restart();
  });

  gladys.on('connected', async () => {
    try {
      applyConfig(await gladys.getConfig());
      await restart();
    } catch (err) {
      logger.error(`Post-connection initialization failed: ${err.message}`);
      await gladys.setConnectionStatus(false, TEXT.initFailed()).catch(() => {});
    }
  });

  return {
    /** The poll as the timer runs it (tests call it to step time). */
    tick: () => refresh(),
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
    get state() {
      return state;
    },
  };
}
