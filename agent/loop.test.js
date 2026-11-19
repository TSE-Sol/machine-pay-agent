// End-to-end tests of the decision loop against a fake charger server.
// The fake server can lie in its 402 (wrong amount, wrong recipient); the tests
// prove the agent then signs nothing. No real wallet or network is used.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { AuditLog } from "./audit.js";
import { createChargerClient } from "./charger.js";
import { runCycle } from "./loop.js";
import { Robot } from "./robot.js";

const MERCHANT = "AsCyNEGaHqxeyoJQkW5AXdDeTJpN9SiPviWY8sNiVG5w";
const ATTACKER = "7cpH5zEAFUJTszSLXk3Uz5qedVkmxE2RJwbPHZbRM9hH";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// What the fake charger's 402 will claim. Tests change this to simulate an attack.
let quoteOverrides = {};
let quotesIssued = 0; // each 402 carries its number, so tests can tell which one was signed
let charging = false;
// The chargers the fake server advertises. Tests replace this to make some of them busy.
const ONE_IDLE_DOCK = [{ id: "charger-001", name: "Test Dock", location: { lat: 30.2682, lng: -97.7429 }, status: "idle", minutesUntilFree: 0 }];
let fleet = ONE_IDLE_DOCK;
let inUseAtTheDock = []; // ids that answer a charge request with 409, whatever discovery said
let chargeRequests = []; // every POST .../charge the server received: { id, paid }
let server;
let serverUrl;

