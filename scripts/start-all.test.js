// Tests for `npm run start:all`: start order, stopping everything when one part stops, and
// the "already running" guard. Real processes are used, but they are small stand-ins for the
// server, tunnel and agent on a spare port, so nothing here touches the real demo.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, test } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { demoCommands, findRunning, runTogether } from "./start-all.js";
import { loadTunnelConfig, parseTunnelConfig, tunnelConfigPath } from "./tunnel-config.js";
import { compareWithLast, readTunnelState, tunnelStateFile, writeTunnelState } from "./tunnel-state.js";

const tunnelStateUrl = pathToFileURL(fileURLToPath(new URL("./tunnel-state.js", import.meta.url))).href;

/** A port nothing is listening on. */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const portIsFree = (port) =>
  new Promise((resolve) => {
    const probe = createServer()
      .once("error", () => resolve(false))
      .listen(port, () => probe.close(() => resolve(true)));
  });

/** Stand-ins for the three processes, wired together with the real wait-for.js steps. */
function standIns({ port, agentExitCode = 0, serverCrashes = false }) {
  const dir = mkdtempSync(join(tmpdir(), "start-all-test-"));
  writeFileSync(
    join(dir, "server.mjs"),
    serverCrashes
      ? `console.log("server failed to start"); process.exit(1);`
      : `import { createServer } from "node:http";
         setTimeout(() => createServer((req, res) => res.end(JSON.stringify({ ok: true }))).listen(${port}, () => console.log("server listening")), 300);`,
  );
  writeFileSync(
    join(dir, "tunnel.mjs"),
    `import { writeTunnelState } from "${tunnelStateUrl}";
     writeTunnelState(${port}, { url: "https://test.example", webhookUrl: "https://test.example/streams/webhook", pid: process.pid, capturedAt: new Date().toISOString() });
     console.log("tunnel url captured"); setInterval(() => {}, 1000);`,
  );
  writeFileSync(join(dir, "agent.mjs"), `console.log("agent started"); setTimeout(() => process.exit(${agentExitCode}), 300);`);
  return [
    { name: "server", command: `node ${join(dir, "server.mjs")}` },
    { name: "tunnel", command: `node scripts/wait-for.js health && node ${join(dir, "tunnel.mjs")}` },
    { name: "agent", command: `node scripts/wait-for.js tunnel && node ${join(dir, "agent.mjs")}` },
  ];
}

async function run(options) {
  const port = await freePort();
  let output = "";
  const outputStream = new Writable({ write: (chunk, encoding, done) => ((output += chunk.toString()), done()) });
  const result = await runTogether(standIns({ port, ...options }), { env: { PORT: String(port), START_ALL_AT: String(Date.now()) }, outputStream });
  rmSync(tunnelStateFile(port), { force: true });
  return { ...result, output, port };
}

describe("start:all", () => {
  test("starts the server, then the tunnel once /health answers, then the agent once the tunnel URL exists", async () => {
    const { output, first } = await run({});
    const order = ["server listening", "server is healthy", "tunnel url captured", "tunnel is up", "agent started"].map((line) => output.indexOf(line));
    assert.ok(order.every((position) => position >= 0), `every step should appear in the output:\n${output}`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `steps out of order:\n${output}`);
    assert.match(output, /\[server\]/);
    assert.match(output, /\[tunnel\]/);
    assert.match(output, /\[agent\]/);
    assert.deepEqual([first.name, first.exitCode], ["agent", 0]);
  });

  test("when one process crashes, the others are stopped and the crash is reported", async () => {
    const { first, port } = await run({ agentExitCode: 1 });
    assert.deepEqual([first.name, first.exitCode], ["agent", 1]);
    assert.equal(await portIsFree(port), true, "the server stand-in was stopped, so its port is free again");
  });

  test("if the server never comes up, nothing else starts and everything stops quickly", async () => {
    const started = Date.now();
    const { first, output } = await run({ serverCrashes: true });
    assert.deepEqual([first.name, first.exitCode], ["server", 1]);
    assert.doesNotMatch(output, /tunnel url captured|agent started/);
    assert.ok(Date.now() - started < 10_000, "did not sit waiting for the health check to time out");
  });

  test("the real commands start the server first and make the tunnel and agent wait", () => {
    const [server, tunnel, agent] = demoCommands();
    assert.deepEqual([server.name, tunnel.name, agent.name], ["server", "tunnel", "agent"]);
    assert.equal(server.command, "node server/index.js");
    assert.match(tunnel.command, /^node scripts\/wait-for\.js health && node scripts\/tunnel\.js$/, "named tunnel by default");
    assert.match(demoCommands({ quick: true })[1].command, /^node scripts\/wait-for\.js health && node scripts\/tunnel\.js --quick$/);
    assert.match(agent.command, /^node scripts\/wait-for\.js tunnel && node agent\/index\.js$/);
    assert.equal(new Set([server.prefixColor, tunnel.prefixColor, agent.prefixColor]).size, 3, "each prefix has its own color");
  });
});

