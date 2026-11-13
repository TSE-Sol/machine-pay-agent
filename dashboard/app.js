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
  voice: { available: false, on: false, muted: false, volume: 0.8 }, // available = the server has an ElevenLabs key
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
  // Display only: the dashboard shows the budget and has no way to change it.
  const level = share >= 0.9 ? "red" : share >= 0.75 ? "amber" : "ok";
  $("budgetFill").style.width = `${share * 100}%`;
  $("budgetFill").dataset.level = level;
  $("budgetFill").closest(".budget").dataset.level = level;
  $("budgetFill").parentElement.setAttribute("aria-label", `Budget used: ${Math.round(share * 100)} percent`);
  const resets = robot.budgetNextResetAt ? `; the oldest counted payment expires ${whenText(robot.budgetNextResetAt)}` : "";
  $("budgetNote").textContent = used > 0 ? `${share >= 1 ? "Budget reached. " : ""}Resets as payments age out${resets}.` : "Nothing spent in the last 24 hours.";
}

/** "today 18:25" / "tomorrow 18:25" / "Sat 18:25" */
function whenText(iso) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : date.toLocaleDateString("en-GB", { weekday: "short" });
  return `${day} at ${time}`;
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
let mapMovedByViewer = false; // once the viewer zooms or pans, stop refitting the view for them
let fittingMap = false;
let fittedTo = ""; // the set of points the current fitted view was computed for

/** Everything the map should show: every charger, and the robot once it has reported in. */
function mapPoints() {
  const points = state.devices.map((d) => [d.location.lat, d.location.lng]);
  if (state.robot?.location) points.push([state.robot.location.lat, state.robot.location.lng]);
  return points;
}

/** Zoom and pan so all chargers and the robot are in view, with some padding. */
function fitMap({ animate = false } = {}) {
  const points = mapPoints();
  if (!map || points.length === 0) return;
  fittingMap = true;
  map.fitBounds(L.latLngBounds(points), { padding: [28, 28], maxZoom: 16, animate });
  fittedTo = JSON.stringify(points);
  mapMovedByViewer = false;
  if (!animate) fittingMap = false; // an animated fit clears the flag when it finishes (moveend)
}

function createMap() {
  map = L.map("map", {
    zoomControl: true, // + / - buttons
    scrollWheelZoom: true, // mouse wheel, and trackpad pinch (which browsers send as wheel events)
    touchZoom: true, // two-finger pinch on touch screens
    dragging: true, // drag to pan
    doubleClickZoom: true,
    zoomSnap: 0.25, // lets the fitted view sit snugly around the points
    zoomDelta: 0.5,
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);

  // Any move that we didn't start is the viewer's: leave their view alone from then on.
  map.on("movestart", () => {
    if (!fittingMap) mapMovedByViewer = true;
  });
  map.on("moveend", () => {
    fittingMap = false;
  });

  // "Recenter": back to the view that fits every charger and the robot.
  const Recenter = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const button = L.DomUtil.create("button", "map-recenter");
      button.type = "button";
      button.textContent = "Recenter";
      button.title = "Show all chargers and the robot";
      L.DomEvent.disableClickPropagation(button);
      L.DomEvent.on(button, "click", () => fitMap({ animate: true }));
      return button;
    },
  });
  map.addControl(new Recenter());

  // Leaflet measures its container once. Re-measure after the panel has laid out and whenever
  // it changes size, or tiles render for the wrong area and part of the map stays blank.
  const settle = () => {
    map.invalidateSize();
    if (!mapMovedByViewer) fitMap();
  };
  requestAnimationFrame(settle);
  new ResizeObserver(settle).observe($("map"));
  fitMap();
}

