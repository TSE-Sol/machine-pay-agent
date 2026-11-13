// Tests for `npm run demo:reset`. They work in a temporary folder and never touch the real audit log.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { resetAuditLog, runningAgentPids } from "./demo-reset.js";

function workspace(lines = []) {
  const dir = mkdtempSync(join(tmpdir(), "demo-reset-test-"));
  const paths = { auditPath: join(dir, "audit.log"), archiveDir: join(dir, "audit-archive"), pidFile: join(dir, "agent.pid"), scanProcesses: false };
  if (lines.length) writeFileSync(paths.auditPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return paths;
}

const payment = (id, status, amount = "200000") => ({ phase: "PAY", paymentId: id, status, amount });

describe("demo:reset", () => {
  test("archives the audit log, starts a fresh one, and reports what it put away", () => {
    const paths = workspace([{ phase: "OBSERVE" }, payment("a", "pending"), payment("a", "settled"), payment("b", "pending"), payment("b", "settled"), payment("c", "pending"), payment("c", "failed")]);
    const original = readFileSync(paths.auditPath, "utf8");

    const result = resetAuditLog({ ...paths, now: new Date("2026-11-13T05:30:00.000Z") });

    assert.equal(result.archived, true);
    assert.deepEqual([result.entries, result.payments, result.spentUsdc], [7, 2, 0.4]);
    assert.equal(result.archivePath, join(paths.archiveDir, "audit-2026-11-13T05-30-00-000Z.log"));
    assert.equal(readFileSync(result.archivePath, "utf8"), original, "the archive is the old log, unchanged");
    assert.equal(readFileSync(paths.auditPath, "utf8"), "", "the new log is empty");
  });

  test("refuses while the agent is running, and leaves the log alone", () => {
    const paths = workspace([payment("a", "settled")]);
    writeFileSync(paths.pidFile, String(process.pid)); // this test process stands in for a running agent
    const before = readFileSync(paths.auditPath, "utf8");

    const result = resetAuditLog(paths);

    assert.equal(result.archived, false);
    assert.match(result.reason, new RegExp(`the agent is running \\(pid ${process.pid}\\)`));
    assert.equal(readFileSync(paths.auditPath, "utf8"), before);
    assert.equal(existsSync(paths.archiveDir), false);
  });

  test("a pid file left behind by a crashed agent does not block the reset", () => {
    const paths = workspace([payment("a", "settled")]);
    writeFileSync(paths.pidFile, "999999999"); // no such process
    assert.deepEqual(runningAgentPids(paths), []);
    assert.equal(resetAuditLog(paths).archived, true);
  });

  test("does nothing when there is no log, or it is empty", () => {
    const missing = workspace();
    assert.deepEqual([resetAuditLog(missing).archived, existsSync(missing.archiveDir)], [false, false]);

    const empty = workspace();
    writeFileSync(empty.auditPath, "");
    assert.match(resetAuditLog(empty).reason, /no audit log to archive/);
  });

  test("running it twice keeps both archives", () => {
    const paths = workspace([payment("a", "settled")]);
    resetAuditLog({ ...paths, now: new Date("2026-11-13T05:30:00.000Z") });
    writeFileSync(paths.auditPath, JSON.stringify(payment("b", "settled")) + "\n");
    resetAuditLog({ ...paths, now: new Date("2026-11-13T05:31:00.000Z") });
    assert.equal(readdirSync(paths.archiveDir).length, 2);
  });
});
