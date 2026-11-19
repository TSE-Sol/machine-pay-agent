// PLAN: choose a charger and a session length.
//
// Chargers can be busy, so the planner weighs its options: drive to a free charger (possibly a
// farther one), or wait for a closer one that is in use. It never picks a charger the robot
// cannot reach on its remaining battery.
//
// Two planners return the same shape, { action: "charge" | "wait", deviceId, minutes, reason }:
//   - claude: an LLM (Anthropic API) picks via a tool call, when ANTHROPIC_API_KEY is set
//   - rules:  a deterministic fallback, used when there is no key or the LLM call fails
// A plan is only a proposal. guardrails.js decides whether any money moves.
import Anthropic from "@anthropic-ai/sdk";
import { SESSION_MINUTES } from "./config.js";

/** The robot must arrive with at least this much battery for a charger to count as reachable. */
export const MIN_ARRIVAL_BATTERY_PCT = 1;

const round1 = (value) => Math.round(value * 10) / 10;
/** "Congress Ave Robot Dock" -> "Congress Ave" */
const shortName = (name) => String(name).replace(/\s+(Robot Dock|Charging Bay|Dock|Bay)$/i, "");
/** Discovery says "idle", "in_use" or "charging_<robot>"; only idle chargers are free. */
const isFree = (status) => status === "idle";

/**
 * The options the planner weighs: one entry per charger, with what the drive would cost.
 *   chargers: [{ id, name, status, minutesUntilFree, distanceKm, priceUsdc }] (distance along the streets)
 *   drainPctPerKm: battery the drive costs per km
 *   waitDrainPctPerMinute: battery lost per simulated minute while standing and waiting
 * Each option gets:
 *   free, drainToReachPct, batteryOnArrivalPct, reachable
 *   ifWait (busy chargers only): { batteryOnArrivalPct, reachable } after waiting minutesUntilFree
 */
export function chargerOptions({ batteryPct, chargers, drainPctPerKm = 0, waitDrainPctPerMinute = 0 }) {
  return chargers.map((charger) => {
    const free = isFree(charger.status);
    const minutesUntilFree = free ? 0 : Math.max(0, Number(charger.minutesUntilFree) || 0);
    const drain = charger.distanceKm * drainPctPerKm;
    const onArrival = batteryPct - drain;
    const option = {
      id: charger.id,
      name: charger.name,
      status: charger.status,
      free,
      minutesUntilFree,
      distanceKm: Number(charger.distanceKm.toFixed(2)),
      drainToReachPct: round1(drain),
      batteryOnArrivalPct: round1(onArrival),
      reachable: onArrival >= MIN_ARRIVAL_BATTERY_PCT,
      priceUsdc: charger.priceUsdc,
    };
    if (!free) {
      const afterWait = onArrival - minutesUntilFree * waitDrainPctPerMinute;
      option.ifWait = { batteryOnArrivalPct: round1(afterWait), reachable: afterWait >= MIN_ARRIVAL_BATTERY_PCT };
    }
    return option;
  });
}

/** What the planner may pick: a free charger in reach (charge), or a busy one still in reach after the wait (wait). */
const canChargeAt = (option) => option.free && option.reachable;
const canWaitFor = (option) => !option.free && option.ifWait?.reachable === true;

/**
 * Deterministic planner:
 *   1. the nearest free charger the robot can reach, with the smallest session that reaches the target battery;
 *   2. otherwise wait for whichever busy charger frees soonest, if the robot can still reach it after the wait;
 *   3. otherwise nothing (null): no charger is in reach.
 * `chargers` are the options from chargerOptions().
 */
