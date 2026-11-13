// Voice commands for the human operator.
//
// SAFETY BOUNDARY. A spoken command can do exactly five things, and nothing else:
//   approve - approve the one payment the agent is already asking about
//   deny    - deny it
//   pause   - turn the kill switch on
//   resume  - turn the kill switch off
//   status  - have the robot report battery, budget left and last payment
// Voice can never raise a limit, change the allowlist, choose a recipient or amount,
// or start a payment. There is no code path from a transcript to any of those: the
// transcript is matched against fixed word lists (no LLM interprets it), and the only
// things the executor can call are the four functions passed to it.

export const VOICE_COMMANDS = Object.freeze(["approve", "deny", "pause", "resume", "status"]);

const MAX_WORDS = 12; // a command is a few words; a long ramble is not a command

// Requests for things voice must never do. Any of these words makes the whole utterance a no-op.
const FORBIDDEN = /\b(raise|increase|lift|higher|double|change|set|add|remove|delete|allowlist|whitelist|pay|send|transfer|buy|purchase|limit|limits|threshold|budget to)\b/;

const NEGATION = /\b(don't|dont|do not|not|never|no)\b/;

const INTENTS = [
  // Denials first: "don't approve" must never be read as an approval.
  { command: "deny", pattern: /\b(deny|denied|reject|rejected|decline|declined|disapprove|refuse|cancel)\b/ },
  { command: "approve", pattern: /\b(approve|approved|approving|approval granted|confirm|confirmed|go ahead)\b/ },
  { command: "pause", pattern: /\b(pause|paused|stop all payments|stop payments|stop paying|stop|halt|kill switch|freeze)\b/ },
  { command: "resume", pattern: /\b(resume|resumed|unpause|continue payments)\b/ },
  { command: "status", pattern: /\b(status|battery|how are you|how's it going|report|budget left|how much budget)\b/ },
];

const normalize = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/-/g, "") // "un-pause" -> "unpause"
    .replace(/[^a-z0-9' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Turn a transcript into one of VOICE_COMMANDS, or null.
 * Returns { command, reason } where reason explains a null.
 */
export function parseVoiceCommand(transcript) {
  const text = normalize(transcript);
  if (!text) return { command: null, reason: "nothing heard" };
  if (text.split(" ").length > MAX_WORDS) return { command: null, reason: "too long to be a command" };
  if (FORBIDDEN.test(text)) return { command: null, reason: "voice cannot change limits, recipients or payments" };

  // A bare yes / no answers the approval question.
  if (/^(yes|yeah|yep|yes please|yes approve)$/.test(text)) return { command: "approve", reason: null };
  if (/^(no|nope|no thanks|no thank you)$/.test(text)) return { command: "deny", reason: null };

  // "No, deny it": the leading "no" is an interjection, not a negation of the command.
  const startsWithNo = /^no\b/.test(text);
  const core = text.replace(/^no\s+/, "");
  const matched = INTENTS.filter((intent) => intent.pattern.test(core)).map((intent) => intent.command);

  if (NEGATION.test(core)) {
    // "don't approve", "do not approve that": a refusal. Any other negated command is unclear.
    if (matched.length === 1 && matched[0] === "approve") return { command: "deny", reason: null };
    if (matched.length > 0) return { command: null, reason: "unclear (negated command)" };
  }
  if (startsWithNo && matched.includes("approve")) return { command: null, reason: "unclear (no, then approve)" };
  if (matched.length === 0) return { command: null, reason: "no command recognized" };
  if (matched.length > 1) return { command: null, reason: "unclear (more than one command)" };
  return { command: matched[0], reason: null };
}

/**
 * Carry out a parsed command. `actions` is the complete list of things voice can touch:
 *   pendingApprovals() -> [{ id }]      resolveApproval(id, "approve" | "deny")
 *   setPaused(boolean)                  status() -> string
 * Returns { done, outcome, say } where `say` is an optional spoken reply.
 */
export function executeVoiceCommand(command, actions) {
  if (!VOICE_COMMANDS.includes(command)) return { done: false, outcome: "no action" };

  switch (command) {
    case "approve": {
      const pending = actions.pendingApprovals();
      if (pending.length === 0) return { done: false, outcome: "nothing is waiting for approval" };
      // Approving is the one command that lets money move, so it must be unambiguous.
      if (pending.length > 1) return { done: false, outcome: "more than one request is waiting; use the dashboard" };
      actions.resolveApproval(pending[0].id, "approve");
      return { done: true, outcome: "approved the pending payment" };
    }
    case "deny": {
      const pending = actions.pendingApprovals();
      if (pending.length === 0) return { done: false, outcome: "nothing is waiting for approval" };
      for (const approval of pending) actions.resolveApproval(approval.id, "deny");
      return { done: true, outcome: "denied the pending payment" };
    }
    case "pause":
      actions.setPaused(true);
      return { done: true, outcome: "kill switch on: payments paused", say: "Payments paused." };
    case "resume":
      actions.setPaused(false);
      return { done: true, outcome: "kill switch off: payments resumed", say: "Payments resumed." };
    case "status": {
      const report = actions.status();
      return { done: true, outcome: "status reported", say: report };
    }
  }
}
