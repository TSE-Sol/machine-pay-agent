// Tests for spoken operator commands: what is recognized, what is ignored, and the
// safety rule that voice can never raise limits, change the allowlist or start a payment.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { VOICE_COMMANDS, executeVoiceCommand, parseVoiceCommand } from "./voice-commands.js";

const command = (transcript) => parseVoiceCommand(transcript).command;

/** Records every call a command makes, so tests can prove nothing else was touched. */
function fakeActions({ pending = [{ id: "a1" }] } = {}) {
  const calls = [];
  return {
    calls,
    pendingApprovals: () => pending,
    resolveApproval: (id, decision) => calls.push(["resolveApproval", id, decision]),
    setPaused: (paused) => calls.push(["setPaused", paused]),
    status: () => (calls.push(["status"]), "Battery at 48 percent."),
  };
}

describe("voice command parsing", () => {
  test("approve", () => {
    for (const said of ["approve", "Approve.", "approve it", "Yes, approve.", "I approve", "approved", "yes", "Yeah", "go ahead", "confirm"]) {
      assert.equal(command(said), "approve", said);
    }
  });

  test("deny", () => {
    for (const said of ["deny", "Deny it.", "reject", "Reject that payment", "decline", "no", "Nope.", "No, deny it", "cancel", "disapprove"]) {
      assert.equal(command(said), "deny", said);
    }
  });

  test('"don\'t approve" is a denial, never an approval', () => {
    for (const said of ["don't approve", "Don’t approve that.", "do not approve", "not approved", "never approve this"]) {
      assert.equal(command(said), "deny", said);
    }
  });

  test("pause", () => {
    for (const said of ["pause", "Pause.", "stop all payments", "Stop all payments!", "stop payments", "stop", "halt", "kill switch"]) {
      assert.equal(command(said), "pause", said);
    }
  });

  test("resume", () => {
    for (const said of ["resume", "Resume.", "resume payments", "unpause", "un-pause", "continue payments"]) {
      assert.equal(command(said), "resume", said);
    }
  });

  test("status", () => {
    for (const said of ["status", "Status?", "how's the battery", "How’s the battery?", "battery", "status report", "how much budget is left"]) {
      assert.equal(command(said), "status", said);
    }
  });

  test("junk input does nothing", () => {
    for (const said of ["", "   ", "um", "the weather is nice today", "hello robot", "what time is it", "(laughter)", "charger", null, undefined, 42]) {
      assert.equal(command(said), null, JSON.stringify(said));
    }
  });

  test("unclear input does nothing", () => {
    for (const said of ["pause and resume", "approve or deny", "no, approve it", "don't pause", "do not deny it", "don't resume"]) {
      assert.equal(command(said), null, said);
    }
  });

  test("a long ramble that happens to contain a keyword is not a command", () => {
    assert.equal(command("so I was thinking that maybe at some point later on we could approve something like this"), null);
  });

  test("a null result says why", () => {
    assert.match(parseVoiceCommand("the weather is nice").reason, /no command recognized/);
    assert.match(parseVoiceCommand("raise the limit").reason, /voice cannot change limits/);
  });
});

