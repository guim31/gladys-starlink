// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

import { DEVICE_POLL_FREQUENCIES } from '@gladysassistant/integration-sdk';
import { DEFAULT_PORT } from './starlink/schema.js';

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// The refresh intervals offered, in seconds: the ones Gladys accepts as a
// device poll frequency (10 s to 1 min), so the fallback onPoll keeps pace.
export const POLL_INTERVALS = ['10', '15', '30', '60'];

export const DEFAULT_CONFIG = {
  host: '192.168.100.1',
  poll_interval: '30',
  language: 'fr',
  allow_power_commands: false,
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * Parse the address typed by the user: an IP or a name, an optional port
 * (9200 by default). Users paste URLs: the scheme and path are dropped.
 * @param {unknown} raw
 * @returns {{ host: string, port: number } | null} null when invalid
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '');
  if (!text) {
    return null;
  }
  const match = text.match(/^(.*?)(?::(\d{1,5}))?$/);
  const host = match[1].toLowerCase();
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (port < 1 || port > 65535) {
    return null;
  }
  const ipv4 = host.match(IPV4);
  if (ipv4) {
    return ipv4.slice(1).every((part) => Number(part) <= 255) ? { host, port } : null;
  }
  // Digits and dots only: a mistyped address, not a name.
  if (/^[\d.]+$/.test(host) || !HOSTNAME.test(host)) {
    return null;
  }
  return { host, port };
}

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const typed = typeof source.host === 'string' && source.host.trim() !== '';
  const address = parseAddress(typed ? source.host : DEFAULT_CONFIG.host);
  const interval = String(source.poll_interval ?? DEFAULT_CONFIG.poll_interval);
  return {
    host: address?.host ?? null,
    port: address?.port ?? DEFAULT_PORT,
    // The typed text, for the message that says it is invalid.
    invalidHost: address ? null : String(source.host),
    pollIntervalS: Number(
      POLL_INTERVALS.includes(interval) ? interval : DEFAULT_CONFIG.poll_interval,
    ),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
    // Rebooting or stowing the dish cuts the Internet access: opt-in only.
    allowPowerCommands: source.allow_power_commands === true,
  };
}

/** The device poll frequency (ms) matching the configured interval. */
export function pollFrequencyMs(config) {
  const ms = config.pollIntervalS * 1000;
  return Object.values(DEVICE_POLL_FREQUENCIES).includes(ms)
    ? ms
    : DEVICE_POLL_FREQUENCIES.EVERY_30_SECONDS;
}