describe("already-running guard", () => {
  test("reports a server that is already listening on the port", async () => {
    const port = await freePort();
    const pidFile = join(mkdtempSync(join(tmpdir(), "start-all-test-")), "agent.pid");
    const before = findRunning({ port, pidFile, scanAgents: false }).filter((item) => item.what.includes(`port ${port}`));
    assert.deepEqual(before, []);

    const occupied = createServer().listen(port);
    await new Promise((resolve) => occupied.once("listening", resolve));
    const found = findRunning({ port, pidFile, scanAgents: false }).find((item) => item.what.includes("already listening"));
    occupied.close();
    assert.ok(found, "the listener was detected");
    assert.deepEqual(found.pids, [process.pid]);
  });

  test("reports a running agent from its pid file", () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "start-all-test-")), "agent.pid");
    writeFileSync(pidFile, String(process.pid));
    const found = findRunning({ port: 1, pidFile, scanAgents: false }).find((item) => item.what.includes("agent"));
    assert.deepEqual(found.pids, [process.pid]);
  });
});

describe("named tunnel config", () => {
  test("the repo's tunnel/config.yml names a tunnel, a hostname and the local server, and holds no credentials", () => {
    const text = readFileSync(tunnelConfigPath, "utf8");
    const config = parseTunnelConfig(text);
    assert.match(config.tunnelId, /^[0-9a-f-]{36}$/);
    assert.equal(config.hostname, "pay.sentrumten.com");
    assert.deepEqual([config.service, config.servicePort], ["http://localhost:4020", 4020]);
    assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ""), /credentials-file|TunnelSecret|AccountTag/, "credentials stay in ~/.cloudflared");
  });

  test("the credentials file is looked for in ~/.cloudflared, named after the tunnel id", () => {
    const config = loadTunnelConfig();
    assert.equal(config.credentialsFile, join(homedir(), ".cloudflared", `${config.tunnelId}.json`));
  });

  test("comments and missing values are handled", () => {
    assert.deepEqual(parseTunnelConfig("# tunnel: commented-out\n"), { tunnelId: null, hostname: null, service: null, servicePort: null });
    assert.equal(loadTunnelConfig("/no/such/config.yml"), null);
  });
});

describe("tunnel URL record", () => {
  test("remembers the last URL per port and tells first / same / changed apart", async () => {
    const port = await freePort();
    assert.equal(readTunnelState(port), null);
    assert.equal(compareWithLast(readTunnelState(port), "https://a.example/streams/webhook"), "first");

    writeTunnelState(port, { url: "https://a.example", webhookUrl: "https://a.example/streams/webhook", pid: 1, capturedAt: new Date().toISOString() });
    assert.equal(compareWithLast(readTunnelState(port), "https://a.example/streams/webhook"), "same");
    assert.equal(compareWithLast(readTunnelState(port), "https://b.example/streams/webhook"), "changed");
    rmSync(tunnelStateFile(port), { force: true });
  });
});
