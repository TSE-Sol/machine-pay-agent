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
let server;
let serverUrl;

before(async () => {
  server = createServer((req, res) => {
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/devices") {
      return json(200, [
        { id: "charger-001", name: "Test Dock", type: "pay-to-power", location: { lat: 30.2682, lng: -97.7429 }, pricePer15MinUSDC: 0.2, status: "idle" },
      ]);
    }
    if (req.method === "GET" && req.url === "/devices/charger-001/status") {
      return json(200, { id: "charger-001", status: charging ? "charging" : "idle", sessionId: "s-1", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    if (req.method === "POST" && req.url === "/devices/charger-001/charge") {
      if (!req.headers["payment-signature"]) {
        const paymentRequired = {
          x402Version: 2,
          error: "Payment required",
          resource: { url: `${serverUrl}/devices/charger-001/charge`, description: "test", mimeType: "application/json" },
          accepts: [
            { scheme: "exact", network: DEVNET, asset: USDC, payTo: MERCHANT, amount: "200000", maxTimeoutSeconds: 60, extra: { quoteNumber: ++quotesIssued }, ...quoteOverrides },
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
