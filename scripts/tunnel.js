// Gives the local server a public URL through Cloudflare, so QuickNode Streams can reach
// POST /streams/webhook.
//
//   npm run tunnel         named tunnel from tunnel/config.yml: a permanent URL that never changes
//   npm run tunnel:quick   throwaway trycloudflare.com tunnel: no setup, but a new URL every start
//
// Keep it running; Ctrl+C closes the tunnel. Either way it prints the webhook URL the
// QuickNode Stream must use, and says loudly if that differs from the last run.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";
import { loadTunnelConfig } from "./tunnel-config.js";
import { compareWithLast, readTunnelState, writeTunnelState } from "./tunnel-state.js";

dotenv.config({ quiet: true });
const port = process.env.PORT ?? 4020;
const quick = process.argv.includes("--quick");

const useColor = process.stdout.isTTY || Boolean(process.env.FORCE_COLOR);
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const red = (text) => paint("1;31", text);
const green = (text) => paint("32", text);
const bold = (text) => paint("1", text);

if (spawnSync("cloudflared", ["--version"]).error) {
  console.error("cloudflared is not installed. Install it with:  brew install cloudflared");
  process.exit(1);
}

/** Print the webhook URL banner and remember the URL for next time. */
function announce(url, { permanent }) {
  const webhookUrl = `${url}/streams/webhook`;
  const previous = readTunnelState(port); // the URL the last tunnel on this port had
  writeTunnelState(port, { url, webhookUrl, pid: process.pid, capturedAt: new Date().toISOString() });

  const rule = "=".repeat(Math.max(60, webhookUrl.length + 4));
  console.log(`\n${rule}`);
  console.log(bold("  QuickNode Stream destination must be:"));
  console.log(bold(`  ${webhookUrl}`));
  console.log(`${rule}`);
  const change = compareWithLast(previous, webhookUrl);
  if (change === "first") {
    console.log("First tunnel recorded on this machine: set this URL as the Stream's destination in QuickNode.");
  } else if (change === "changed") {
    console.log(red("⚠ TUNNEL URL CHANGED — update the Stream destination in QuickNode"));
    console.log(red(`  it was: ${previous.webhookUrl}`));
  } else {
    console.log(green("Same URL as last time: nothing to change in QuickNode."));
  }
  if (permanent) console.log("This is a named tunnel: the URL stays the same on every start.");
  else console.log("\nThis is a quick tunnel: the address is new on every start and can take up to a minute to resolve.");
  console.log("The whole server is reachable at this URL while the tunnel runs. The dashboard is read-only");
  console.log("for remote visitors; approvals, voice and the kill switch only work from localhost.\n");
}

let cloudflaredArgs;
let onLine; // looks at each line of cloudflared's output for the moment the tunnel is up
let announced = false;

if (quick) {
  console.log(`Opening a quick tunnel to http://localhost:${port} ...`);
  // Point cloudflared at an empty config file. Otherwise an existing ~/.cloudflared/config.yml
  // (from a named tunnel) takes over the routing and every request returns 404.
  const emptyConfig = join(mkdtempSync(join(tmpdir(), "machine-pay-tunnel-")), "config.yml");
  writeFileSync(emptyConfig, "");
  cloudflaredArgs = ["tunnel", "--config", emptyConfig, "--url", `http://localhost:${port}`];
  onLine = (line) => {
    const url = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    if (url && !announced) {
      announced = true;
      announce(url, { permanent: false });
    }
  };
} else {
  const config = loadTunnelConfig();
  const problem = !config
    ? "tunnel/config.yml is missing."
    : !config.tunnelId || !config.hostname
      ? "tunnel/config.yml needs a `tunnel:` id and an ingress `hostname:`."
      : !existsSync(config.credentialsFile)
        ? `this machine has no credentials for tunnel ${config.tunnelId} (expected ~/.cloudflared/${config.tunnelId}.json).`
        : null;
  if (problem) {
    console.error(red(`The named tunnel can't start: ${problem}`));
    console.error("Use the quick tunnel instead (`npm run tunnel:quick` or `npm run start:all:quick`),");
    console.error('or set up your own named tunnel: see "Named tunnel" in the README.');
    process.exit(1);
  }
  if (config.servicePort !== Number(port)) {
    console.error(red(`tunnel/config.yml sends traffic to port ${config.servicePort}, but PORT is ${port}. Make them match.`));
    process.exit(1);
  }
  console.log(`Connecting the named tunnel: https://${config.hostname} -> ${config.service} ...`);
  // --config keeps this tunnel on its own config file; nothing in ~/.cloudflared/config.yml is read.
  cloudflaredArgs = ["tunnel", "--config", config.path, "run", "--credentials-file", config.credentialsFile];
  onLine = (line) => {
    if (/Registered tunnel connection/.test(line) && !announced) {
      announced = true;
      announce(`https://${config.hostname}`, { permanent: true });
    }
  };
}

const tunnel = spawn("cloudflared", cloudflaredArgs, { stdio: ["ignore", "pipe", "pipe"] });

let closing = false; // once we are shutting down, cloudflared's "connection terminated" noise is expected
const onOutput = (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    onLine(line);
    // Show cloudflared's errors, except its complaint about the deliberately empty quick-tunnel config.
    if (!closing && /\bERR\b/.test(line) && !/was empty/.test(line)) console.error(line.trim());
  }
};
tunnel.stdout.on("data", onOutput);
tunnel.stderr.on("data", onOutput);

tunnel.on("exit", (code) => {
  console.log(`Tunnel closed${code ? ` (cloudflared exit code ${code})` : ""}.`);
  process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    closing = true;
    tunnel.kill(signal);
  });
}
