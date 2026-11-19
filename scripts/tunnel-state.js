// Remembers the tunnel's public URL between runs, in .cache/ (gitignored), one file per port.
// Used to warn when the URL has changed and to let start:all know the tunnel is up.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cacheDir = fileURLToPath(new URL("../.cache/", import.meta.url));
export const tunnelStateFile = (port) => `${cacheDir}tunnel-${port}.json`;

/** { url, webhookUrl, pid, capturedAt } or null. */
export function readTunnelState(port) {
  try {
    return existsSync(tunnelStateFile(port)) ? JSON.parse(readFileSync(tunnelStateFile(port), "utf8")) : null;
  } catch {
    return null; // unreadable file: treat as no record
  }
}

/** How a new webhook URL relates to the one recorded before: "first", "changed" or "same". */
export function compareWithLast(previous, webhookUrl) {
  if (!previous?.webhookUrl) return "first";
  return previous.webhookUrl === webhookUrl ? "same" : "changed";
}

export function writeTunnelState(port, state) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(tunnelStateFile(port), JSON.stringify(state, null, 2) + "\n");
}
