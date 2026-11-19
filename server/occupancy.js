// "Other robots" using the chargers. Pure decisions only: which idle charger gets taken, and
// for how long. No timers and no state here; server/devices.js applies the decisions.
//
// Three modes (CHARGER_OCCUPANCY):
//   off    - nobody else ever uses a charger
//   random - every few simulated minutes each idle charger may be taken for 10 to 40 minutes
//   demo   - a predictable show for the stage: nothing is taken until the robot first looks
//            for a charger, then the charger nearest to it is found busy. After that the
//            same random rules apply, driven by a fixed seed, so every run plays alike.

export const OCCUPANCY_MODES = ["off", "random", "demo"];

/** All times are simulated minutes; the server scales them by DEMO_SECONDS_PER_MINUTE. */
export const OCCUPANCY = {
  checkEveryMinutes: 3, // how often an idle charger gets a chance to be taken
  startChance: 0.08, // the chance at each check (an idle charger stays idle about 35 minutes on average)
  minMinutes: 10,
  maxMinutes: 40,
  demoFirstBusyMinutes: 25, // long enough that waiting for it is clearly the worse choice
  demoSeed: 20261118,
};

/** A small seeded random number generator (mulberry32): the same seed gives the same sequence. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One occupancy check. `chargers` is [{ id, idle }] where idle means free for anyone right now
 * (not in use, not charging, not held for a robot that was just quoted a price).
 * Returns [{ id, minutes }]: the idle chargers other robots take now.
 * At least one charger is always left idle, so the three can never all be taken by others.
 */
export function pickOccupancies(chargers, { random = Math.random, rules = OCCUPANCY } = {}) {
  let idleLeft = chargers.filter((charger) => charger.idle).length;
  const taken = [];
  for (const charger of chargers) {
    if (!charger.idle) continue;
    const wanted = random() < rules.startChance;
    const minutes = Math.round(rules.minMinutes + random() * (rules.maxMinutes - rules.minMinutes));
    if (!wanted || idleLeft <= 1) continue;
    taken.push({ id: charger.id, minutes });
    idleLeft--;
  }
  return taken;
}

/**
 * Demo mode's opening move. `chargers` is [{ id, idle, meters }] with each charger's distance
 * from the robot that is looking for power. Returns { id, minutes } for the nearest charger
 * (if it is idle and another one would still be free), or null.
 */
export function demoOpening(chargers, { rules = OCCUPANCY } = {}) {
  const nearest = [...chargers].sort((a, b) => a.meters - b.meters)[0];
  if (!nearest?.idle) return null;
  if (chargers.filter((charger) => charger.idle).length <= 1) return null;
  return { id: nearest.id, minutes: rules.demoFirstBusyMinutes };
}
