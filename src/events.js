// -----------------------------------------------------------------------------
// From successive readings of a dish to scene events: "Starlink down",
// "Starlink back", "sky obstructed".
//
// The device features already hold the state; the events add what a state
// change cannot say:
//   - an outage is reported once it lasted a full poll period (two readings
//     in a row): the short drops a dish has every day stay out of the scenes;
//   - the dish no longer answering at all (power cut, cable) is an outage
//     too, with the cause "unreachable";
//   - the restore event carries how long the outage lasted;
//   - the obstruction event fires once per episode, at most every 10 minutes.
// Pure logic: the clock is passed in, nothing is published here.
// -----------------------------------------------------------------------------

export const SCENE_TRIGGER = {
  CONNECTION_LOST: 'connection_lost',
  CONNECTION_RESTORED: 'connection_restored',
  OBSTRUCTION_DETECTED: 'obstruction_detected',
};

// Readings in a row an outage must last before it is reported.
export const OUTAGE_CONFIRMATIONS = 2;
export const OBSTRUCTION_QUIET_MS = 10 * 60 * 1000;

export function createTracker() {
  // Up at least once since the integration started: an outage already under
  // way at startup (or a Gladys restart in the middle of one) is not news.
  let armed = false;
  let downReadings = 0;
  let downSince = null;
  let lostCause = null;
  let reported = false;
  let obstructed = null;
  let lastObstructionEventAt = -Infinity;

  return {
    /**
     * @param {object} observation
     * @param {boolean} observation.connected
     * @param {string} observation.cause the state, e.g. "obstructed", "unreachable"
     * @param {boolean | null} [observation.obstructed] null: unknown (no answer)
     * @param {number | null} [observation.obstructionPercent]
     * @param {number} observation.at epoch ms
     * @returns {Array<{ key: string, data: object }>} the events to fire
     */
    observe({ connected, cause, obstructed: nowObstructed = null, obstructionPercent = null, at }) {
      const events = [];
      if (connected) {
        if (reported) {
          events.push({
            key: SCENE_TRIGGER.CONNECTION_RESTORED,
            data: { cause: lostCause, outage_seconds: Math.round((at - downSince) / 1000) },
          });
        }
        armed = true;
        downReadings = 0;
        downSince = null;
        lostCause = null;
        reported = false;
      } else {
        downReadings += 1;
        downSince ??= at;
        if (armed && !reported && downReadings >= OUTAGE_CONFIRMATIONS) {
          reported = true;
          lostCause = cause;
          events.push({ key: SCENE_TRIGGER.CONNECTION_LOST, data: { cause } });
        }
      }

      if (nowObstructed !== null) {
        if (
          nowObstructed &&
          obstructed === false &&
          at - lastObstructionEventAt >= OBSTRUCTION_QUIET_MS
        ) {
          lastObstructionEventAt = at;
          events.push({
            key: SCENE_TRIGGER.OBSTRUCTION_DETECTED,
            data: { obstruction_percent: obstructionPercent },
          });
        }
        obstructed = nowObstructed;
      }
      return events;
    },

    /** Whether an outage was reported and is not over yet. */
    get outage() {
      return reported;
    },
  };
}