before(async () => {
  server = createServer(async (req, res) => {
    let sent = "";
    for await (const chunk of req) sent += chunk;
    const minutes = sent ? (JSON.parse(sent).minutes ?? 15) : 15;
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const path = req.url.split("?")[0];
    const [, deviceId, action] = path.match(/^\/devices\/([\w-]+)\/(status|charge)$/) ?? [];
    if (req.method === "GET" && path === "/devices") {
      return json(200, fleet.map((device) => ({ type: "pay-to-power", pricePer15MinUSDC: 0.2, ...device })));
    }
    if (req.method === "GET" && action === "status") {
      return json(200, { id: deviceId, status: charging ? "charging" : "idle", sessionId: "s-1", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    if (req.method === "POST" && action === "charge") {
      chargeRequests.push({ id: deviceId, paid: Boolean(req.headers["payment-signature"]) });
      // A charger in use refuses before any payment is discussed: 409, never 402.
      const listed = fleet.find((device) => device.id === deviceId);
      if (inUseAtTheDock.includes(deviceId) || (listed && listed.status !== "idle")) {
        return json(409, { error: "charger_in_use", message: "charger in use" });
      }
      if (!req.headers["payment-signature"]) {
        const paymentRequired = {
          x402Version: 2,
          error: "Payment required",
          resource: { url: `${serverUrl}/devices/${deviceId}/charge`, description: "test", mimeType: "application/json" },
          accepts: [
            // 0.20 USDC per 15 minutes, as advertised in /devices.
            { scheme: "exact", network: DEVNET, asset: USDC, payTo: MERCHANT, amount: String(200_000 * (minutes / 15)), maxTimeoutSeconds: 60, extra: { quoteNumber: ++quotesIssued }, ...quoteOverrides },
          ],
        };
        return json(402, paymentRequired, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) });
      }
      charging = true;
      const receipt = { success: true, transaction: "FakeSignature1111111111111111111111111111111111", network: DEVNET, payer: "payer" };
      return json(200, { sessionId: "s-1" }, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(receipt) });
    }
    json(404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

/** A fresh low-battery robot, empty audit log and a wallet that counts how often it is asked to sign. */
function setup({ limits = {}, askHuman = async () => false, llm } = {}) {
  quoteOverrides = {};
  quotesIssued = 0;
  charging = false;
  fleet = ONE_IDLE_DOCK;
  inUseAtTheDock = [];
  chargeRequests = [];
  const wallet = {
    signCalls: 0,
    signedQuoteNumber: null,
    async signPayment(paymentRequired, requirement) {
      this.signCalls++;
      this.signedQuoteNumber = requirement.extra.quoteNumber;
      return { "PAYMENT-SIGNATURE": "fake-signed-payment" };
    },
  };
  const deps = {
    robot: new Robot({ id: "robot-test", location: { lat: 30.2747, lng: -97.7404 }, startBatteryPct: 15, drainPctPerSecond: 0, chargePctPerMinute: 2 }),
    config: { lowBatteryPct: 20, targetBatteryPct: 45, planner: { apiKey: llm ? "test-key" : "", model: "test-model" } },
    limits: {
      paused: false,
      maxPerTx: 1_000_000n,
      dailyBudget: 5_000_000n,
      approvalThreshold: 500_000n,
      maxPaymentsPer10Min: 5,
      allowedPayTo: [MERCHANT],
      allowedNetworks: [DEVNET],
      allowedAssets: [USDC],
      ...limits,
    },
    charger: createChargerClient(serverUrl),
    wallet,
    audit: new AuditLog(join(mkdtempSync(join(tmpdir(), "agent-test-")), "audit.log")),
    askHuman,
    log: () => {},
    llm,
  };
  return { deps, wallet };
}

describe("decision loop", () => {
  test("honest charger: pays once, verifies, and the robot starts charging", async () => {
    const { deps, wallet } = setup();
    const result = await runCycle(deps);

    assert.equal(result.outcome, "charging");
    assert.equal(wallet.signCalls, 1);
    assert.equal(deps.robot.status, "charging");
    assert.deepEqual(deps.audit.payments().map((p) => p.amount), [200_000n]);
    const phases = deps.audit.readAll().map((entry) => entry.phase);
    assert.deepEqual(phases, ["OBSERVE", "DECIDE", "DISCOVER", "PLAN", "GUARD", "PAY", "PAY", "VERIFY", "RECORD"]);
  });

  test("battery above the threshold: does nothing", async () => {
    const { deps, wallet } = setup();
    deps.robot.batteryPct = 80;
    const result = await runCycle(deps);
    assert.equal(result.outcome, "no_charge_needed");
    assert.equal(wallet.signCalls, 0);
  });

  test("fake 402 with an inflated amount: refuses and signs nothing", async () => {
    const { deps, wallet } = setup();
    quoteOverrides = { amount: "900000" }; // advertised 0.20, the 402 asks for 0.90
    const result = await runCycle(deps);

    assert.equal(result.outcome, "refused");
    assert.match(result.reasons.join("\n"), /price: 402 asks for 0\.90 USDC but the advertised price is 0\.20 USDC/);
    assert.equal(wallet.signCalls, 0);
    assert.equal(deps.robot.status, "seeking_charge");
    assert.deepEqual(deps.audit.payments(), []);
  });

  test("fake 402 with payTo swapped for an attacker's wallet: refuses and signs nothing", async () => {
    const { deps, wallet } = setup();
    quoteOverrides = { payTo: ATTACKER };
    const result = await runCycle(deps);

    assert.equal(result.outcome, "refused");
    assert.match(result.reasons.join("\n"), /allowlist: recipient .* is not on the allowlist/);
    assert.equal(wallet.signCalls, 0);
  });

  test("MAX_PER_TX_USDC lowered to 0.10: refuses the 0.20 payment", async () => {
    const { deps, wallet } = setup({ limits: { maxPerTx: 100_000n } });
    const result = await runCycle(deps);
    assert.equal(result.outcome, "refused");
    assert.match(result.reasons[0], /per-tx: 0\.20 USDC is over the 0\.10 USDC per-payment limit/);
    assert.equal(wallet.signCalls, 0);
  });

  test("kill switch on: refuses before contacting the charger", async () => {
    const { deps, wallet } = setup({ limits: { paused: true } });
    const result = await runCycle(deps);
    assert.equal(result.outcome, "refused");
    assert.match(result.reasons[0], /kill-switch/);
    assert.equal(wallet.signCalls, 0);
  });

  test("payment above the approval threshold: waits for a human, and a 'no' stops it", async () => {
    let asked = 0;
    const { deps, wallet } = setup({ limits: { approvalThreshold: 100_000n }, askHuman: async () => (asked++, false) });
    const result = await runCycle(deps);
    assert.deepEqual([result.outcome, asked, wallet.signCalls], ["refused", 1, 0]);
  });

  test("payment above the approval threshold: a 'yes' lets it through", async () => {
    const { deps, wallet } = setup({ limits: { approvalThreshold: 100_000n }, askHuman: async () => true });
    const result = await runCycle(deps);
    assert.deepEqual([result.outcome, wallet.signCalls], ["charging", 1]);
  });

  test("after an approval the agent signs a fresh 402, not the one that sat waiting", async () => {
    const { deps, wallet } = setup({ limits: { approvalThreshold: 100_000n }, askHuman: async () => true });
    const result = await runCycle(deps);
    assert.equal(result.outcome, "charging");
    assert.deepEqual([quotesIssued, wallet.signedQuoteNumber], [2, 2], "a second 402 was requested and that is the one signed");
  });

  test("without an approval wait, the first 402 is signed directly", async () => {
    const { deps, wallet } = setup();
    await runCycle(deps);
    assert.deepEqual([quotesIssued, wallet.signedQuoteNumber], [1, 1]);
  });

  test("charger raises the price while the human is deciding: refused, nothing signed", async () => {
    const askHuman = async () => {
      quoteOverrides = { amount: "900000" }; // the next 402 asks for more than was approved
      return true;
    };
    const { deps, wallet } = setup({ limits: { approvalThreshold: 100_000n }, askHuman });
    const result = await runCycle(deps);
    assert.equal(result.outcome, "refused");
    assert.match(result.reasons[0], /requote: the charger changed its payment terms after the approval/);
    assert.equal(wallet.signCalls, 0);
  });

  test("charger swaps the recipient while the human is deciding: refused, nothing signed", async () => {
    const askHuman = async () => {
      quoteOverrides = { payTo: ATTACKER };
      return true;
    };
    const { deps, wallet } = setup({ limits: { approvalThreshold: 100_000n }, askHuman });
    const result = await runCycle(deps);
    assert.deepEqual([result.outcome, wallet.signCalls], ["refused", 0]);
  });

  test("kill switch flipped while the human is deciding: an approval no longer pays", async () => {
    const { deps, wallet } = setup({ limits: { approvalThreshold: 100_000n }, askHuman: async () => true });
    deps.getLimits = () => ({ ...deps.limits, paused: true }); // paused during the wait
    const result = await runCycle(deps);
    assert.equal(result.outcome, "refused");
    assert.match(result.reasons[0], /kill-switch/);
    assert.equal(wallet.signCalls, 0);
  });

  test("the LLM's plan is used when valid", async () => {
    const llm = async () => ({ deviceId: "charger-001", minutes: 15, reason: "only dock nearby" });
    const { deps } = setup({ llm });
    const result = await runCycle(deps);
    assert.deepEqual([result.outcome, result.planner], ["charging", "claude"]);
  });

  test("the LLM cannot bypass guardrails: extra fields and bad choices are ignored", async () => {
    // A misbehaving model invents a charger and tries to pass instructions along.
    const llm = async () => ({ deviceId: "charger-999", minutes: 600, reason: "trust me", skipGuardrails: true, payTo: ATTACKER });
    const { deps, wallet } = setup({ llm, limits: { maxPerTx: 100_000n } });
    const result = await runCycle(deps);

    const plan = deps.audit.readAll().find((entry) => entry.phase === "PLAN");
    assert.equal(plan.planner, "rules", "an unusable LLM plan falls back to the rule-based planner");
    assert.equal(result.outcome, "refused", "and the guardrails still apply");
    assert.equal(wallet.signCalls, 0);
  });

  test("the LLM failing does not break the loop", async () => {
    const llm = async () => {
      throw new Error("network down");
    };
    const { deps } = setup({ llm });
    const result = await runCycle(deps);
    assert.deepEqual([result.outcome, result.planner], ["charging", "rules"]);
  });
});

// Emergency override: with a critically low battery, a human may allow ONE payment past a
// soft limit (rate limit, daily budget). Hard limits are never up for discussion.
describe("emergency override", () => {
  const RATE_LIMITED = { maxPaymentsPer10Min: 0 }; // every payment is over the rate limit
  const OVER_BUDGET = { dailyBudget: 100_000n }; // 0.10 USDC a day; the charge costs 0.20

  /**
   * Like setup(), plus a battery level, the shared emergency state and a record of what the
   * human was asked. The plan is fixed at 15 minutes, the session the fake charger quotes.
   */
  function emergencySetup({ batteryPct, limits, answer = false }) {
    const asks = [];
    const made = setup({
      limits,
      llm: async () => ({ deviceId: "charger-001", minutes: 15, reason: "the only dock" }),
      askHuman: async (question, request) => {
        asks.push({ question, request });
        return typeof answer === "function" ? answer() : answer;
      },
    });
    made.deps.robot.batteryPct = batteryPct;
    made.deps.config = { ...made.deps.config, criticalBatteryPct: 10, emergencyRetrySeconds: 120 };
    made.deps.emergency = { pending: false, nextAskAt: 0 };
    return { ...made, asks };
  }

  test("a hard failure never escalates, however low the battery", async () => {
    const hardFailures = {
      "per-tx": { limits: { ...RATE_LIMITED, maxPerTx: 100_000n } },
      "kill-switch": { limits: { ...RATE_LIMITED, paused: true } },
      allowlist: { limits: RATE_LIMITED, quote: { payTo: ATTACKER } },
      price: { limits: RATE_LIMITED, quote: { amount: "900000" } },
    };
    for (const [name, { limits, quote }] of Object.entries(hardFailures)) {
      const { deps, wallet, asks } = emergencySetup({ batteryPct: 3, limits, answer: true });
      if (quote) quoteOverrides = quote;
      const result = await runCycle(deps);
      assert.deepEqual([result.outcome, asks.length, wallet.signCalls], ["refused", 0, 0], name);
      assert.ok(result.reasons.some((reason) => reason.startsWith(`${name}:`)), `${name} is the reason given`);
    }
  });

  test("a soft failure above the critical battery level refuses, as before", async () => {
    for (const limits of [RATE_LIMITED, OVER_BUDGET]) {
      const { deps, wallet, asks } = emergencySetup({ batteryPct: 11, limits, answer: true });
      const result = await runCycle(deps);
      assert.deepEqual([result.outcome, asks.length, wallet.signCalls], ["refused", 0, 0]);
    }
  });

  test("a soft failure at the critical battery level asks a human, naming the limit", async () => {
    const { deps, asks } = emergencySetup({ batteryPct: 10, limits: RATE_LIMITED });
    await runCycle(deps);
    assert.equal(asks.length, 1);
    assert.match(asks[0].question, /EMERGENCY OVERRIDE: battery 10%.*rate-limit/);
    assert.equal(asks[0].request.emergency.batteryPct, 10);
    assert.deepEqual(asks[0].request.emergency.exceeded.map((limit) => limit.name), ["rate-limit"]);
    assert.match(asks[0].request.emergency.exceeded[0].reason, /MAX_PAYMENTS_PER_10_MIN/);
    assert.deepEqual([asks[0].request.deviceId, asks[0].request.amount, asks[0].request.payTo], ["charger-001", "200000", MERCHANT]);
  });

  test("the daily budget can be escalated too, and both limits are named when both are in the way", async () => {
    const daily = emergencySetup({ batteryPct: 6, limits: OVER_BUDGET });
    await runCycle(daily.deps);
    assert.deepEqual(daily.asks[0].request.emergency.exceeded.map((limit) => limit.name), ["daily"]);

    const both = emergencySetup({ batteryPct: 6, limits: { ...RATE_LIMITED, ...OVER_BUDGET } });
    await runCycle(both.deps);
    assert.deepEqual(both.asks[0].request.emergency.exceeded.map((limit) => limit.name).sort(), ["daily", "rate-limit"]);
  });

  test("approve: pays exactly once, and the audit log says who overrode which limit", async () => {
    const { deps, wallet, asks } = emergencySetup({ batteryPct: 6, limits: RATE_LIMITED, answer: { approved: true, by: "voice" } });
    const result = await runCycle(deps);

    assert.deepEqual([result.outcome, asks.length, wallet.signCalls], ["charging", 1, 1]);
    assert.deepEqual([result.softLimitsOverridden, result.approvalBy], [["rate-limit"], "voice"]);
    assert.equal(deps.audit.payments().length, 1);

    const entries = deps.audit.readAll();
    const guard = entries.find((entry) => entry.phase === "GUARD");
    assert.deepEqual([guard.emergency, guard.approval, guard.approvalBy, guard.softLimitsOverridden], [true, "granted", "voice", ["rate-limit"]]);
    for (const pay of entries.filter((entry) => entry.phase === "PAY")) {
      assert.deepEqual([pay.softLimitsOverridden, pay.approvalBy], [["rate-limit"], "voice"]);
    }
    const outcome = entries.findLast((entry) => entry.phase === "RECORD");
    assert.deepEqual([outcome.outcome, outcome.softLimitsOverridden, outcome.approvalBy], ["charging", ["rate-limit"], "voice"]);
  });

  test("an approved override covers that one payment: the limit is unchanged and blocks the next one", async () => {
    const { deps, wallet, asks } = emergencySetup({ batteryPct: 6, limits: OVER_BUDGET, answer: true });
    const limitsBefore = { ...deps.limits };
    await runCycle(deps);
    assert.equal(wallet.signCalls, 1);
    assert.deepEqual(deps.limits, limitsBefore, "no limit was raised or reset");

    // The same robot needs power again, well above the critical level: the budget still refuses it.
    charging = false;
    deps.robot = new Robot({ id: "robot-test", location: { lat: 30.2747, lng: -97.7404 }, startBatteryPct: 15, drainPctPerSecond: 0, chargePctPerMinute: 2 });
    const next = await runCycle(deps);
    assert.deepEqual([next.outcome, asks.length, wallet.signCalls], ["refused", 1, 1]);
    assert.match(next.reasons[0], /^daily:/);
  });

  test("deny: pays nothing", async () => {
    const { deps, wallet, asks } = emergencySetup({ batteryPct: 6, limits: RATE_LIMITED, answer: { approved: false, by: "dashboard" } });
    const result = await runCycle(deps);
    assert.deepEqual([result.outcome, asks.length, wallet.signCalls, quotesIssued], ["refused", 1, 0, 1]);
    assert.ok(result.reasons.some((reason) => /human did not approve the emergency override/.test(reason)));
    assert.equal(deps.audit.payments().length, 0);
    const guard = deps.audit.readAll().find((entry) => entry.phase === "GUARD");
    assert.deepEqual([guard.emergency, guard.approval, guard.approvalBy, guard.softLimitsOverridden], [true, "denied", "dashboard", []]);
  });

  test("only one request is pending at a time: a second cycle does not ask again", async () => {
    let answerFirst;
    let firstAsked;
    const asked = new Promise((resolve) => (firstAsked = resolve));
    const waitForHuman = () => new Promise((resolve) => ((answerFirst = resolve), firstAsked()));
    const { deps, wallet, asks } = emergencySetup({ batteryPct: 6, limits: RATE_LIMITED, answer: waitForHuman });

    const first = runCycle(deps); // asks, and waits for the human
    await Promise.race([asked, first]); // if the cycle ends without asking, the next line fails instead of hanging
    assert.equal(deps.emergency.pending, true);

    const second = await runCycle(deps); // a retry while the first request is still open
    assert.deepEqual([second.outcome, asks.length, wallet.signCalls], ["refused", 1, 0]);
    assert.ok(second.reasons.some((reason) => /already waiting for an answer/.test(reason)));

    answerFirst(true);
    assert.equal((await first).outcome, "charging");
    assert.deepEqual([asks.length, wallet.signCalls, deps.emergency.pending], [1, 1, false]);
  });

  test("after a denial or a timeout the agent waits two minutes before asking again", async () => {
    for (const by of ["dashboard", "timeout"]) {
      const { deps, wallet, asks } = emergencySetup({ batteryPct: 6, limits: RATE_LIMITED, answer: { approved: false, by } });
      const before = Date.now();
      await runCycle(deps);
      assert.ok(deps.emergency.nextAskAt >= before + 120_000 && deps.emergency.nextAskAt <= Date.now() + 120_000, "next request allowed in 2 minutes");

      // The 20-second retries in between refuse quietly, without a new request.
      for (let retry = 0; retry < 3; retry++) {
        const result = await runCycle(deps);
        assert.equal(result.outcome, "refused");
        assert.ok(result.reasons.some((reason) => /may ask again in \d+s/.test(reason)));
      }
      assert.equal(asks.length, 1, by);

      deps.emergency.nextAskAt = Date.now() - 1; // two minutes later
      await runCycle(deps);
      assert.deepEqual([asks.length, wallet.signCalls], [2, 0]);
    }
  });

  test("an approved override does not excuse a hard failure that appears while the human decides", async () => {
    const swapRecipient = () => {
      quoteOverrides = { payTo: ATTACKER }; // the fresh 402 after the approval pays someone else
      return true;
    };
    const { deps, wallet } = emergencySetup({ batteryPct: 6, limits: RATE_LIMITED, answer: swapRecipient });
    const result = await runCycle(deps);
    assert.deepEqual([result.outcome, wallet.signCalls], ["refused", 0]);

    const paused = emergencySetup({ batteryPct: 6, limits: RATE_LIMITED, answer: true });
    paused.deps.getLimits = () => ({ ...paused.deps.limits, paused: true }); // kill switch flipped during the wait
    const afterPause = await runCycle(paused.deps);
    assert.deepEqual([afterPause.outcome, paused.wallet.signCalls], ["refused", 0]);
  });
});

// Chargers can be in use by other robots. The agent weighs its options, never pays for a busy
// dock, never heads for a charger it cannot reach, and waits when that is the only sound move.
describe("busy chargers", () => {
  const CONGRESS = { id: "charger-001", name: "Congress Ave Robot Dock", location: { lat: 30.2682, lng: -97.7429 } };
  const SOUTH_CONGRESS = { id: "charger-002", name: "South Congress Charging Bay", location: { lat: 30.2497, lng: -97.7494 } };
  const EAST_6TH = { id: "charger-003", name: "East 6th St Dock", location: { lat: 30.2647, lng: -97.731 } };
  const idle = (dock) => ({ ...dock, status: "idle", minutesUntilFree: 0 });
  const inUse = (dock, minutes) => ({ ...dock, status: "in_use", minutesUntilFree: minutes });

  /** A robot at the Capitol on 19% battery; the drive costs 5% per km and standing still 0.5% per simulated minute. */
  function busySetup({ chargers, batteryPct = 19, llm } = {}) {
    const made = setup({ llm });
    fleet = chargers;
    made.deps.robot = new Robot({
      id: "robot-test",
      location: { lat: 30.2747, lng: -97.7404 },
      startBatteryPct: batteryPct,
      drainPctPerSecond: 0.5,
      drainPctPerKm: 5,
      chargePctPerMinute: 2,
    });
    made.deps.robot.tick = () => {}; // time stands still here, so the battery is exactly what the test set
    made.deps.config = { ...made.deps.config, secondsPerMinute: 1, retrySeconds: 20 };
    const events = [];
    made.deps.log = (phase, message, data) => events.push({ phase, message, data });
    return { ...made, events };
  }
  const paidRequests = () => chargeRequests.filter((request) => request.paid);
  const optionsShown = (events) => events.find((event) => event.phase === "DISCOVER").data.chargers;

  test("the nearest charger is in use: the agent pays a free one instead, and never the busy dock", async () => {
    const { deps, wallet, events } = busySetup({ chargers: [inUse(CONGRESS, 12), idle(SOUTH_CONGRESS), idle(EAST_6TH)] });
    const nearest = optionsShown;
    const result = await runCycle(deps);

    const options = nearest(events);
    assert.equal([...options].sort((a, b) => a.distanceKm - b.distanceKm)[0].id, "charger-001", "Congress Ave really is the closest");
    assert.equal(result.outcome, "charging");
    assert.notEqual(result.deviceId, "charger-001");
    assert.equal(wallet.signCalls, 1);
    assert.deepEqual(chargeRequests.filter((request) => request.id === "charger-001"), [], "the busy dock was never even asked for a price");
    assert.deepEqual(paidRequests().map((request) => request.id), [result.deviceId]);
    const plan = events.find((event) => event.phase === "PLAN" && event.data.planner);
    assert.match(plan.data.reason, /Congress Ave busy 12 min; .* is free and reachable at \d+%/);
  });

  test("the options under DISCOVER carry status, wait, distance, drain and reach for every charger", async () => {
    const { deps, events } = busySetup({ chargers: [inUse(CONGRESS, 12), idle(SOUTH_CONGRESS), idle(EAST_6TH)] });
    await runCycle(deps);
    const options = optionsShown(events);
    assert.equal(options.length, 3);
    const busy = options.find((option) => option.id === "charger-001");
    assert.deepEqual([busy.status, busy.free, busy.minutesUntilFree, busy.ifWait.reachable], ["in_use", false, 12, true]);
    for (const option of options) {
      assert.ok(option.distanceKm > 0 && option.drainToReachPct > 0, option.id);
      assert.ok(Math.abs(option.batteryOnArrivalPct - (19 - option.distanceKm * 5)) < 0.1, "battery on arrival is the battery minus the drive");
      assert.equal(option.reachable, true);
    }
    assert.deepEqual(deps.audit.readAll().find((entry) => entry.phase === "DISCOVER").chargers, options);
  });

  test("every charger is in use: the agent waits, pays nothing, and records a WAIT decision", async () => {
    const { deps, wallet, events } = busySetup({ chargers: [inUse(CONGRESS, 12), inUse(SOUTH_CONGRESS, 30), inUse(EAST_6TH, 6)] });
    const result = await runCycle(deps);

    assert.equal(result.outcome, "waiting");
    assert.deepEqual([result.waitFor, result.minutesUntilFree, result.recheckInSeconds], ["charger-003", 6, 6]);
    assert.deepEqual([wallet.signCalls, chargeRequests.length], [0, 0], "no price was asked for and nothing was signed");
    assert.equal(deps.robot.status, "seeking_charge");

    const entries = deps.audit.readAll();
    assert.deepEqual(entries.map((entry) => entry.phase), ["OBSERVE", "DECIDE", "DISCOVER", "PLAN", "WAIT", "RECORD"]);
    assert.equal(entries.filter((entry) => entry.phase === "PAY").length, 0);
    assert.equal(deps.audit.payments().length, 0);
    const wait = entries.find((entry) => entry.phase === "WAIT");
    assert.deepEqual([wait.waitFor, wait.minutesUntilFree], ["charger-003", 6]);
    assert.equal(entries.at(-1).outcome, "waiting");
    assert.ok(events.some((event) => event.phase === "WAIT" && /No payment made/.test(event.message)));
  });

  test("after waiting it looks again, and pays once a charger is free", async () => {
    const { deps, wallet } = busySetup({ chargers: [inUse(CONGRESS, 4)] });
    assert.equal((await runCycle(deps)).outcome, "waiting");
    fleet = [idle(CONGRESS)]; // the other robot left
    const next = await runCycle(deps);
    assert.deepEqual([next.outcome, next.deviceId, wallet.signCalls], ["charging", "charger-001", 1]);
  });

  test("a charger taken between discovery and the request answers 409, and nothing is paid", async () => {
    const { deps, wallet, events } = busySetup({ chargers: [idle(CONGRESS)] });
    inUseAtTheDock = ["charger-001"]; // another robot plugged in a moment ago
    const result = await runCycle(deps);
    assert.equal(result.outcome, "failed");
    assert.match(result.reasons[0], /charger-001 is in use \(HTTP 409: charger_in_use\); no payment requested/);
    assert.deepEqual([wallet.signCalls, paidRequests().length, quotesIssued], [0, 0, 0]);
    assert.equal(deps.audit.payments().length, 0);
    assert.ok(events.some((event) => event.data.chargerInUse));
  });

  test("a free charger out of reach is never chosen: the agent waits for the one it can reach", async () => {
    // 8% battery: only Congress Ave (in use) is close enough. The free ones are too far.
    const { deps, wallet, events } = busySetup({ batteryPct: 8, chargers: [inUse(CONGRESS, 3), idle(SOUTH_CONGRESS), idle(EAST_6TH)] });
    const result = await runCycle(deps);
    const options = optionsShown(events);
    assert.deepEqual(options.filter((option) => option.free).map((option) => option.reachable), [false, false]);
    assert.deepEqual([result.outcome, result.waitFor, wallet.signCalls, chargeRequests.length], ["waiting", "charger-001", 0, 0]);
  });

  test("nothing in reach at all: no plan, no request, no payment", async () => {
    const { deps, wallet } = busySetup({ batteryPct: 8, chargers: [idle(SOUTH_CONGRESS), idle(EAST_6TH)] });
    const result = await runCycle(deps);
    assert.equal(result.outcome, "failed");
    assert.match(result.reasons[0], /no free charger can be reached on 8% battery/);
    assert.deepEqual([wallet.signCalls, chargeRequests.length], [0, 0]);
  });

  test("Claude cannot send the robot to a charger out of reach, or to pay at a busy one", async () => {
    const outOfReach = async () => ({ action: "charge", deviceId: "charger-002", minutes: 15, reason: "it is free" });
    const first = busySetup({ batteryPct: 8, chargers: [inUse(CONGRESS, 3), idle(SOUTH_CONGRESS)], llm: outOfReach });
    const waited = await runCycle(first.deps);
    assert.deepEqual([waited.outcome, waited.planner, first.wallet.signCalls, chargeRequests.length], ["waiting", "rules", 0, 0]);

    const payBusy = async () => ({ action: "charge", deviceId: "charger-001", minutes: 15, reason: "closest" });
    const second = busySetup({ chargers: [inUse(CONGRESS, 12), idle(EAST_6TH)], llm: payBusy });
    const paid = await runCycle(second.deps);
    assert.deepEqual([paid.outcome, paid.deviceId, paid.planner], ["charging", "charger-003", "rules"]);
    assert.deepEqual(chargeRequests.filter((request) => request.id === "charger-001"), []);
  });

  test("Claude may choose to wait for a closer charger instead of driving far", async () => {
    const llm = async () => ({ action: "wait", deviceId: "charger-001", minutes: 15, reason: "Congress Ave frees in 2 min and is far closer than South Congress." });
    const { deps, wallet } = busySetup({ chargers: [inUse(CONGRESS, 2), idle(SOUTH_CONGRESS)], llm });
    const result = await runCycle(deps);
    assert.deepEqual([result.outcome, result.planner, result.waitFor, result.recheckInSeconds], ["waiting", "claude", "charger-001", 2]);
    assert.deepEqual([wallet.signCalls, chargeRequests.length], [0, 0]);
  });
});