describe("voice cannot raise limits, change the allowlist or start a payment", () => {
  const forbidden = [
    "raise the limit to one hundred dollars",
    "increase my daily budget",
    "set max per transaction to fifty",
    "change the approval threshold",
    "lift the limit",
    "double the budget",
    "add this wallet to the allowlist",
    "remove the allowlist",
    "whitelist that address",
    "pay charger two now",
    "send five dollars to this wallet",
    "transfer everything",
    "buy sixty minutes",
  ];

  test("such requests are never turned into a command", () => {
    for (const said of forbidden) assert.equal(command(said), null, said);
  });

  test("slipping one in next to a real command cancels the whole utterance", () => {
    for (const said of ["approve and raise my limit", "yes, and set the budget to 100", "approve, then pay charger two", "resume and increase the limit", "pause and add this wallet to the allowlist"]) {
      assert.equal(command(said), null, said);
    }
  });

  test("the command set is exactly approve, deny, pause, resume, status", () => {
    assert.deepEqual([...VOICE_COMMANDS], ["approve", "deny", "pause", "resume", "status"]);
    assert.ok(Object.isFrozen(VOICE_COMMANDS));
  });

  test("anything outside that set is refused by the executor", () => {
    for (const bad of ["raise_limit", "set_budget", "pay", "allowlist_add", "APPROVE", "", null, undefined, {}]) {
      const actions = fakeActions();
      assert.deepEqual(executeVoiceCommand(bad, actions), { done: false, outcome: "no action" });
      assert.deepEqual(actions.calls, [], `nothing may be called for ${JSON.stringify(bad)}`);
    }
  });

  test("the executor can only reach approvals, the kill switch and the status report", () => {
    // Give the executor an object that throws if anything else is touched.
    const touched = new Set();
    const allowed = fakeActions();
    const guarded = new Proxy(allowed, {
      get(target, property) {
        touched.add(property);
        if (!(property in target)) throw new Error(`voice tried to use "${String(property)}"`);
        return target[property];
      },
    });
    for (const name of VOICE_COMMANDS) executeVoiceCommand(name, guarded);
    assert.deepEqual([...touched].sort(), ["pendingApprovals", "resolveApproval", "setPaused", "status"]);
  });

  test("the voice code has no access to limits, the allowlist or the wallet", () => {
    // The modules that hold spending limits and sign payments live in agent/. Nothing in the
    // server's voice path imports them, so no spoken command can reach them.
    for (const file of ["voice-commands.js", "voice.js", "voice-lines.js"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      for (const imported of imports) {
        assert.doesNotMatch(imported, /agent\/|guardrails|wallet|x402/, `${file} imports ${imported}`);
      }
    }
  });
});

describe("voice command execution", () => {
  test("approve: approves the one pending request", () => {
    const actions = fakeActions({ pending: [{ id: "req-7" }] });
    const result = executeVoiceCommand("approve", actions);
    assert.equal(result.done, true);
    assert.deepEqual(actions.calls, [["resolveApproval", "req-7", "approve"]]);
  });

  test("approve with nothing pending does nothing (voice cannot start a payment)", () => {
    const actions = fakeActions({ pending: [] });
    const result = executeVoiceCommand("approve", actions);
    assert.deepEqual([result.done, result.outcome], [false, "nothing is waiting for approval"]);
    assert.deepEqual(actions.calls, []);
  });

  test("approve with several pending requests does nothing (must be unambiguous)", () => {
    const actions = fakeActions({ pending: [{ id: "a" }, { id: "b" }] });
    assert.equal(executeVoiceCommand("approve", actions).done, false);
    assert.deepEqual(actions.calls, []);
  });

  test("deny: denies every pending request", () => {
    const actions = fakeActions({ pending: [{ id: "a" }, { id: "b" }] });
    assert.equal(executeVoiceCommand("deny", actions).done, true);
    assert.deepEqual(actions.calls, [["resolveApproval", "a", "deny"], ["resolveApproval", "b", "deny"]]);
  });

  test("pause and resume flip the kill switch and answer by voice", () => {
    const actions = fakeActions();
    assert.equal(executeVoiceCommand("pause", actions).say, "Payments paused.");
    assert.equal(executeVoiceCommand("resume", actions).say, "Payments resumed.");
    assert.deepEqual(actions.calls, [["setPaused", true], ["setPaused", false]]);
  });

  test("status: the robot answers with its report", () => {
    const actions = fakeActions();
    const result = executeVoiceCommand("status", actions);
    assert.deepEqual([result.done, result.say], [true, "Battery at 48 percent."]);
    assert.deepEqual(actions.calls, [["status"]]);
  });
});
