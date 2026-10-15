// -----------------------------------------------------------------------------
// The Gladys device of a Starlink dish: its features, and the states a reading
// of the dish gives them.
//
// The feature keys are forever (Gladys keys history, scenes and dashboards on
// them): add new ones, never rename one.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { pollFrequencyMs } from './config.js';
import { NAMES, SNOW_MELT, STATES } from './i18n.js';
import { SNOW_MELT_MODES } from './starlink/schema.js';

export const DEVICE_TYPE = 'dish';

export const FEATURE = {
  CONNECTED: 'connected',
  STATE: 'state',
  LATENCY: 'latency',
  PACKET_LOSS: 'packet_loss',
  DOWNLOAD: 'download',
  UPLOAD: 'upload',
  OBSTRUCTION: 'obstruction',
  OBSTRUCTED: 'obstructed',
  UPTIME: 'uptime',
  POWER: 'power',
  HEATING: 'heating',
  THERMAL_THROTTLE: 'thermal_throttle',
  THERMAL_SHUTDOWN: 'thermal_shutdown',
  UPDATE_PENDING: 'update_pending',
  SNOW_MELT: 'snow_melt',
  SOFTWARE_VERSION: 'software_version',
};

const sensor = (category, type, extra = {}) => ({
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max: 0,
  ...extra,
});

const binary = () => sensor(CATEGORIES.INPUT, TYPES.SENSOR.BINARY, { min: 0, max: 1 });

// Texts carry no history and no range: Gladys still requires min/max (0/0).
const text = () => sensor(CATEGORIES.TEXT, TYPES.TEXT.TEXT, { keep_history: false });

// Gladys has no "percent of something" category: packet loss and obstruction
// share the generic counter couple, so the dashboard shows their names.
const percent = () =>
  sensor(CATEGORIES.COUNTER_SENSOR, TYPES.SENSOR.INTEGER, { unit: UNITS.PERCENT, max: 100 });

/** Order = display order in Gladys. */
const DEFINITIONS = {
  [FEATURE.CONNECTED]: binary(),
  [FEATURE.STATE]: text(),
  [FEATURE.LATENCY]: sensor(CATEGORIES.DURATION, TYPES.DURATION.DECIMAL, {
    unit: UNITS.MILLISECONDS,
    max: 10000,
  }),
  [FEATURE.PACKET_LOSS]: percent(),
  [FEATURE.DOWNLOAD]: sensor(CATEGORIES.DATARATE, TYPES.DATARATE.RATE, {
    unit: UNITS.MEGABITS_PER_SECOND,
    max: 10000,
  }),
  [FEATURE.UPLOAD]: sensor(CATEGORIES.DATARATE, TYPES.DATARATE.RATE, {
    unit: UNITS.MEGABITS_PER_SECOND,
    max: 10000,
  }),
  [FEATURE.OBSTRUCTION]: percent(),
  [FEATURE.OBSTRUCTED]: binary(),
  [FEATURE.UPTIME]: sensor(CATEGORIES.DURATION, TYPES.DURATION.DECIMAL, {
    unit: UNITS.HOURS,
    max: 1000000,
  }),
  [FEATURE.POWER]: sensor(CATEGORIES.SWITCH, TYPES.SWITCH.POWER, { unit: UNITS.WATT, max: 1000 }),
  [FEATURE.HEATING]: binary(),
  [FEATURE.THERMAL_THROTTLE]: binary(),
  [FEATURE.THERMAL_SHUTDOWN]: binary(),
  [FEATURE.UPDATE_PENDING]: binary(),
  [FEATURE.SNOW_MELT]: {
    category: CATEGORIES.TEXT,
    type: TYPES.TEXT.SELECT,
    read_only: false,
    has_feedback: true,
    keep_history: false,
    min: 0,
    max: 0,
  },
  [FEATURE.SOFTWARE_VERSION]: text(),
};

/** External ids of a dish, from the id the dish reports (its serial). */
export const dishIds = (gladys, dishId) => gladys.externalIds(DEVICE_TYPE, dishId);

/** The prefix of every dish device external id of this integration. */
export const dishPrefix = (gladys) => dishIds(gladys, '').device;

/** The dish id of a device external id, null when it is not a dish of ours. */
export function dishIdOf(gladys, externalId) {
  const prefix = dishPrefix(gladys);
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  const rest = externalId.slice(prefix.length);
  return rest && !rest.includes(':') ? rest : null;
}

/** Hardware revision as the Starlink app shows it: "rev3_proto2" → "rev3". */
const hardwareLabel = (hardware) => (hardware || 'Starlink').replace(/_.*$/, '');

