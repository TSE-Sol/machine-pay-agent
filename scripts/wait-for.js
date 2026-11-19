// Waits for a step of the demo startup to be ready, then exits 0 (or exits 1 on timeout).
//   node scripts/wait-for.js health   - the server answers GET /health with { ok: true }
//   node scripts/wait-for.js tunnel   - the tunnel has captured its public URL in this run
// Used by scripts/start-all.js to start things in order.
import dotenv from "dotenv";
import { readTunnelState } from "./tunnel-state.js";

dotenv.config({ quiet: true });
const port = process.env.PORT ?? 4020;
const what = process.argv[2];
const startedAt = Number(process.env.START_ALL_AT ?? 0); // only a tunnel captured after this counts
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = {
  health: {
    timeoutSeconds: 60,
    waitingFor: `the server on port ${port}`,
    async ready() {
      try {
        const response = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1500) });
        return response.ok && (await response.json()).ok === true ? "server is healthy" : null;
      } catch {
        return null;
      }
    },
  },
  tunnel: {
    timeoutSeconds: 90,
    waitingFor: "the tunnel's public URL",
    async ready() {
      const state = readTunnelState(port);
      return state && Date.parse(state.capturedAt) >= startedAt ? `tunnel is up (${state.url})` : null;
    },
  },
};

const check = checks[what];
if (!check) {
  console.error(`usage: node scripts/wait-for.js ${Object.keys(checks).join(" | ")}`);
  process.exit(2);
}

const deadline = Date.now() + check.timeoutSeconds * 1000;
while (Date.now() < deadline) {
  const ready = await check.ready();
  if (ready) {
    console.log(ready);
    process.exit(0);
  }
  await sleep(500);
}
console.error(`gave up waiting for ${check.waitingFor} after ${check.timeoutSeconds}s`);
process.exit(1);