export function planWithRules({ chargers, budgetLeftUsdc, targetBatteryPct, chargePctPerMinute }) {
  const sessionFor = (charger, arrivalPct) => {
    const affordable = SESSION_MINUTES.filter((minutes) => charger.priceUsdc[minutes] <= budgetLeftUsdc);
    const needed = targetBatteryPct - arrivalPct;
    return (
      affordable.find((m) => m * chargePctPerMinute >= needed) ?? // smallest session that reaches the target
      affordable.at(-1) ?? // otherwise the longest one the budget allows
      SESSION_MINUTES[0] // nothing affordable: propose the smallest and let the guardrails refuse it
    );
  };
  const byDistance = (a, b) => a.distanceKm - b.distanceKm;

  const charger = chargers.filter(canChargeAt).sort(byDistance)[0];
  if (charger) {
    const minutes = sessionFor(charger, charger.batteryOnArrivalPct);
    const arrives = Math.floor(charger.batteryOnArrivalPct);
    const reaches = Math.min(100, Math.round(charger.batteryOnArrivalPct + minutes * chargePctPerMinute));
    const closerButBusy = chargers.filter((c) => !c.free && c.distanceKm < charger.distanceKm).sort(byDistance)[0];
    const reason = closerButBusy
      ? `${shortName(closerButBusy.name)} busy ${closerButBusy.minutesUntilFree} min; ${shortName(charger.name)} is free and reachable at ${arrives}%`
      : `nearest free dock, ${charger.distanceKm.toFixed(1)} km, reachable at ${arrives}%; ${minutes} min reaches ${reaches}%`;
    return { action: "charge", deviceId: charger.id, minutes, reason };
  }

  const soonest = chargers.filter(canWaitFor).sort((a, b) => a.minutesUntilFree - b.minutesUntilFree || byDistance(a, b))[0];
  if (soonest) {
    return {
      action: "wait",
      deviceId: soonest.id,
      minutes: sessionFor(soonest, soonest.ifWait.batteryOnArrivalPct),
      reason: `no free charger in reach; ${shortName(soonest.name)} frees soonest, in ${soonest.minutesUntilFree} min, and is reachable at ${Math.floor(soonest.ifWait.batteryOnArrivalPct)}% after the wait`,
    };
  }
  return null;
}

const SYSTEM_PROMPT = `You plan charging stops for an autonomous delivery robot that buys its own power.

The robot's battery is low and it is standing still, looking for a charger. Some chargers may be in use by other robots. Decide what the robot does now, then call the choose_charger tool exactly once.

You have two kinds of move:
- action "charge": drive to a charger that is free right now and buy a session there.
- action "wait": stay where it is and wait for a charger that is in use to become free. Nothing is bought. The robot asks you again in a few minutes with fresh information.

What the numbers mean (every charger in the input carries them):
- distanceKm is the drive along the streets. drainToReachPct is the battery that drive costs, and batteryOnArrivalPct is what would be left on arrival if the robot left now.
- reachable says whether it can get there at all. A robot that runs flat on the way is stranded and a person has to go and recover it, so never choose a charger whose reachable is false.
- For a charger in use, minutesUntilFree is how long until the other robot leaves. Waiting costs battery too (robot.drainPctPerMinuteWhileWaiting), so ifWait gives the battery the robot would arrive with after waiting that long, and whether it would still make it. Only wait for a charger whose ifWait.reachable is true.

How to choose well:
- Arriving with more battery is safer, and a shorter drive means less time away from deliveries. Weigh a farther free charger against waiting for a closer busy one by comparing what the robot would arrive with and how long each option takes.
- A short wait for a much closer charger can be worth it. A long wait rarely is, because the battery keeps falling while the robot stands there.
- For the session, buy the shortest one that brings the battery from its arrival level up to the target. Longer sessions cost more and the robot can buy again later. Stay within the remaining budget. If you choose to wait, give the session you expect to buy once the charger is free.

Your choice is a proposal. A separate safety layer checks the real price and the spending limits before any payment is made, so you do not need to hedge or add warnings.

"reason" is printed in the robot's log and read out to an audience. Keep it to one short sentence of at most 20 words that names what you weighed, for example: "Congress Ave busy 12 min; East 6th is free and reachable at 4%."`;

