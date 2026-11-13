// Tests for the approval race: terminal vs dashboard vs timeout. Run with `npm test`.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { requestApproval } from "./approval.js";

const never = new Promise(() => {});
const request = { deviceId: "charger-001", minutes: 60, amount: "800000", payTo: "merchant" };

/** A fake control plane whose dashboard answers after `afterPolls` polls (or never). */
function fakeControl({ answer = null, afterPolls = 1, createFails = false } = {}) {
  const control = {
    created: null,
    resolved: null,
    polls: 0,
    async createApproval(body) {
      if (createFails) throw new Error("dashboard down");
      control.created = body;
    },
    async getApproval() {
      control.polls++;
      if (answer && control.polls >= afterPolls) return { status: answer, by: "dashboard" };
      return { status: "pending", by: null };
    },
    async resolveApproval(id, decision, by) {
      control.resolved = { id, decision, by };
    },
  };
  return control;
}

const ask = (overrides) => requestApproval({ question: "Approve?", request, timeoutMs: 200, pollMs: 5, terminal: () => never, log: () => {}, ...overrides });

describe("human approval", () => {
  test("dashboard approves", async () => {
    const control = fakeControl({ answer: "approved" });
    assert.deepEqual(await ask({ control }), { approved: true, by: "dashboard" });
    assert.equal(control.created.amount, "800000", "the request shown on the dashboard carries the payment details");
    assert.equal(control.resolved, null, "nothing to report back: the dashboard already knows");
  });

  test("dashboard denies", async () => {
    assert.deepEqual(await ask({ control: fakeControl({ answer: "denied" }) }), { approved: false, by: "dashboard" });
  });

  test("terminal answers first: it wins and the dashboard is told", async () => {
    const control = fakeControl({ answer: "denied", afterPolls: 1000 });
    const result = await ask({ control, terminal: async () => ({ approved: true, by: "terminal" }) });
    assert.deepEqual(result, { approved: true, by: "terminal" });
    assert.deepEqual([control.resolved.decision, control.resolved.by], ["approve", "terminal"]);
  });

  test("dashboard answers first: the later terminal answer is ignored", async () => {
    const slowTerminal = () => new Promise((resolve) => setTimeout(() => resolve({ approved: true, by: "terminal" }), 150));
    const result = await ask({ control: fakeControl({ answer: "denied" }), terminal: slowTerminal });
    assert.deepEqual(result, { approved: false, by: "dashboard" });
  });

  test("nobody answers: times out as a denial and the dashboard is told", async () => {
    const control = fakeControl();
    const result = await ask({ control, timeoutMs: 40 });
    assert.deepEqual(result, { approved: false, by: "timeout" });
    assert.deepEqual([control.resolved.decision, control.resolved.by], ["deny", "timeout"]);
  });

  test("no dashboard configured: the terminal still works", async () => {
    const result = await ask({ control: null, terminal: async () => ({ approved: true, by: "terminal" }) });
    assert.deepEqual(result, { approved: true, by: "terminal" });
  });

  test("dashboard unreachable and no terminal: denied by timeout", async () => {
    const result = await ask({ control: fakeControl({ createFails: true }), timeoutMs: 40 });
    assert.deepEqual(result, { approved: false, by: "timeout" });
  });

  test("an answer that did not come from the dashboard button is not accepted as one", async () => {
    // e.g. the server marks the approval as resolved by "timeout": that is not a human yes.
    const control = fakeControl();
    control.getApproval = async () => ({ status: "approved", by: "timeout" });
    assert.deepEqual(await ask({ control, timeoutMs: 40 }), { approved: false, by: "timeout" });
  });
});
