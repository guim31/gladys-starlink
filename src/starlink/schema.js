// -----------------------------------------------------------------------------
// The part of the dish API the integration uses: field numbers, request
// builders and response parsers.
//
// Service `SpaceX.API.Device.Device`, method `Handle(Request) → Response`, on
// the dish at 192.168.100.1:9200, without authentication. The field numbers
// are those of the protocol the dish describes through gRPC reflection, as
// published by the community tools (sparky8512/starlink-grpc-tools, Unlicense;
// ewilken/starlink-rs, MIT/Apache-2.0). Protobuf never reuses a field number:
// a field SpaceX removes reads as its default, one it adds is skipped.
// -----------------------------------------------------------------------------

import { Message, encode } from './protobuf.js';

export const GRPC_PATH = '/SpaceX.API.Device.Device/Handle';
export const DEFAULT_PORT = 9200;

// Request.oneof request / Response.oneof response.
export const REQUEST = {
  REBOOT: 1001,
  GET_STATUS: 1004,
  GET_HISTORY: 1007,
  DISH_STOW: 2002,
  DISH_SET_CONFIG: 2010,
  DISH_GET_CONFIG: 2011,
};
export const RESPONSE = {
  STATUS: 2, // SpaceX.API.Status.Status { code = 1, message = 2 }
  REBOOT: 1001,
  DISH_STOW: 2002,
  DISH_GET_STATUS: 2004,
  DISH_GET_HISTORY: 2006,
  DISH_SET_CONFIG: 2010,
  DISH_GET_CONFIG: 2011,
};

// DishGetStatusResponse.
const STATUS = {
  DEVICE_INFO: 1, // DeviceInfo { id = 1, hardware_version = 2, software_version = 3 }
  DEVICE_STATE: 2, // DeviceState { uptime_s = 1 }
  POP_PING_DROP_RATE: 1003,
  OBSTRUCTION_STATS: 1004,
  ALERTS: 1005,
  DOWNLINK_THROUGHPUT_BPS: 1007,
  UPLINK_THROUGHPUT_BPS: 1008,
  POP_PING_LATENCY_MS: 1009,
  OUTAGE: 1014, // DishOutage { cause = 1, start_timestamp_ns = 2, duration_ns = 3 }
  SOFTWARE_UPDATE_STATE: 1021,
  CONFIG: 2000, // DishConfig, on recent firmware only
};

// DishObstructionStats.
const OBSTRUCTION = { FRACTION_OBSTRUCTED: 1, CURRENTLY_OBSTRUCTED: 5 };

// DishAlerts: every field is a bool. The integration publishes a few of them
// and lists the others as text.
export const ALERT_FIELDS = {
  motors_stuck: 1,
  thermal_shutdown: 2,
  thermal_throttle: 3,
  unexpected_location: 4,
  mast_not_near_vertical: 5,
  slow_ethernet_speeds: 6,
  install_pending: 8,
  is_heating: 9,
  power_supply_thermal_throttle: 10,
  is_power_save_idle: 11,
  dbf_telem_stale: 14,
  low_motor_current: 16,
  lower_signal_than_predicted: 17,
  slow_ethernet_speeds_100: 18,
  obstruction_map_reset: 19,
  dish_water_detected: 20,
  router_water_detected: 21,
  upsu_router_port_slow: 22,
  no_ethernet_link: 23,
};

// DishOutage.Cause. NO_SCHEDULE is what the Starlink app calls "searching".
export const OUTAGE_CAUSES = {
  0: 'unknown',
  1: 'booting',
  2: 'stowed',
  3: 'thermal_shutdown',
  4: 'searching',
  5: 'no_sats',
  6: 'obstructed',
  7: 'no_downlink',
  8: 'no_pings',
  9: 'actuator_activity',
  10: 'cable_test',
  11: 'sleeping',
  13: 'sky_search',
  14: 'inhibit_rf',
};

