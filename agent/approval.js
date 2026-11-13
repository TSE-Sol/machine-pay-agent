// Human approval for payments above APPROVAL_THRESHOLD_USDC.
//
// The question is asked in two places at once: the terminal (y/N) and the dashboard
// (Approve / Deny). The first answer wins. No answer within the timeout means no.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

const never = new Promise(() => {});

/** Ask y/N in the terminal. Resolves only if a human answers; aborts quietly otherwise. */
async function askTerminal(question, signal) {
  if (!process.stdin.isTTY) return never; // nobody to ask here
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`${question} [y/N] `, { signal });
    return { approved: ["y", "yes"].includes(answer.trim().toLowerCase()), by: "terminal" };
  } catch {
    return never; // aborted because another answer arrived first
  } finally {
    readline.close();
  }
}

/** Wait for the dashboard's answer by polling the control plane. */
async function askDashboard(control, id, signal, pollMs) {
  while (!signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const approval = await control.getApproval(id).catch(() => null);
    if (approval && approval.status !== "pending" && approval.by === "dashboard") {
      return { approved: approval.status === "approved", by: "dashboard" };
    }
  }
  return never;
}

/**
 * Returns { approved: boolean, by: "terminal" | "dashboard" | "timeout" }.
 *   request - { deviceId, minutes, amount, payTo } shown on the dashboard
 *   control - control-plane client, or null if the dashboard isn't configured
 */
export async function requestApproval({ question, request, control, timeoutMs = 60_000, pollMs = 1000, terminal = askTerminal, log = console.log }) {
  const abort = new AbortController();
  const id = randomUUID();

  let onDashboard = false;
  if (control) {
    try {
      await control.createApproval({ id, ...request, timeoutSeconds: Math.ceil(timeoutMs / 1000) });
      onDashboard = true;
    } catch {
      // dashboard unavailable: the terminal (or the timeout) decides
    }
  }
  const seconds = Math.round(timeoutMs / 1000);
  log(`${question}  (answer here${onDashboard ? " or on the dashboard" : ""}; no answer in ${seconds}s = no)`);

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ approved: false, by: "timeout" }), timeoutMs);
  });

  const answer = await Promise.race([
    terminal(question, abort.signal),
    onDashboard ? askDashboard(control, id, abort.signal, pollMs) : never,
    timeout,
  ]);

  clearTimeout(timer);
  abort.abort(); // stop the other askers
  if (onDashboard && answer.by !== "dashboard") {
    await control.resolveApproval(id, answer.approved ? "approve" : "deny", answer.by).catch(() => {});
  }
  return answer;
}
