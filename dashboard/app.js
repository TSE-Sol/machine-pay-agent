// Machine Pay Agent dashboard. Plain JavaScript, no build step.
//   - GET /state            : snapshot of robot, chargers, payments, approvals, kill switch
//   - GET /events (SSE)     : live events; agent phases arrive as type "agent_event"
//   - GET /dashboard/session: control token, given only to a browser on localhost
// All text from the agent or the LLM is inserted with textContent, never as HTML.

const $ = (id) => document.getElementById(id);
const usdc = (baseUnits) => (Number(baseUnits) / 1e6).toFixed(2);
const shorten = (text, head = 4, tail = 4) => (text && text.length > head + tail + 1 ? `${text.slice(0, head)}…${text.slice(-tail)}` : (text ?? "–"));
const clock = (iso) => new Date(iso).toLocaleTimeString("en-GB");

/** Tiny DOM builder: el("div", { class: "x", text: "hi" }, child, child) */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key.startsWith("data-")) node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

const state = {
  token: null, // null = read-only dashboard
  robot: null,
  robotSeenAt: 0,
  devices: [],
  payments: [],
  approval: null,
  paused: false,
  streams: { configured: false },
  justConfirmed: new Set(), // tx signatures to flash once
};

// --- Robot card --------------------------------------------------------------------------

const GAUGE_LENGTH = 364.4; // circumference of the gauge ring (r = 58)
const STATUS_LABEL = { delivering: "Delivering", seeking_charge: "Seeking charge", charging: "Charging", idle: "Battery flat", offline: "Offline" };

function renderRobot() {
  const robot = state.robot;
  const online = robot && Date.now() - state.robotSeenAt < 20_000;
  const status = online ? robot.status : "offline";
  $("robotStatus").dataset.state = status;
  $("robotStatus").querySelector(".label").textContent = STATUS_LABEL[status] ?? status;
  if (!robot) return;

  const battery = Math.max(0, Math.min(100, robot.batteryPct));
  $("batteryValue").textContent = battery;
  $("gaugeFill").style.strokeDashoffset = GAUGE_LENGTH * (1 - battery / 100);
  const gauge = $("gauge");
  gauge.dataset.level = battery < (robot.lowBatteryPct ?? 20) ? "critical" : battery < 40 ? "low" : "ok";
  gauge.dataset.charging = String(status === "charging");
  $("batteryCaption").textContent = status === "charging" ? "⚡ charging" : battery < (robot.lowBatteryPct ?? 20) ? "low battery" : "battery";

  $("robotId").textContent = robot.id;
  $("planner").textContent = robot.planner === "claude" ? `Claude · ${robot.model}` : "Rule-based (no API key)";
  $("wallet").textContent = shorten(robot.wallet, 6, 6);
  $("wallet").title = robot.wallet ?? "";

  const used = Number(robot.budgetUsed);
  const total = Number(robot.dailyBudget);
  const share = total > 0 ? Math.min(1, used / total) : 0;
  $("budgetUsed").textContent = `${usdc(used)} USDC`;
  $("budgetLeft").textContent = `${usdc(robot.budgetLeft)} USDC`;
  $("budgetTotal").textContent = `of ${usdc(total)} USDC`;
  $("budgetFill").style.width = `${share * 100}%`;
  $("budgetFill").dataset.level = share >= 1 ? "full" : share >= 0.8 ? "high" : "ok";
}

// --- Chargers + map ----------------------------------------------------------------------