function renderMap() {
  if (!window.L || state.devices.length === 0) return;
  if (!map) createMap();

  const place = (key, location, html, title) => {
    const marker = markers.get(key);
    if (!marker) {
      const icon = L.divIcon({ html, className: "", iconSize: [22, 22], iconAnchor: [11, 11] });
      markers.set(key, Object.assign(L.marker([location.lat, location.lng], { icon, title, keyboard: false }).addTo(map), { shownAs: html }));
      return;
    }
    marker.setLatLng([location.lat, location.lng]);
    if (marker.shownAs !== html) {
      marker.setIcon(L.divIcon({ html, className: "", iconSize: [22, 22], iconAnchor: [11, 11] }));
      marker.shownAs = html;
    }
  };
  for (const device of state.devices) {
    place(device.id, device.location, `<div class="marker" data-status="${device.status === "charging" ? "charging" : "idle"}">⚡</div>`, device.name);
  }
  if (state.robot?.location) place("robot", state.robot.location, '<div class="marker-robot"></div>', state.robot.id ?? "robot");

  // The robot appeared or moved: refit, unless the viewer has taken over the view.
  if (!mapMovedByViewer && fittedTo !== JSON.stringify(mapPoints())) fitMap();
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
    case "REFUSED": {
      // The daily budget is the limit most worth noticing, so it gets a headline.
      const overBudget = message.startsWith("daily:");
      cycle.steps.append(
        step("REFUSED", el("div", { class: "refused" }, overBudget ? el("span", { class: "refused-title", text: "Daily budget reached. No more power will be bought until it resets." }) : null, el("span", { text: message }))),
      );
      setOutcome(cycle, "refused");
      break;
    }
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

// --- Voice: the robot speaks (ElevenLabs TTS), the operator commands (ElevenLabs STT) ------

const speechQueue = [];
let speaking = false;
let currentAudio = null;

// The volume is the listener's own preference, so it is kept in this browser only.
function loadVolume() {
  try {
    const saved = Number(localStorage.getItem("machinePay.volume"));
    if (localStorage.getItem("machinePay.volume") !== null && saved >= 0 && saved <= 1) state.voice.volume = saved;
  } catch {
    // storage unavailable (private window, blocked): keep the default
  }
}

function setVolume(volume) {
  state.voice.volume = Math.max(0, Math.min(1, volume));
  if (currentAudio) currentAudio.volume = state.voice.volume; // applies to the line being spoken too
  try {
    localStorage.setItem("machinePay.volume", String(state.voice.volume));
  } catch {
    // not saved; still applies for this visit
  }
  renderVolume();
}

function renderVolume() {
  const percent = Math.round(state.voice.volume * 100);
  $("volume").value = percent;
  $("volume").disabled = !state.voice.available;
  $("volumeLabel").textContent = `${percent}%`;
}

function playNext() {
  if (speaking) return;
  const next = speechQueue.shift();
  if (!next) return;
  speaking = true;
  $("speech").dataset.speaking = "true";
  const audio = new Audio(next);
  audio.volume = state.voice.volume;
  currentAudio = audio;
  const done = () => {
    speaking = false;
    currentAudio = null;
    $("speech").dataset.speaking = "false";
    playNext();
  };
  audio.onended = done;
  audio.onerror = done;
  audio.play().catch(done); // blocked or failed: skip this line
}

function onRobotSpeech(event) {
  $("speech").hidden = false;
  $("speechText").textContent = `“${event.text}”`;
  // Only speak lines that are happening now, not the history replayed on page load.
  const fresh = Date.now() - Date.parse(event.time) < 15_000;
  if (fresh && event.audioUrl && state.voice.on && !state.voice.muted) {
    speechQueue.push(event.audioUrl);
    playNext();
  }
}

function onVoiceCommand(event) {
  feedTop(
    el(
      "div",
      { class: "heard" },
      el("span", { text: "🎙" }),
      el("span", { class: "said", text: `“${event.transcript || "(nothing heard)"}”` }),
      el("span", { text: "→" }),
      el("span", { class: "badge", "data-tone": event.command ? (event.done ? "good" : "warn") : "neutral", text: event.command ? `${event.command.toUpperCase()} (voice)` : "no action" }),
      el("span", { class: "outcome", text: `${event.outcome} · ${clock(event.time)}` }),
    ),
  );
}

function renderVoice() {
  const voice = state.voice;
  const button = $("voiceButton");
  button.disabled = !voice.available;
  if (!voice.available) {
    button.textContent = "Voice off";
    button.title = "Voice is disabled: ELEVENLABS_API_KEY is not set on the server";
  } else if (!voice.on) {
    button.textContent = "Enable voice";
    button.title = "Browsers only allow sound after a click";
    button.dataset.state = "off";
  } else {
    button.textContent = voice.muted ? "🔇 Voice muted" : "🔊 Voice on";
    button.title = voice.muted ? "Click to unmute the robot" : "Click to mute the robot";
    button.dataset.state = voice.muted ? "muted" : "on";
  }
  // Two mic buttons share one behaviour: the top bar, and the approval dialog (which covers the top bar).
  for (const mic of micButtons()) {
    mic.disabled = !voice.available || !state.token;
    if (!voice.available) mic.title = "Voice is disabled: ELEVENLABS_API_KEY is not set on the server";
    else if (!state.token) mic.title = "Voice commands only work from the dashboard on localhost";
  }
}

const micButtons = () => [$("micButton"), $("modalMicButton")];

// Voice picker: a short list of voices chosen on the server. Localhost + token only.
async function loadVoices() {
  if (!state.token || !state.voice.available) return;
  const response = await fetch("/voice/voices", { headers: { Authorization: `Bearer ${state.token}` } }).catch(() => null);
  if (!response?.ok) return;
  const { current, voices } = await response.json();
  $("voicePicker").replaceChildren(
    ...voices.map((voice) => el("option", { value: voice.voiceId, text: `${voice.name}${voice.style ? ` · ${voice.style}` : ""}${voice.isDefault ? " (default)" : ""}`, selected: voice.voiceId === current })),
  );
  $("voiceRow").hidden = false;
}

async function chooseVoice() {
  await control("POST", "/voice/voice", { voiceId: $("voicePicker").value });
}

async function previewVoice() {
  if (!state.voice.on) state.voice.on = true; // the click on Preview allows sound
  state.voice.muted = false;
  renderVoice();
  await control("POST", "/voice/preview", {});
}

function toggleVoice() {
  if (!state.voice.on) state.voice.on = true; // this click is what lets the browser play audio
  else state.voice.muted = !state.voice.muted;
  if (state.voice.muted) speechQueue.length = 0;
  renderVoice();
}

// Push-to-talk: hold the mic button, speak, release. The recording goes to the server,
// which transcribes it with ElevenLabs and matches it against five fixed commands.
let micStream = null;
let recorder = null;
let holding = false;

function micLabel(text, state_) {
  for (const mic of micButtons()) {
    mic.textContent = text;
    mic.dataset.state = state_ ?? "";
  }
}

async function startTalking() {
  if (holding || recorder) return;
  holding = true;
  try {
    micStream ??= await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    holding = false;
    return micLabel("🎙 Mic blocked");
  }
  if (!holding) return micLabel("🎙 Mic ready, hold to talk"); // released while the permission prompt was open
  const chunks = [];
  recorder = new MediaRecorder(micStream);
  recorder.ondataavailable = (event) => chunks.push(event.data);
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    recorder = null;
    sendRecording(blob);
  };
  recorder.start();
  micLabel("🎙 Listening… release to send", "listening");
}