// SoftwareUpdateState.
const SOFTWARE_UPDATE_STATES = {
  0: 'unknown',
  1: 'idle',
  2: 'fetching',
  3: 'pre_check',
  4: 'writing',
  5: 'post_check',
  6: 'reboot_required',
  7: 'disabled',
  8: 'faulted',
};

// DishConfig.
const CONFIG = { SNOW_MELT_MODE: 1, APPLY_SNOW_MELT_MODE: 1001 };
export const SNOW_MELT_MODES = ['auto', 'always_on', 'always_off']; // enum values 0, 1, 2

// DishGetHistoryResponse.
const HISTORY = {
  CURRENT: 1,
  POP_PING_DROP_RATE: 1001,
  POP_PING_LATENCY_MS: 1002,
  DOWNLINK_THROUGHPUT_BPS: 1003,
  UPLINK_THROUGHPUT_BPS: 1004,
  POWER_IN: 1010,
};

// --- Requests -----------------------------------------------------------------

const request = (field, body = []) => encode([[field, 'message', body]]);

export const requests = {
  getStatus: () => request(REQUEST.GET_STATUS),
  getHistory: () => request(REQUEST.GET_HISTORY),
  getConfig: () => request(REQUEST.DISH_GET_CONFIG),
  reboot: () => request(REQUEST.REBOOT),
  /** @param {boolean} unstow false: stow (the dish folds flat), true: unstow */
  // proto3 leaves default values (false, 0) off the wire, like the app does.
  stow: (unstow) => request(REQUEST.DISH_STOW, [[1, 'bool', unstow || undefined]]),
  /** @param {string} mode one of SNOW_MELT_MODES */
  setSnowMeltMode(mode) {
    const value = SNOW_MELT_MODES.indexOf(mode);
    if (value < 0) {
      throw new Error(`Unknown snow melt mode: ${mode}`);
    }
    // The dish only applies the settings flagged by their apply_* field.
    return request(REQUEST.DISH_SET_CONFIG, [
      [
        1,
        'message',
        [
          [CONFIG.SNOW_MELT_MODE, 'varint', value || undefined],
          [CONFIG.APPLY_SNOW_MELT_MODE, 'bool', true],
        ],
      ],
    ]);
  },
};

// --- Responses ----------------------------------------------------------------

/**
 * Decode a Response and return the requested oneof member. The dish answers
 * an unsupported request with an empty Response or a Status error.
 * @param {Buffer} bytes
 * @param {number} field one of RESPONSE
 * @returns {Message}
 */
export function responseMember(bytes, field) {
  const response = Message.decode(bytes);
  const status = response.message(RESPONSE.STATUS);
  if (status.int(1) !== 0) {
    throw new Error(`Dish error ${status.int(1)}: ${status.string(2) || 'no message'}`);
  }
  if (!response.has(field)) {
    throw new Error('The device answered without the expected data: not a Starlink dish?');
  }
  return response.message(field);
}

const snowMeltMode = (config) => SNOW_MELT_MODES[config.uint(CONFIG.SNOW_MELT_MODE)] ?? null;

/**
 * DishGetStatusResponse → plain object.
 * @param {Message} status
 */
