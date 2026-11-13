// Append-only audit log (JSON lines). Every phase of every cycle is written here,
// and the spending guardrails read their history back from it, so limits survive restarts.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export class AuditLog {
  constructor(path) {
    this.path = path;
  }

  /** Append one entry. Returns the entry as written. */
  write(entry) {
    const line = { time: new Date().toISOString(), ...entry };
    appendFileSync(this.path, JSON.stringify(line) + "\n");
    return line;
  }

  readAll() {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null; // skip a damaged line rather than crash the agent
        }
      })
      .filter(Boolean);
  }

  /**
   * Payments that count against the spending limits: [{ time, amount }] with amount in
   * base units (BigInt). A payment is logged as "pending" just before it is signed and
   * then as "settled" or "failed". Anything not known to have failed is counted, so a
   * crash in the middle of a payment can never make the budget look bigger than it is.
   */
  payments() {
    const byId = new Map();
    for (const entry of this.readAll()) {
      if (entry.phase !== "PAY" || !entry.paymentId) continue;
      const previous = byId.get(entry.paymentId);
      byId.set(entry.paymentId, { time: previous?.time ?? entry.time, amount: entry.amount, status: entry.status });
    }
    return [...byId.values()]
      .filter((payment) => payment.status !== "failed")
      .map((payment) => ({ time: Date.parse(payment.time), amount: BigInt(payment.amount) }));
  }
}
