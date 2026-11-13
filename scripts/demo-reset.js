// Demo prep (devnet / demo use only): archive the agent's audit log and start a fresh one,
// so the rolling 24-hour spend goes back to zero for a clean demo run.
//
//   npm run demo:reset
//
// Nothing is deleted: agent/audit.log is moved to agent/audit-archive/audit-<timestamp>.log.
// It refuses to run while the agent is running, because the agent reads its spending
// history from this file.
//
// The audit log is the agent's memory for its daily budget and rate limit. Resetting it is
// a deliberate way to wipe that memory for a demo; it has no place in a real deployment.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** PIDs of running agents: the agent's own pid file, plus a scan of the process list. */
export function runningAgentPids({ pidFile, scanProcesses = true } = {}) {
  const pids = new Set();
  if (pidFile && existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      if (pid > 0) {
        process.kill(pid, 0); // signal 0 only checks that the process exists
        pids.add(pid);
      }
    } catch {
      // stale pid file left by a crashed agent
    }
  }
  if (scanProcesses && process.platform !== "win32") {
    try {
      const found = execFileSync("pgrep", ["-f", "node agent/index.js"], { encoding: "utf8" });
      for (const line of found.split("\n")) if (Number(line) > 0 && Number(line) !== process.pid) pids.add(Number(line));
    } catch {
      // pgrep exits non-zero when nothing matches
    }
  }
  return [...pids];
}

/**
 * Archive the audit log and start a new one.
 * Returns { archived: false, reason } or { archived: true, archivePath, entries, payments, spentUsdc }.
 */
export function resetAuditLog({ auditPath, archiveDir, pidFile, scanProcesses = true, now = new Date() }) {
  const running = runningAgentPids({ pidFile, scanProcesses });
  if (running.length > 0) {
    return { archived: false, reason: `the agent is running (pid ${running.join(", ")}). Stop it first, then run this again.` };
  }
  if (!existsSync(auditPath) || readFileSync(auditPath, "utf8").trim() === "") {
    return { archived: false, reason: "there is no audit log to archive; the spend is already zero." };
  }

  // Summarize what is being put away.
  const entries = readFileSync(auditPath, "utf8").split("\n").filter(Boolean);
  const settled = new Map();
  for (const line of entries) {
    try {
      const entry = JSON.parse(line);
      if (entry.phase === "PAY" && entry.status === "settled") settled.set(entry.paymentId, Number(entry.amount));
    } catch {
      // keep going past a damaged line; it is archived as-is
    }
  }
  const spentUsdc = [...settled.values()].reduce((sum, amount) => sum + amount, 0) / 1e6;

  mkdirSync(archiveDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const archivePath = join(archiveDir, `audit-${stamp}.log`);
  renameSync(auditPath, archivePath);
  writeFileSync(auditPath, "");
  return { archived: true, archivePath, entries: entries.length, payments: settled.size, spentUsdc };
}

// Run from the command line: npm run demo:reset
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const result = resetAuditLog({
    auditPath: join(root, "agent/audit.log"),
    archiveDir: join(root, "agent/audit-archive"),
    pidFile: join(root, "agent/agent.pid"),
  });
  if (!result.archived) {
    console.error(`demo:reset did nothing: ${result.reason}`);
    process.exit(1);
  }
  console.log(`Archived agent/audit.log -> ${result.archivePath.replace(`${root}/`, "")}`);
  console.log(`  ${result.entries} log entries, ${result.payments} settled payments, ${result.spentUsdc.toFixed(2)} USDC`);
  console.log("Started a fresh agent/audit.log. The agent's 24-hour spend and rate-limit history are now empty.");
  console.log("Demo tool only: on-chain balances and the archived log are unchanged.");
}