function stopTalking() {
  holding = false;
  if (recorder?.state === "recording") recorder.stop();
}

async function sendRecording(blob) {
  if (blob.size < 1000) return micLabel("🎙 Hold to talk");
  micLabel("🎙 Transcribing…", "busy");
  try {
    // The result appears in the feed through the event stream (type "voice_command").
    await fetch("/voice/command", { method: "POST", headers: { "Content-Type": blob.type || "audio/webm", Authorization: `Bearer ${state.token}` }, body: blob });
  } finally {
    micLabel("🎙 Hold to talk");
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
  state.voice.available = Boolean(snapshot.voice?.enabled);
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
  renderVoice();
  renderVolume();
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
    case "robot_speech":
      onRobotSpeech(event);
      break;
    case "voice_command":
      onVoiceCommand(event);
      break;
    case "voice_changed":
      $("voicePicker").value = event.voiceId;
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
  $("voiceButton").addEventListener("click", toggleVoice);
  $("volume").addEventListener("input", (event) => setVolume(Number(event.target.value) / 100));
  $("voicePicker").addEventListener("change", chooseVoice);
  $("previewButton").addEventListener("click", previewVoice);
  loadVolume();
  // Any first click on the page also turns the robot's voice on (the browser allows sound from
  // then on). This matters when the approval dialog is already covering the Enable voice button.
  document.addEventListener("pointerdown", (event) => {
    if (state.voice.available && !state.voice.on && event.target !== $("voiceButton")) {
      state.voice.on = true;
      renderVoice();
    }
  });
  for (const mic of micButtons()) {
    mic.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      startTalking();
    });
    for (const release of ["pointerup", "pointerleave", "pointercancel"]) mic.addEventListener(release, stopTalking);
    mic.addEventListener("keydown", (event) => {
      if ((event.key === " " || event.key === "Enter") && !event.repeat) startTalking();
    });
    mic.addEventListener("keyup", (event) => {
      if (event.key === " " || event.key === "Enter") stopTalking();
    });
  }

  await refresh();
  await loadVoices();
  connect();
  setInterval(() => {
    renderRobot(); // notices when the agent goes quiet
    if (state.devices.some((d) => d.status === "charging")) renderChargers(); // countdowns
    tickApproval();
  }, 1000);
}

start();
