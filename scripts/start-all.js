// One command for the whole demo: server, public tunnel and agent in one terminal.
//
//   npm run start:all          start everything (named tunnel: permanent public URL)
//   npm run start:all:quick    the same with a throwaway quick tunnel (no Cloudflare setup needed)
//   npm run start:all:fresh    archive the audit log first (demo:reset), then start everything
//
// Order: the server starts first; once GET /health answers, the tunnel starts; once the
// tunnel has its public URL, the agent starts. If any one of them stops, all are stopped.
// Ctrl+C stops everything.
//
// It never stops or replaces something that is already running: if the port is taken, or an
// agent or tunnel is already up, it says what it found and starts nothing.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import concurrently from "concurrently";
import dotenv from "dotenv";
import { resetAuditLog, runningAgentPids } from "./demo-reset.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const red = (text) => `\x1b[1;31m${text}\x1b[0m`;
const green = (text) => `\x1b[32m${text}\x1b[0m`;

/** PIDs whose command line matches `pattern` (macOS / Linux). */
function pidsMatching(pattern) {
  if (process.platform === "win32") return [];
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).split("\n").map(Number).filter((pid) => pid > 0 && pid !== process.pid);
  } catch {
    return []; // pgrep exits non-zero when nothing matches
  }
}

function pidsListeningOn(port) {
  if (process.platform === "win32") return [];
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).split("\n").map(Number).filter((pid) => pid > 0);
  } catch {
    return [];
  }
}

/**
 * What is already running that start:all would collide with.
 * Returns a list of { what, pids, stop } (empty when the way is clear).
 */
export function findRunning({ port, pidFile, scanAgents = true }) {
  const found = [];
  const listeners = pidsListeningOn(port);
  if (listeners.length) found.push({ what: `a server is already listening on port ${port}`, pids: listeners, stop: "Ctrl+C in the terminal running `npm run dev` / `npm start`" });
  const devServers = pidsMatching("node --watch server/index.js").filter((pid) => !listeners.includes(pid));
  if (devServers.length) found.push({ what: "a dev server (`npm run dev`) is running or waiting to restart", pids: devServers, stop: "Ctrl+C in its terminal" });
  // This repo's tunnels only: a quick tunnel to this port, or the named tunnel run from tunnel/config.yml.
  // Any other cloudflared tunnel on the machine is none of our business and is ignored.
  const tunnels = [...new Set([...pidsMatching(`cloudflared tunnel.*localhost:${port}`), ...pidsMatching("cloudflared tunnel.*tunnel/config.yml")])];
  if (tunnels.length) found.push({ what: "this project's tunnel is already running", pids: tunnels, stop: "Ctrl+C in the terminal running `npm run tunnel`" });
  const agents = runningAgentPids({ pidFile, scanProcesses: scanAgents });
  if (agents.length) found.push({ what: "the agent is already running", pids: agents, stop: "Ctrl+C in the terminal running `npm run agent`" });
  return found;
}

/** The three processes, each waiting for the step before it. `quick` uses the throwaway tunnel. */
export function demoCommands({ quick = false } = {}) {
  return [
    { name: "server", prefixColor: "cyan", command: "node server/index.js" },
    { name: "tunnel", prefixColor: "magenta", command: `node scripts/wait-for.js health && node scripts/tunnel.js${quick ? " --quick" : ""}` },
    { name: "agent", prefixColor: "green", command: "node scripts/wait-for.js tunnel && node agent/index.js" },
  ];
}

/**
 * Run the commands together with [name] prefixes. When any one stops, the rest are stopped.
 * Resolves with { first, interrupted }: the process that ended first ({ name, exitCode }), and
 * whether the whole thing was stopped with Ctrl+C.
 */
export async function runTogether(commands, { cwd = root, env = {}, outputStream = process.stdout } = {}) {
  let first = null;
  let interrupted = false;
  const onInterrupt = () => (interrupted = true);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);

  const { commands: running, result } = concurrently(
    commands.map((command) => ({ ...command, cwd, env: { ...env, ...command.env } })),
    { prefix: "[{name}]", killOthersOn: ["failure", "success"], outputStream, handleInput: false },
  );
  for (const command of running) {
    command.close.subscribe((event) => {
      first ??= { name: command.name, exitCode: event.exitCode, killed: event.killed };
    });
  }
  await result.catch(() => {}); // a non-zero exit is reported through `first`, not thrown
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onInterrupt);
  return { first, interrupted };
}

/** Open the dashboard in Google Chrome (or the default browser) once the server is healthy. */
async function openDashboardWhenHealthy(port) {
  const url = `http://localhost:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const hasChrome = existsSync("/Applications/Google Chrome.app");
  spawn("open", hasChrome ? ["-a", "Google Chrome", url] : [url], { stdio: "ignore", detached: true }).unref();
}

async function main() {
  dotenv.config({ path: `${root}.env`, quiet: true });
  const port = process.env.PORT ?? 4020;
  const fresh = process.argv.includes("--fresh");
  const open = process.argv.includes("--open");
  const quick = process.argv.includes("--quick");

  // 1. Never disturb what is already running.
  const running = findRunning({ port, pidFile: `${root}agent/agent.pid` });
  if (running.length > 0) {
    console.error(red("start:all did not start anything, because parts of the demo are already running:"));
    for (const item of running) console.error(`  - ${item.what} (pid ${item.pids.join(", ")}). To stop it: ${item.stop}.`);
    console.error("Stop those yourself, then run this again. Nothing was stopped or changed.");
    process.exit(1);
  }

  // 2. Optional: a clean budget for the demo.
  if (fresh) {
    const reset = resetAuditLog({ auditPath: `${root}agent/audit.log`, archiveDir: `${root}agent/audit-archive`, pidFile: `${root}agent/agent.pid` });
    console.log(
      reset.archived
        ? `[start:all] demo:reset archived ${reset.payments} payments (${reset.spentUsdc.toFixed(2)} USDC) to ${reset.archivePath.replace(root, "")}; the 24-hour spend starts at zero.`
        : `[start:all] demo:reset had nothing to do: ${reset.reason}`,
    );
  }

  // 3. Start everything, in order.
  console.log(`[start:all] starting the server, then the tunnel, then the agent. Dashboard: http://localhost:${port}   (Ctrl+C stops everything)`);
  if (open) openDashboardWhenHealthy(port);
  const { first, interrupted } = await runTogether(demoCommands({ quick }), { env: { START_ALL_AT: String(Date.now()) } });

  if (interrupted) {
    console.log(green("\n[start:all] stopped by Ctrl+C. The server, tunnel and agent are all shut down."));
    process.exit(0);
  }
  const ok = first?.exitCode === 0;
  const how = ok ? "finished" : `stopped unexpectedly (exit code ${first?.exitCode})`;
  console.error((ok ? green : red)(`\n[start:all] the ${first?.name ?? "demo"} ${how}, so everything else was stopped too.`));
  if (!ok) console.error(red(`[start:all] Look at the last [${first?.name}] lines above for the reason.`));
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
