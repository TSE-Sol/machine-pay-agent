// PLAN: choose a charger and a session length.
//
// Two planners return the same shape, { deviceId, minutes, reason }:
//   - claude: an LLM (Anthropic API) picks via a tool call, when ANTHROPIC_API_KEY is set
//   - rules:  a deterministic fallback, used when there is no key or the LLM call fails
// A plan is only a proposal. guardrails.js decides whether any money moves.
import Anthropic from "@anthropic-ai/sdk";
import { SESSION_MINUTES } from "./config.js";

/** Deterministic planner: nearest idle charger, smallest session that reaches the target battery. */
export function planWithRules({ robot, chargers, budgetLeftUsdc, targetBatteryPct, chargePctPerMinute }) {
  const idle = chargers.filter((c) => c.status === "idle").sort((a, b) => a.distanceKm - b.distanceKm);
  if (idle.length === 0) return null;
  const charger = idle[0];

  const affordable = SESSION_MINUTES.filter((minutes) => charger.priceUsdc[minutes] <= budgetLeftUsdc);
  const needed = targetBatteryPct - robot.batteryPct;
  const minutes =
    affordable.find((m) => m * chargePctPerMinute >= needed) ?? // smallest session that reaches the target
    affordable.at(-1) ?? // otherwise the longest one the budget allows
    SESSION_MINUTES[0]; // nothing affordable: propose the smallest and let the guardrails refuse it

  const reaches = Math.min(100, Math.round(robot.batteryPct + minutes * chargePctPerMinute));
  return {
    deviceId: charger.id,
    minutes,
    reason: `nearest idle dock, ${charger.distanceKm.toFixed(1)} km; ${minutes} min reaches ${reaches}%`,
  };
}

const SYSTEM_PROMPT = `You plan charging stops for an autonomous delivery robot that buys its own power.

The robot's battery is low. Choose one charger and one session length, then call the choose_charger tool exactly once with your choice.

How to choose well:
- Only idle chargers can be used.
- Closer is better: the robot spends battery getting there.
- Buy the shortest session that brings the battery up to the target level. Longer sessions cost more and the robot can always buy again later.
- Stay within the remaining budget.

Your choice is a proposal. A separate safety layer checks the real price and the spending limits before any payment is made, so you do not need to hedge or add warnings. Keep "reason" to one short phrase (under 15 words); it is printed in the robot's log.`;

let anthropic = null;

/** LLM planner. Throws if the call fails or the model doesn't call the tool. */
export async function planWithClaude(input, { apiKey, model }) {
  anthropic ??= new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
  const idleIds = input.chargers.filter((c) => c.status === "idle").map((c) => c.id);

  const response = await anthropic.messages.create({
    model,
    max_tokens: 16000,
    output_config: { effort: "low" }, // a small, well-specified decision
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: "choose_charger",
        description: "Record the chosen charger and session length for this charging stop.",
        strict: true, // the API guarantees the input matches this schema
        input_schema: {
          type: "object",
          properties: {
            deviceId: { type: "string", enum: idleIds, description: "id of the chosen idle charger" },
            minutes: { type: "integer", enum: SESSION_MINUTES, description: "session length in minutes" },
            reason: { type: "string", description: "one short phrase explaining the choice" },
          },
          required: ["deviceId", "minutes", "reason"],
          additionalProperties: false,
        },
      },
    ],
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          robot: { batteryPct: input.robot.batteryPct, location: input.robot.location },
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

/** Is this a usable plan? Checked in code, whichever planner produced it. */
function isValidPlan(plan, chargers) {
  return (
    plan !== null &&
    typeof plan === "object" &&
    chargers.some((c) => c.id === plan.deviceId && c.status === "idle") &&
    SESSION_MINUTES.includes(plan.minutes) &&
    typeof plan.reason === "string"
  );
}

/**
 * Returns { planner: "claude" | "rules", deviceId, minutes, reason, note? },
 * or null if no charger is idle. `note` says why the rules planner was used.
 */
export async function makePlan(input, { apiKey, model, llm = planWithClaude }) {
  const useRules = (note) => {
    const plan = planWithRules(input);
    return plan && { planner: "rules", ...plan, note };
  };

  if (!apiKey) return useRules("no ANTHROPIC_API_KEY set");
  try {
    const plan = await llm(input, { apiKey, model });
    if (!isValidPlan(plan, input.chargers)) return useRules("claude returned an unusable plan");
    return { planner: "claude", deviceId: plan.deviceId, minutes: plan.minutes, reason: plan.reason };
  } catch (error) {
    const why = error instanceof Anthropic.AuthenticationError ? "ANTHROPIC_API_KEY was rejected" : error.message;
    return useRules(`claude call failed: ${why}`);
  }
}
