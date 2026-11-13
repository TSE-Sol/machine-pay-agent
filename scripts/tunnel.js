// Opens a public URL for the local server with a Cloudflare quick tunnel, so QuickNode
// Streams can reach POST /streams/webhook during local development.
//
// Usage: npm run tunnel        (keep it running; Ctrl+C closes the tunnel)
// The URL changes every time the tunnel restarts, so update the Stream's destination then.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";

dotenv.config({ quiet: true });
const port = process.env.PORT ?? 4020;

if (spawnSync("cloudflared", ["--version"]).error) {
  console.error("cloudflared is not installed. Install it with:  brew install cloudflared");
  process.exit(1);
}

console.log(`Opening a public tunnel to http://localhost:${port} ...`);
// Point cloudflared at an empty config file. Otherwise an existing ~/.cloudflared/config.yml
// (from a named tunnel) takes over the routing and every request returns 404.
const emptyConfig = join(mkdtempSync(join(tmpdir(), "machine-pay-tunnel-")), "config.yml");
writeFileSync(emptyConfig, "");
const tunnel = spawn("cloudflared", ["tunnel", "--config", emptyConfig, "--url", `http://localhost:${port}`], {
  stdio: ["ignore", "pipe", "pipe"],
});

let announced = false;
const onOutput = (chunk) => {
  const text = chunk.toString();
  const url = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (url && !announced) {
    announced = true;
    console.log(`\nTunnel is up:  ${url}`);
    console.log(`\nQuickNode Streams destination URL (paste this into the Stream):\n\n  ${url}/streams/webhook\n`);
    console.log("A new tunnel address can take up to a minute to start resolving.\n");
    console.log("Note: the whole server is reachable at this URL while the tunnel runs. The dashboard is");
    console.log("read-only for remote visitors; approvals and the kill switch only work from localhost.\n");
  }
  // Show cloudflared's errors, except its complaint about the deliberately empty config file.
  for (const line of text.split("\n")) if (/\bERR\b/.test(line) && !/was empty/.test(line)) console.error(line.trim());
};
tunnel.stdout.on("data", onOutput);
tunnel.stderr.on("data", onOutput);

tunnel.on("exit", (code) => {
  console.log(`Tunnel closed${code ? ` (cloudflared exit code ${code})` : ""}.`);
  process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => tunnel.kill(signal));