export function parseStatus(status) {
  const info = status.message(STATUS.DEVICE_INFO);
  const obstruction = status.message(STATUS.OBSTRUCTION_STATS);
  const alertsMessage = status.message(STATUS.ALERTS);
  const alerts = {};
  for (const [name, field] of Object.entries(ALERT_FIELDS)) {
    alerts[name] = alertsMessage.bool(field);
  }
  let state = 'connected';
  let outageDurationS = null;
  if (status.has(STATUS.OUTAGE)) {
    const outage = status.message(STATUS.OUTAGE);
    const cause = outage.uint(1);
    state = OUTAGE_CAUSES[cause] ?? 'unknown';
    outageDurationS = outage.uint(3) / 1e9;
  }
  return {
    id: info.string(1),
    hardwareVersion: info.string(2),
    softwareVersion: info.string(3),
    state,
    outageDurationS,
    uptimeS: status.message(STATUS.DEVICE_STATE).uint(1),
    dropRate: status.float(STATUS.POP_PING_DROP_RATE),
    latencyMs: status.float(STATUS.POP_PING_LATENCY_MS),
    downlinkBps: status.float(STATUS.DOWNLINK_THROUGHPUT_BPS),
    uplinkBps: status.float(STATUS.UPLINK_THROUGHPUT_BPS),
    fractionObstructed: obstruction.float(OBSTRUCTION.FRACTION_OBSTRUCTED),
    currentlyObstructed: obstruction.bool(OBSTRUCTION.CURRENTLY_OBSTRUCTED),
    alerts,
    softwareUpdateState:
      SOFTWARE_UPDATE_STATES[status.uint(STATUS.SOFTWARE_UPDATE_STATE)] ?? 'unknown',
    // Recent firmware embeds the configuration in the status; older ones
    // need a dish_get_config request (null here).
    snowMeltMode: status.has(STATUS.CONFIG) ? snowMeltMode(status.message(STATUS.CONFIG)) : null,
  };
}

/** DishGetConfigResponse → snow melt mode. */
export const parseConfig = (config) => ({ snowMeltMode: snowMeltMode(config.message(1)) });

/** DishSetConfigResponse: `error` (field 2) is set when the dish refused. */
export function checkSetConfig(response) {
  const error = response.string(2);
  if (error) {
    throw new Error(`The dish refused the setting: ${error}`);
  }
}

/**
 * DishGetHistoryResponse → ring buffers. `current` counts the samples written
 * since boot (one per second); the sample of counter c is at index
 * c % length of each buffer.
 * @param {Message} history
 */
export const parseHistory = (history) => ({
  current: history.uint(HISTORY.CURRENT),
  dropRate: history.floats(HISTORY.POP_PING_DROP_RATE),
  latencyMs: history.floats(HISTORY.POP_PING_LATENCY_MS),
  downlinkBps: history.floats(HISTORY.DOWNLINK_THROUGHPUT_BPS),
  uplinkBps: history.floats(HISTORY.UPLINK_THROUGHPUT_BPS),
  powerW: history.floats(HISTORY.POWER_IN),
});

const mean = (values) =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Average the samples of the last poll period — what happened between two
 * polls, rather than the single one-second sample the status carries. At
 * least the last `window` samples (a poll forced moments after another still
 * averages a whole period), more when the previous poll is older (the
 * samples since its counter `since`), never more than the buffer holds. The
 * latency only counts the samples whose pings were not all lost, like the
 * Starlink app.
 * @param {ReturnType<typeof parseHistory>} history
 * @param {{ since?: number | null, window: number }} options
 * @returns {{ samples: number, end: number, dropRate: number | null,
 *   latencyMs: number | null, downlinkBps: number | null,
 *   uplinkBps: number | null, powerW: number | null }}
 */
export function summarizeHistory(history, { since = null, window }) {
  const size = history.dropRate.length;
  const end = history.current;
  const available = Math.min(size, end);
  // A counter lower than the previous one: the dish rebooted in between.
  const elapsed = since !== null && since <= end ? end - since : 0;
  const count = Math.min(available, Math.max(window, elapsed));
  const pick = (buffer) => {
    if (buffer.length !== size || count <= 0) {
      return [];
    }
    const values = [];
    for (let counter = end - count; counter < end; counter += 1) {
      values.push(buffer[counter % size]);
    }
    return values;
  };
  const drops = pick(history.dropRate);
  const latencies = pick(history.latencyMs).filter(
    (value, index) => drops[index] < 1 && Number.isFinite(value),
  );
  const finite = (values) => values.filter(Number.isFinite);
  return {
    samples: drops.length,
    end,
    dropRate: mean(drops),
    latencyMs: mean(latencies),
    downlinkBps: mean(finite(pick(history.downlinkBps))),
    uplinkBps: mean(finite(pick(history.uplinkBps))),
    powerW: mean(finite(pick(history.powerW))),
  };
}
