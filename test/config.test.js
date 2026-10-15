import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseAddress, pollFrequencyMs } from '../src/config.js';

test('the defaults: the dish address of every Starlink network, 30 s, French', () => {
  assert.deepEqual(normalizeConfig(), {
    host: '192.168.100.1',
    port: 9200,
    invalidHost: null,
    pollIntervalS: 30,
    language: 'fr',
    allowPowerCommands: false,
  });
  assert.deepEqual(normalizeConfig({ host: '   ' }).host, '192.168.100.1', 'blank: the default');
  assert.equal(DEFAULT_CONFIG.allow_power_commands, false);
});

test('addresses: IPv4, names, ports, pasted URLs', () => {
  assert.deepEqual(parseAddress('192.0.2.10'), { host: '192.0.2.10', port: 9200 });
  assert.deepEqual(parseAddress('192.0.2.10:9201'), { host: '192.0.2.10', port: 9201 });
  assert.deepEqual(parseAddress('http://192.0.2.10:9200/status'), {
    host: '192.0.2.10',
    port: 9200,
  });
  assert.deepEqual(parseAddress(' Dishy.Example.org '), { host: 'dishy.example.org', port: 9200 });
  for (const invalid of ['', '300.1.1.1', '192.168.100', '192.0.2.1:70000', 'not an address!']) {
    assert.equal(parseAddress(invalid), null, invalid);
  }
  const config = normalizeConfig({ host: '300.1.1.1' });
  assert.equal(config.host, null);
  assert.equal(config.invalidHost, '300.1.1.1');
});

test('the refresh interval is one Gladys accepts as a poll frequency', () => {
  assert.equal(normalizeConfig({ poll_interval: '10' }).pollIntervalS, 10);
  assert.equal(normalizeConfig({ poll_interval: 60 }).pollIntervalS, 60);
  assert.equal(normalizeConfig({ poll_interval: '5' }).pollIntervalS, 30);
  for (const interval of ['10', '15', '30', '60']) {
    assert.equal(pollFrequencyMs(normalizeConfig({ poll_interval: interval })), interval * 1000);
  }
});

test('the commands that cut the Internet need an explicit true', () => {
  assert.equal(normalizeConfig({ allow_power_commands: 'true' }).allowPowerCommands, false);
  assert.equal(normalizeConfig({ allow_power_commands: true }).allowPowerCommands, true);
  assert.equal(normalizeConfig({ language: 'it' }).language, 'fr');
});
