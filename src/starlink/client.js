// -----------------------------------------------------------------------------
// The Starlink dish client: one method per operation, plain objects out.
// -----------------------------------------------------------------------------

import { unaryCall } from './grpc.js';
import {
  GRPC_PATH,
  RESPONSE,
  checkSetConfig,
  parseConfig,
  parseHistory,
  parseStatus,
  requests,
  responseMember,
} from './schema.js';

/**
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.connect] http2.connect, replaced by the tests
 */
export function createDishClient({ host, port, timeoutMs = 5000, connect }) {
  const call = async (message, field) => {
    const bytes = await unaryCall({ host, port, path: GRPC_PATH, message, timeoutMs, connect });
    return responseMember(bytes, field);
  };

  return {
    host,
    port,
    async getStatus() {
      return parseStatus(await call(requests.getStatus(), RESPONSE.DISH_GET_STATUS));
    },
    async getHistory() {
      return parseHistory(await call(requests.getHistory(), RESPONSE.DISH_GET_HISTORY));
    },
    async getConfig() {
      return parseConfig(await call(requests.getConfig(), RESPONSE.DISH_GET_CONFIG));
    },
    async reboot() {
      await call(requests.reboot(), RESPONSE.REBOOT);
    },
    /** @param {boolean} unstow */
    async stow(unstow) {
      await call(requests.stow(unstow), RESPONSE.DISH_STOW);
    },
    /** @param {'auto' | 'always_on' | 'always_off'} mode */
    async setSnowMeltMode(mode) {
      checkSetConfig(await call(requests.setSnowMeltMode(mode), RESPONSE.DISH_SET_CONFIG));
    },
  };
}
