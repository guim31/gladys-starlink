#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Probe a real Starlink dish with the integration's own client, read only.
//
//   node scripts/probe.mjs [address]        (default 192.168.100.1:9200)
//
// Sends get_status, get_history and dish_get_config — never a reboot, stow or
// setting — and prints what the integration would make of the answers. The
// dish serial and the GPS figures are not printed: the output can be pasted
// in an issue as is. Field numbers the integration does not read are listed,
// so a firmware change shows up.
// -----------------------------------------------------------------------------

import { unaryCall } from '../src/starlink/grpc.js';
import { Message } from '../src/starlink/protobuf.js';
import {
  GRPC_PATH,
  RESPONSE,
  parseConfig,
  parseHistory,
  parseStatus,
  requests,
  responseMember,
  summarizeHistory,
} from '../src/starlink/schema.js';
import { parseAddress } from '../src/config.js';
import { measures } from '../src/dish.js';

const address = parseAddress(process.argv[2] ?? '192.168.100.1');
if (!address) {
  console.error(`Invalid address: ${process.argv[2]}`);
  process.exit(2);
}
const { host, port } = address;

// The status fields the integration reads (src/starlink/schema.js).
const READ_STATUS_FIELDS = new Set([1, 2, 1003, 1004, 1005, 1007, 1008, 1009, 1014, 1021, 2000]);

async function call(name, message, field) {
  const started = Date.now();
  try {
    const bytes = await unaryCall({ host, port, path: GRPC_PATH, message, timeoutMs: 5000 });
    console.log(`✔ ${name}: ${bytes.length} bytes in ${Date.now() - started} ms`);
    return { bytes, member: responseMember(bytes, field) };
  } catch (err) {
    console.log(`✘ ${name}: ${err.message}`);
    return null;
  }
}

console.log(`Probing the Starlink dish at ${host}:${port} (read only)\n`);

const statusAnswer = await call('get_status', requests.getStatus(), RESPONSE.DISH_GET_STATUS);
let status = null;
if (statusAnswer) {
  status = parseStatus(statusAnswer.member);
  const response = Message.decode(statusAnswer.bytes);
  console.log(`  api_version: ${response.uint(3)}`);
  console.log(
    `  dish id: ${status.id ? `${status.id.slice(0, 4)}… (${status.id.length} chars)` : 'none'}`,
  );
  console.log(`  hardware: ${status.hardwareVersion}, software: ${status.softwareVersion}`);
  console.log(
    `  state: ${status.state}${status.outageDurationS ? ` for ${status.outageDurationS} s` : ''}`,
  );
  console.log(`  uptime: ${(status.uptimeS / 3600).toFixed(1)} h`);
  console.log(
    `  instant: latency ${status.latencyMs.toFixed(1)} ms, loss ${(status.dropRate * 100).toFixed(1)} %, ` +
      `down ${(status.downlinkBps / 1e6).toFixed(2)} Mbit/s, up ${(status.uplinkBps / 1e6).toFixed(2)} Mbit/s`,
  );
  console.log(
    `  obstruction: ${(status.fractionObstructed * 100).toFixed(2)} %, now: ${status.currentlyObstructed}`,
  );
  const active = Object.entries(status.alerts)
    .filter(([, value]) => value)
    .map(([name]) => name);
  console.log(`  alerts: ${active.length ? active.join(', ') : 'none'}`);
  console.log(`  software update: ${status.softwareUpdateState}`);
  console.log(`  snow melt (from status): ${status.snowMeltMode ?? 'not in the status'}`);
  const unread = [...statusAnswer.member.fields.keys()].filter((n) => !READ_STATUS_FIELDS.has(n));
  console.log(
    `  status fields not read by the integration: ${unread.sort((a, b) => a - b).join(', ')}`,
  );
}

const historyAnswer = await call('get_history', requests.getHistory(), RESPONSE.DISH_GET_HISTORY);
if (historyAnswer) {
  const history = parseHistory(historyAnswer.member);
  console.log(
    `  counter: ${history.current}, buffers: drop ${history.dropRate.length}, latency ` +
      `${history.latencyMs.length}, down ${history.downlinkBps.length}, up ` +
      `${history.uplinkBps.length}, power ${history.powerW.length}`,
  );
  const summary = summarizeHistory(history, { window: 30 });
  console.log(
    `  last ${summary.samples} s: ${JSON.stringify(status ? measures(status, summary) : summary)}`,
  );
}

const configAnswer = await call('dish_get_config', requests.getConfig(), RESPONSE.DISH_GET_CONFIG);
if (configAnswer) {
  console.log(`  snow melt (from config): ${parseConfig(configAnswer.member).snowMeltMode}`);
}

process.exit(statusAnswer ? 0 : 1);
