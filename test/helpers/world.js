// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a fake dish on 127.0.0.1, and
// the integration wired on top through registerHandlers.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { normalizeConfig } from '../../src/config.js';
import { buildDevice } from '../../src/dish.js';
import { DISH_ID, createFakeDish } from './fakeDish.js';

// The integration logs its lifecycle; keep the test output readable
// (LOG_LEVEL is read on every log call). LOG_LEVEL=debug npm test shows them.
process.env.LOG_LEVEL ??= 'silent';

/**
 * @param {object} [options]
 * @param {object} [options.dishOptions] createFakeDish options
 * @param {object} [options.config] raw integration config (host: the fake dish)
 * @param {boolean} [options.create] add the discovered dish to Gladys, as the user would
 * @param {boolean} [options.precreated] the dish was added to Gladys before the start
 * @param {boolean} [options.timers] run the integration's polling timer
 * @param {() => number} [options.now]
 */
export async function createWorld({
  dishOptions = {},
  config = {},
  create = true,
  precreated = false,
  timers = false,
  now,
} = {}) {
  const dish = await createFakeDish(dishOptions);
  const devices = precreated
    ? [
        buildDevice(
          createFakeGladys(),
          { id: DISH_ID, hardwareVersion: 'rev3_proto2' },
          normalizeConfig({ host: dish.address, ...config }),
        ),
      ]
    : [];
  const gladys = createFakeGladys({ config: { host: dish.address, ...config }, devices });
  const app = registerHandlers(gladys, { timers, now });
  await gladys.connect();
  if (create && !precreated && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
  }
  return {
    dish,
    gladys,
    app,
    /** The discovered dish device (as published). */
    get device() {
      return gladys.fake.discoveredDevices[0];
    },
    /** The last value Gladys received for a feature key of the dish. */
    state(key) {
      return gladys.fake.lastState(`${gladys.fake.discoveredDevices[0].external_id}:${key}`);
    },
    async close() {
      app.stop();
      await dish.close();
    },
  };
}

const immediate = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Let the event loop run (I/O included) until `predicate` holds. setImmediate
 * only: the tests that mock setTimeout still get there.
 * @param {() => boolean} predicate
 */
export async function waitFor(predicate, what = 'condition') {
  for (let i = 0; i < 5000; i += 1) {
    if (predicate()) {
      return;
    }
    await immediate();
  }
  throw new Error(`waitFor: ${what} never happened`);
}