/**
 * The discovery payload of a dish.
 * @param {object} gladys
 * @param {{ id: string, hardwareVersion: string }} dish
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 */
export function buildDevice(gladys, dish, config) {
  const ids = dishIds(gladys, dish.id);
  const names = NAMES[config.language];
  return {
    name: `Starlink ${hardwareLabel(dish.hardwareVersion)}`,
    external_id: ids.device,
    // The container refreshes the dish itself (src/poller.js); the core's
    // poll is the fallback, at the same pace.
    should_poll: true,
    poll_frequency: pollFrequencyMs(config),
    params: [
      { name: 'host', value: `${config.host}:${config.port}` },
      { name: 'hardware', value: dish.hardwareVersion || 'unknown' },
    ],
    features: Object.entries(DEFINITIONS).map(([key, definition]) => ({
      ...definition,
      name: names[key],
      external_id: ids.feature(key),
      ...(key === FEATURE.SNOW_MELT
        ? {
            supported_options: SNOW_MELT_MODES.map((mode, index) => ({
              value: mode,
              label: SNOW_MELT[config.language][mode],
              sort_order: index,
            })),
          }
        : {}),
    })),
  };
}

const round = (value, digits) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * The measures of a reading: the averages since the previous poll when the
 * dish history answered, else the one-second sample of the status.
 * @param {object} status from parseStatus
 * @param {object | null} summary from summarizeHistory, null without history
 */
export function measures(status, summary) {
  const useHistory = summary !== null && summary.samples > 0;
  const pickValue = (fromHistory, fromStatus) =>
    useHistory && fromHistory !== null ? fromHistory : fromStatus;
  return {
    latencyMs: round(pickValue(summary?.latencyMs ?? null, status.latencyMs || null), 1),
    packetLossPercent: round(pickValue(summary?.dropRate ?? null, status.dropRate) * 100, 1),
    downloadMbps: round(pickValue(summary?.downlinkBps ?? null, status.downlinkBps) / 1e6, 2),
    uploadMbps: round(pickValue(summary?.uplinkBps ?? null, status.uplinkBps) / 1e6, 2),
    // The status has no power reading: history only.
    powerW: round(useHistory ? summary.powerW : null, 1),
  };
}

/**
 * The feature states of a reading, in the publishChangedStates format.
 * A value the dish did not give is left out (the last one stays).
 * @param {object} gladys
 * @param {{ status: object, summary: object | null, snowMeltMode: string | null }} reading
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 */
export function readingStates(gladys, reading, config) {
  const { status, summary, snowMeltMode } = reading;
  const ids = dishIds(gladys, status.id);
  const values = measures(status, summary);
  const flag = (value) => (value ? 1 : 0);
  const entries = [
    [FEATURE.CONNECTED, flag(status.state === 'connected')],
    [FEATURE.STATE, { text: STATES[config.language][status.state] ?? status.state }],
    // The latency of a dish that lost every ping is meaningless: none.
    [FEATURE.LATENCY, values.latencyMs],
    [FEATURE.PACKET_LOSS, values.packetLossPercent],
    [FEATURE.DOWNLOAD, values.downloadMbps],
    [FEATURE.UPLOAD, values.uploadMbps],
    [FEATURE.OBSTRUCTION, round(status.fractionObstructed * 100, 1)],
    [FEATURE.OBSTRUCTED, flag(status.currentlyObstructed)],
    // One decimal: the value moves every 6 minutes, not at every poll.
    [FEATURE.UPTIME, round(status.uptimeS / 3600, 1)],
    [FEATURE.POWER, values.powerW],
    [FEATURE.HEATING, flag(status.alerts.is_heating)],
    [FEATURE.THERMAL_THROTTLE, flag(status.alerts.thermal_throttle)],
    [FEATURE.THERMAL_SHUTDOWN, flag(status.alerts.thermal_shutdown)],
    [FEATURE.UPDATE_PENDING, flag(status.alerts.install_pending)],
    [FEATURE.SNOW_MELT, snowMeltMode ? { text: snowMeltMode } : null],
    [FEATURE.SOFTWARE_VERSION, status.softwareVersion ? { text: status.softwareVersion } : null],
  ];
  return entries
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) =>
      typeof value === 'object'
        ? { device_feature_external_id: ids.feature(key), text: value.text }
        : { device_feature_external_id: ids.feature(key), state: value },
    );
}

/** The states of a dish that stopped answering: offline, "Unreachable". */
export function unreachableStates(gladys, dishId, config) {
  const ids = dishIds(gladys, dishId);
  return [
    { device_feature_external_id: ids.feature(FEATURE.CONNECTED), state: 0 },
    {
      device_feature_external_id: ids.feature(FEATURE.STATE),
      text: STATES[config.language].unreachable,
    },
  ];
}