function countdown(expiresAt) {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function renderChargers() {
  $("chargers").replaceChildren(
    ...state.devices.map((device) => {
      const charging = device.status === "charging";
      return el(
        "li",
        { class: "charger", "data-status": device.status },
        el("div", {}, el("div", { class: "charger-name", text: device.name }), el("div", { class: "charger-meta", text: `${device.id} · ${device.pricePer15MinUSDC.toFixed(2)} USDC / 15 min` })),
        el(
          "span",
          { class: "pill", "data-state": charging ? "charging" : "idle-charger" },
          el("span", { class: "dot" }),
          el("span", { class: "label", text: charging ? `Charging ${countdown(device.expiresAt)}` : "Idle" }),
        ),
      );
    }),
  );
  renderMap();
}

let map = null;
const markers = new Map();

function renderMap() {
  if (!window.L || state.devices.length === 0) return;
  if (!map) {
    map = L.map("map", { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap contributors" }).addTo(map);
    map.fitBounds(L.latLngBounds(state.devices.map((d) => [d.location.lat, d.location.lng])).pad(0.35));
  }
  const place = (key, location, html, title) => {
    const icon = L.divIcon({ html, className: "", iconSize: [22, 22], iconAnchor: [11, 11] });
    if (markers.has(key)) markers.get(key).setLatLng([location.lat, location.lng]).setIcon(icon);
    else markers.set(key, L.marker([location.lat, location.lng], { icon, title, keyboard: false }).addTo(map));
  };
  for (const device of state.devices) {
    place(device.id, device.location, `<div class="marker" data-status="${device.status === "charging" ? "charging" : "idle"}">⚡</div>`, device.name);
  }
  if (state.robot?.location) place("robot", state.robot.location, '<div class="marker-robot"></div>', "robot-01");
}

// --- Decision feed -----------------------------------------------------------------------

const cycles = new Map(); // cycleId -> { card, steps, charging }
let watching = null; // the single "all quiet" row, updated in place

function feedTop(node) {
  $("feedEmpty")?.remove();
  $("feed").prepend(node);
  while ($("feed").children.length > 40) $("feed").lastElementChild.remove();
}

function showWatching(event) {
  if (!watching || !watching.node.isConnected || $("feed").firstElementChild !== watching.node) {
    watching = { node: el("div", { class: "watching" }), count: 0 };
    feedTop(watching.node);
  }
  watching.count++;
  const robot = event.robot ?? {};
  watching.node.replaceChildren(
    el("span", { class: "dot" }),
    el("span", { text: `Observing: battery ${robot.batteryPct ?? "?"}%, above the ${robot.lowBatteryPct ?? 20}% threshold. Decision: keep delivering.` }),
    el("span", { class: "count", text: `${watching.count} check${watching.count === 1 ? "" : "s"} · ${clock(event.time)}` }),
  );
}

function cycleCard(event) {
  const id = event.data.cycleId ?? "unknown";
  if (cycles.has(id)) return cycles.get(id);
  const outcome = el("span", { class: "badge", "data-tone": "warn", text: "in progress" });
  const steps = el("div", { class: "steps" });
  const card = el(
    "article",
    { class: "cycle", "data-outcome": "running" },
    el("header", { class: "cycle-head" }, el("span", { class: "cycle-title", text: `Charge decision · ${clock(event.time)}` }), outcome),
    steps,
  );
  const entry = { card, steps, outcome, charging: null };
  cycles.set(id, entry);
  feedTop(card);
  return entry;
}

function setOutcome(cycle, outcome) {
  const tone = { charging: "good", refused: "bad", failed: "bad", done: "good" }[outcome] ?? "warn";
  const label = { charging: "paid · charging", refused: "refused", failed: "failed", done: "charged" }[outcome] ?? outcome;
  cycle.card.dataset.outcome = outcome === "done" ? "charging" : outcome;
  cycle.outcome.dataset.tone = tone;
  cycle.outcome.textContent = label;
}

function step(phase, ...body) {
  return el("div", { class: "step" }, el("span", { class: "phase", text: phase }), el("div", { class: "step-body" }, body));
}

function addAgentEvent(event) {
  const { phase, message, data = {} } = event;
  if (data.link) return; // the explorer URL line; the PAY step already links to it

  // Quiet ticks (battery fine, nothing to do) update one row instead of filling the feed.
  if ((phase === "OBSERVE" || phase === "DECIDE") && !cycles.has(data.cycleId)) {
    if (phase === "DECIDE" && data.chargeNeeded) {
      const cycle = cycleCard(event);
      cycle.steps.append(step("OBSERVE", `battery ${event.robot?.batteryPct ?? "?"}% · budget left ${usdc(event.robot?.budgetLeft ?? 0)} USDC`), step("DECIDE", message));
    } else if (phase === "DECIDE") {
      showWatching(event);
    }
    return;
  }

  const cycle = cycleCard(event);
  switch (phase) {
    case "PLAN": {
      if (!data.planner) return void cycle.steps.append(step("PLAN", message));
      const byClaude = data.planner === "claude";
      cycle.steps.append(
        step(
          "PLAN",
          el("div", {}, el("strong", { text: `${data.deviceId} · ${data.minutes} min` }), " ", el("span", { class: "badge", "data-tone": byClaude ? "accent" : "neutral", text: byClaude ? `Claude · ${data.model}` : "rule-based planner" })),
          el("div", { class: "reason" }, el("span", { class: "reason-by", text: byClaude ? "Claude's reason" : "Reason" }), el("span", { text: data.reason })),
        ),
      );
      break;
    }
    case "GUARD": {
      if (data.awaitingApproval) return void cycle.steps.append(step("GUARD", el("span", { class: "badge", "data-tone": "warn", text: "waiting for human approval" })));
      if (!data.checks) return void cycle.steps.append(step("GUARD", message));
      const chips = data.checks.map((check) => el("span", { class: "chip", "data-ok": String(check.ok), title: check.reason ?? "passed", text: `${check.ok ? "✓" : "✗"} ${check.name}` }));
      const approval = {
        "not-needed": ["true", "✓ approval not needed"],
        granted: ["true", `✓ approved${data.approvalBy ? ` (${data.approvalBy})` : ""}`],
        denied: ["false", `✗ denied${data.approvalBy ? ` (${data.approvalBy})` : ""}`],
        "not-asked": ["neutral", "approval not asked"],
      }[data.approval];
      if (approval) chips.push(el("span", { class: "chip", "data-ok": approval[0], text: approval[1] }));
      cycle.steps.append(step("GUARD", el("div", { class: "chips" }, chips)));
      break;
    }
    case "REFUSED":
      cycle.steps.append(step("REFUSED", el("div", { class: "refused", text: message })));
      setOutcome(cycle, "refused");
      break;
    case "PAY":
      if (data.txSignature) {
        cycle.steps.append(step("PAY", el("strong", { text: `${usdc(data.amount)} USDC` }), " paid · ", el("a", { href: data.explorerUrl, target: "_blank", rel: "noopener", class: "mono", text: `${shorten(data.txSignature, 6, 6)} ↗` })));
      } else {
        cycle.steps.append(step("PAY", message));
      }
      break;
    case "RECORD":
      cycle.steps.append(step("RECORD", message));
      if (data.outcome) setOutcome(cycle, data.outcome);
      break;
    case "CHARGING": {
      if (!cycle.charging) {
        const text = el("span");
        const bar = el("div");
        cycle.charging = { text, bar };
        cycle.steps.append(step("CHARGING", text, el("div", { class: "progress" }, bar)));
      }
      cycle.charging.text.textContent = `battery ${data.fromPct}% → ${data.batteryPct}%${data.done ? " · done, back to delivering" : ""}`;
      cycle.charging.bar.style.width = `${Math.min(100, data.batteryPct)}%`;
      if (data.done) setOutcome(cycle, "done");
      break;
    }
    default:
      cycle.steps.append(step(phase, message));
      if (data.failed) setOutcome(cycle, "failed");
  }
}

// --- Payments ----------------------------------------------------------------------------

function confirmation(on, label, detail, flash) {
  return el(
    "div",
    { class: `confirmation${flash ? " flash" : ""}`, "data-on": String(on) },
    el("span", { class: "mark", text: on ? "✓" : "" }),
    el("span", { text: label }),
    detail ? el("span", { class: "detail", text: detail }) : null,
  );
}

function renderPayments() {
  $("streamsState").textContent = state.streams.configured ? (state.streams.lastDelivery ? `Streams last delivery ${clock(state.streams.lastDelivery)}` : "Streams connected, waiting") : "QuickNode Streams not connected";
  if (state.payments.length === 0) return;
  $("payments").replaceChildren(
    ...state.payments.map((payment) => {
      const flash = state.justConfirmed.delete(payment.txSignature);
      const streamsLabel = payment.streamsConfirmed ? "QuickNode Streams confirmed" : state.streams.configured ? "QuickNode Streams: waiting for the block" : "QuickNode Streams: not connected";
      return el(
        "li",
        { class: "payment" },
        el("div", { class: "payment-top" }, el("span", { class: "payment-amount" }, usdc(payment.amount), " ", el("small", { text: "USDC" })), el("span", { class: "muted small", text: clock(payment.time) })),
        el("div", { class: "payment-meta", text: `${payment.deviceId} · ${payment.minutes} min · from ${shorten(payment.payer)}` }),
        el("a", { class: "payment-link", href: payment.explorerUrl, target: "_blank", rel: "noopener", text: `${shorten(payment.txSignature, 8, 8)} · Solana Explorer ↗` }),
        el(
          "div",
          { class: "confirmations" },
          confirmation(payment.facilitatorSettled, "Facilitator settled", payment.rpcCheck === "confirmed" ? "RPC re-check ok" : null, false),
          confirmation(payment.streamsConfirmed, streamsLabel, payment.streams?.slot ? `slot ${payment.streams.slot}` : null, flash),
        ),
      );
    }),
  );
}

// --- Approval modal ----------------------------------------------------------------------

function renderApproval() {
  const modal = $("approvalModal");
  const approval = state.approval;
  if (!approval) {
    if (modal.open) modal.close();
    return;
  }
  $("approvalAmount").textContent = usdc(approval.amount);
  $("approvalCharger").textContent = state.devices.find((d) => d.id === approval.deviceId)?.name ?? approval.deviceId;
  $("approvalMinutes").textContent = `${approval.minutes} minutes`;
  $("approvalPayTo").textContent = shorten(approval.payTo, 8, 8);
  $("approveButton").disabled = $("denyButton").disabled = !state.token;
  if (!state.token) $("approvalNote").textContent = "Read-only view: approvals can only be answered from the dashboard on localhost.";
  if (!modal.open) modal.showModal();
}

function tickApproval() {
  const approval = state.approval;
  if (!approval) return;
  const total = Date.parse(approval.expiresAt) - Date.parse(approval.createdAt);
  const left = Math.max(0, Date.parse(approval.expiresAt) - Date.now());
  $("approvalTimerFill").style.width = `${(left / total) * 100}%`;
  if (state.token) $("approvalNote").textContent = `No answer in ${Math.ceil(left / 1000)}s means no.`;
}

async function answerApproval(decision) {
  if (!state.approval) return;
  $("approveButton").disabled = $("denyButton").disabled = true;
  await control("POST", `/agent/approvals/${state.approval.id}`, { decision });
  await refresh();
}

// --- Kill switch -------------------------------------------------------------------------

function renderPause() {
  const button = $("killSwitch");
  button.disabled = !state.token;
  button.title = state.token ? "" : "Controls are only available from localhost";
  button.dataset.paused = String(state.paused);
  button.textContent = state.paused ? "Resume payments" : "Pause payments";
  $("pausedBanner").hidden = !state.paused;
}

// --- Data --------------------------------------------------------------------------------

function control(method, path, body) {
  return fetch(path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.token}` }, body: JSON.stringify(body) });
}

async function refresh() {
  const snapshot = await (await fetch("/state")).json();
  state.devices = snapshot.devices;
  state.payments = snapshot.payments;
  state.paused = snapshot.paused;
  state.streams = snapshot.streams;
  state.approval = snapshot.pendingApprovals[0] ?? null;
  if (snapshot.robot && !state.robot) {
    state.robot = snapshot.robot;
    state.robotSeenAt = Date.parse(snapshot.robot.lastSeen);
  }
  renderRobot();
  renderChargers();
  renderPayments();
  renderApproval();
  renderPause();
}

let refreshTimer = null;
const refreshSoon = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 80);
};

function onEvent(event) {
  switch (event.type) {
    case "agent_event":
      if (event.robot) {
        state.robot = event.robot;
        state.robotSeenAt = Date.parse(event.time);
        renderRobot();
        renderMap();
      }
      addAgentEvent(event);
      break;
    case "onchain_confirmed":
      if (event.matched) state.justConfirmed.add(event.txSignature);
      refreshSoon();
      break;
    case "payment_settled":
    case "charging_started":
    case "charging_ended":
    case "approval_requested":
    case "approval_resolved":
    case "agent_paused":
      refreshSoon();
      break;
  }
}

function connect() {
  const source = new EventSource("/events");
  const pill = $("conn");
  let lastId = 0;
  source.onopen = () => {
    pill.dataset.state = "live";
    pill.querySelector(".label").textContent = "Live";
    // The server replays recent events on every (re)connect, so rebuild the feed from scratch.
    lastId = 0;
    cycles.clear();
    watching = null;
    $("feed").replaceChildren(el("p", { class: "empty", id: "feedEmpty", text: "Waiting for the agent. Start it with npm run agent." }));
    refresh();
  };
  source.onerror = () => {
    pill.dataset.state = "down";
    pill.querySelector(".label").textContent = "Reconnecting";
  };
  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.id <= lastId) return;
    lastId = event.id;
    onEvent(event);
  };
}

async function start() {
  try {
    const session = await fetch("/dashboard/session");
    if (session.ok) state.token = (await session.json()).token;
  } catch {
    // read-only
  }
  $("killSwitch").addEventListener("click", async () => {
    await control("POST", "/agent/pause", { paused: !state.paused });
    await refresh();
  });
  $("approveButton").addEventListener("click", () => answerApproval("approve"));
  $("denyButton").addEventListener("click", () => answerApproval("deny"));
  $("approvalModal").addEventListener("cancel", (event) => event.preventDefault()); // Esc must not dismiss it silently

  await refresh();
  connect();
  setInterval(() => {
    renderRobot(); // notices when the agent goes quiet
    if (state.devices.some((d) => d.status === "charging")) renderChargers(); // countdowns
    tickApproval();
  }, 1000);
}

start();
