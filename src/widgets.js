// -----------------------------------------------------------------------------
// The dashboard widget: the dish at a glance — state, latency, throughput,
// obstruction, active alerts. Pure builders: the data comes from the last
// reading of the poller.
//
// The core's budget (8 components, 6 tiles, 1 status, 2 texts) is applied
// before the device references are resolved: this content stays well under.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { FEATURE, measures } from './dish.js';
import { ALERTS, SNOW_MELT, STATES, WIDGET_TEXT } from './i18n.js';
import { LANGUAGES } from './config.js';

export const WIDGET = { STATUS: 'dish_status' };

// A status value holds 40 characters.
const MAX_STATUS_VALUE = 40;

/** The color of a state: green when connected, red when down, orange between. */
function stateColor(state) {
  if (state === 'connected') {
    return WIDGET_COLORS.SUCCESS;
  }
  if (['unreachable', 'thermal_shutdown', 'no_downlink', 'no_pings', 'unknown'].includes(state)) {
    return WIDGET_COLORS.DANGER;
  }
  return WIDGET_COLORS.WARNING;
}

/** The active alerts, by name, as many as 40 characters hold. */
export function alertSummary(alerts, language) {
  const names = Object.entries(ALERTS[language])
    .filter(([key]) => alerts[key])
    .map(([, name]) => name);
  const unnamed = Object.entries(alerts).filter(
    ([key, active]) => active && !(key in ALERTS[language]),
  ).length;
  const text = WIDGET_TEXT[language];
  if (names.length === 0 && unnamed === 0) {
    return { value: text.none, color: WIDGET_COLORS.SUCCESS };
  }
  const shown = [];
  for (const name of names) {
    const rest = names.length + unnamed - shown.length - 1;
    const candidate = [...shown, name].join(', ');
    const suffix = rest > 0 ? ` ${text.more(rest)}` : '';
    if ((candidate + suffix).length > MAX_STATUS_VALUE) {
      break;
    }
    shown.push(name);
  }
  const rest = names.length + unnamed - shown.length;
  const value = [shown.join(', '), rest > 0 ? text.more(rest) : '']
    .filter(Boolean)
    .join(' ')
    .slice(0, MAX_STATUS_VALUE);
  return { value, color: WIDGET_COLORS.WARNING };
}

function uptimeText(seconds, language) {
  const hours = seconds / 3600;
  const text = WIDGET_TEXT[language];
  return hours < 48 ? text.hours(Math.floor(hours)) : text.days(Math.floor(hours / 24));
}

/**
 * @param {object} options
 * @param {boolean} options.configured a valid dish address is configured
 * @param {{ status: object, summary: object | null, snowMeltMode: string | null } | null} options.reading
 *   the last reading of the dish, null before the first one
 * @param {string | null} options.state the current state ("unreachable" when the dish stopped answering)
 * @param {{ feature: (key: string) => string } | null} options.ids the device ids
 *   when the dish is added to Gladys (live tiles), else null
 * @param {string} options.language the language of the dashboard
 * @param {number} options.ttlSeconds
 */
export function buildStatusContent({ configured, reading, state, ids, language, ttlSeconds }) {
  const lang = LANGUAGES.includes(language) ? language : 'en';
  const text = WIDGET_TEXT[lang];
  const ttl = Math.min(3600, Math.max(10, ttlSeconds));
  if (!configured) {
    return { ttl_seconds: ttl, components: [{ type: 'text', text: text.notConfigured }] };
  }
  if (!reading) {
    return { ttl_seconds: ttl, components: [{ type: 'text', text: text.waiting }] };
  }

  const { status, summary, snowMeltMode } = reading;
  const values = measures(status, summary);
  const tile = (key, label, icon, value, unit) =>
    ids
      ? { type: 'value', label, icon, device_feature: ids.feature(key) }
      : { type: 'value', label, icon, value: value ?? '-', unit };

  const currentState = state ?? status.state;
  const items = [
    {
      label: text.state,
      value: STATES[lang][currentState] ?? currentState,
      color: stateColor(currentState),
    },
    { label: text.alerts, ...alertSummary(status.alerts, lang) },
  ];
  if (snowMeltMode) {
    items.push({
      label: text.snowMelt,
      value: SNOW_MELT[lang][snowMeltMode],
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  if (currentState !== 'unreachable') {
    items.push({
      label: text.uptime,
      value: uptimeText(status.uptimeS, lang),
      color: WIDGET_COLORS.NEUTRAL,
    });
  }

  return {
    ttl_seconds: ttl,
    components: [
      tile(FEATURE.LATENCY, text.latency, 'activity', values.latencyMs, 'ms'),
      tile(FEATURE.DOWNLOAD, text.download, 'download', values.downloadMbps, 'Mbit/s'),
      tile(FEATURE.UPLOAD, text.upload, 'upload', values.uploadMbps, 'Mbit/s'),
      tile(
        FEATURE.OBSTRUCTION,
        text.obstruction,
        'cloud',
        Math.round(status.fractionObstructed * 1000) / 10,
        '%',
      ),
      { type: 'status', items },
    ],
  };
}