let anthropic = null;

/** LLM planner. Throws if the call fails or the model doesn't call the tool. */
export async function planWithClaude(input, { apiKey, model }) {
  anthropic ??= new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
  const eligibleIds = input.chargers.filter((c) => canChargeAt(c) || canWaitFor(c)).map((c) => c.id);

  const response = await anthropic.messages.create({
    model,
    max_tokens: 16000,
    output_config: { effort: "low" }, // a small, well-specified decision
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: "choose_charger",
        description: "Record the decision for this charging stop: drive to a free charger and buy a session, or wait for a busy one.",
        strict: true, // the API guarantees the input matches this schema
        input_schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["charge", "wait"], description: "charge: go to a free charger now. wait: stay put until a busy charger frees up" },
            deviceId: { type: "string", enum: eligibleIds, description: "id of the charger to drive to (charge) or to wait for (wait)" },
            minutes: { type: "integer", enum: SESSION_MINUTES, description: "session length to buy, in minutes" },
            reason: { type: "string", description: "one short sentence naming what was weighed" },
          },
          required: ["action", "deviceId", "minutes", "reason"],
          additionalProperties: false,
        },
      },
    ],
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          robot: {
            batteryPct: input.robot.batteryPct,
            drainPctPerKm: input.drainPctPerKm ?? 0,
            drainPctPerMinuteWhileWaiting: input.waitDrainPctPerMinute ?? 0,
          },
          minBatteryOnArrivalPct: MIN_ARRIVAL_BATTERY_PCT,
          targetBatteryPct: input.targetBatteryPct,
          batteryGainPctPerMinute: input.chargePctPerMinute,
          budgetLeftUsdc: input.budgetLeftUsdc,
          chargers: input.chargers,
        }),
      },
    ],
  });

  if (response.stop_reason === "refusal") throw new Error("the model declined to answer");
  const call = response.content.find((block) => block.type === "tool_use" && block.name === "choose_charger");
  if (!call) throw new Error("the model did not call choose_charger");
  return call.input;
}

/**
 * Is this a usable plan? Checked in code, whichever planner produced it: the robot only drives
 * to a charger that is free and in reach, and only waits for a busy one it can still reach
 * after the wait.
 */
function isValidPlan(plan, chargers) {
  if (plan === null || typeof plan !== "object") return false;
  const charger = chargers.find((c) => c.id === plan.deviceId);
  const action = plan.action ?? "charge";
  return (
    charger !== undefined &&
    ((action === "charge" && canChargeAt(charger)) || (action === "wait" && canWaitFor(charger))) &&
    SESSION_MINUTES.includes(plan.minutes) &&
    typeof plan.reason === "string"
  );
}

/**
 * input.chargers are the options from chargerOptions().
 * Returns { planner: "claude" | "rules", action: "charge" | "wait", deviceId, minutes, reason, note? },
 * or null if no charger can be used (none free in reach, and none worth waiting for).
 * `note` says why the rules planner was used.
 */
export async function makePlan(input, { apiKey, model, llm = planWithClaude }) {
  const useRules = (note) => {
    const plan = planWithRules(input);
    return plan && { planner: "rules", ...plan, note };
  };

  if (!input.chargers.some((c) => canChargeAt(c) || canWaitFor(c))) return null; // nothing to choose between
  if (!apiKey) return useRules("no ANTHROPIC_API_KEY set");
  try {
    const plan = await llm(input, { apiKey, model });
    if (!isValidPlan(plan, input.chargers)) return useRules("claude returned an unusable plan");
    return { planner: "claude", action: plan.action ?? "charge", deviceId: plan.deviceId, minutes: plan.minutes, reason: plan.reason };
  } catch (error) {
    const why = error instanceof Anthropic.AuthenticationError ? "ANTHROPIC_API_KEY was rejected" : error.message;
    return useRules(`claude call failed: ${why}`);
  }
}
