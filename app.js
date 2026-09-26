// API_BASE lives in site-config.js, shared with reset.html.
// Each entry in TANKS is one physical tank (one ESP32 + one sensor).
const TANKS = [
  { id: "tank1", name: "Tank 1" },
  { id: "tank2", name: "Tank 2" },
];
const POLL_INTERVAL_MS = 5000;
const STALE_THRESHOLD_MS = 15000; // ~3x the firmware's push interval
const VALVE_BLINK_MS = 10000;

let unlockedPassword = null; // kept in memory only, cleared on page reload

// Mirrors the Worker's own derivation, so the UI can update instantly on
// save without waiting on a re-fetch -- the Worker remains the source of
// truth for what's actually stored.
function computeCapacityL(diameterMm, heightMm) {
  const radiusMm = diameterMm / 2;
  return Math.max(1, Math.round((Math.PI * radiusMm * radiusMm * heightMm) / 1e6));
}

async function fetchJson(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) return null;
  return res.json();
}

function fetchTelemetry(tankId) {
  return fetchJson(`/api/tanks/${tankId}/telemetry`);
}

function fetchConfig(tankId) {
  return fetchJson(`/api/tanks/${tankId}/config`);
}

async function verifyPassword(password) {
  const res = await fetch(`${API_BASE}/api/verify-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return { ok: res.ok, status: res.status };
}

async function saveConfig(tankId, outletMm, overflowMm, diameterMm, heightMm, alias, password) {
  const res = await fetch(`${API_BASE}/api/tanks/${tankId}/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Dashboard-Password": password,
    },
    body: JSON.stringify({
      sensor_outlet_mm: outletMm,
      sensor_overflow_mm: overflowMm,
      diameter_mm: diameterMm,
      height_mm: heightMm,
      alias,
    }),
  });
  return { ok: res.ok, status: res.status };
}

async function changePassword(currentPassword, newPassword) {
  const res = await fetch(`${API_BASE}/api/change-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Dashboard-Password": currentPassword,
    },
    body: JSON.stringify({ newPassword }),
  });
  return { ok: res.ok, status: res.status };
}

// Same thresholds as the firmware's own signalQuality() in wifi_provision.h.
function wifiQualityLabel(rssi) {
  if (typeof rssi !== "number") return "--";
  if (rssi >= -60) return "Excellent";
  if (rssi >= -70) return "Good";
  if (rssi >= -80) return "Fair";
  return "Weak";
}

async function requestPasswordReset(email) {
  const res = await fetch(`${API_BASE}/api/reset-request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return res.ok;
}

// Builds one tank card's DOM. Returns an update function the poller calls
// with that tank's telemetry, plus setAlias/setMaxLiters for the Settings
// panel to drive live.
function renderTankCard(instance, container) {
  const group = instance.group;
  const uid = group.id;

  function labelFor(alias) {
    return alias && alias.trim() ? alias.trim() : group.name;
  }

  const card = document.createElement("div");
  card.className = "card tank-card";
  card.innerHTML = `
    <div class="tank-alias-line">${labelFor(instance.groupCfg && instance.groupCfg.alias)}</div>
    <div class="tank-topline">
      <span></span>
      <span class="tank-status-badge offline">Offline</span>
      <span></span>
    </div>
    <div class="wifi-line"><span class="wifi-value">--</span></div>
    <div class="fw-line">Firmware: <span class="fw-value">--</span></div>
    <svg class="tank-shell" viewBox="0 0 160 230" aria-hidden="true">
      <defs>
        <clipPath id="clip-${uid}">
          <path d="M20,26 Q20,14 80,14 Q140,14 140,26 L140,208 Q140,222 80,222 Q20,222 20,208 Z"/>
        </clipPath>
        <linearGradient id="body-${uid}" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#1a2c38"/>
          <stop offset="10%" stop-color="#22394a"/>
          <stop offset="50%" stop-color="#16252f"/>
          <stop offset="90%" stop-color="#22394a"/>
          <stop offset="100%" stop-color="#1a2c38"/>
        </linearGradient>
      </defs>

      <!-- tank body -->
      <path d="M20,26 Q20,14 80,14 Q140,14 140,26 L140,208 Q140,222 80,222 Q20,222 20,208 Z"
            fill="url(#body-${uid})" stroke="#0a1620" stroke-width="2"/>

      <!-- water fill, clipped to the tank silhouette -->
      <g clip-path="url(#clip-${uid})">
        <foreignObject x="20" y="14" width="120" height="208">
          <div xmlns="http://www.w3.org/1999/xhtml" class="tank-water-wrap">
            <div class="tank-water" style="height:0%"></div>
          </div>
        </foreignObject>
      </g>

      <!-- corrugated ribbing -->
      <g stroke="#0a1620" stroke-width="1" opacity="0.5">
        <path d="M20,55 Q80,63 140,55"/>
        <path d="M20,90 Q80,98 140,90"/>
        <path d="M20,125 Q80,133 140,125"/>
        <path d="M20,160 Q80,168 140,160"/>
        <path d="M20,195 Q80,203 140,195"/>
      </g>

      <!-- lid -->
      <ellipse cx="80" cy="14" rx="60" ry="9" fill="#2a4457" stroke="#0a1620" stroke-width="2"/>
      <ellipse cx="80" cy="12" rx="18" ry="4.5" fill="#16252f" stroke="#0a1620" stroke-width="1.5"/>

      <!-- ultrasonic sensor housing -->
      <rect x="72" y="1" width="16" height="10" rx="2" fill="#4d7488" stroke="#0a1620" stroke-width="1.2"/>
      <circle cx="80" cy="6" r="2" fill="#2fb4d9"/>

      <!-- overflow pipe (upper) -->
      <rect x="138" y="44" width="16" height="8" rx="2" fill="#3a5b6e" stroke="#0a1620" stroke-width="1.5"/>

      <!-- outlet pipe + valve (lower, right) -->
      <rect x="138" y="196" width="14" height="8" rx="2" fill="#3a5b6e" stroke="#0a1620" stroke-width="1.5"/>
      <circle class="outlet-anchor outlet-anchor-right" cx="158" cy="200" r="6" fill="#4d7488" stroke="#0a1620" stroke-width="1.5"/>

      ${!instance.isFirstOverall ? `
      <!-- outlet pipe + valve (lower, left -- mirrors the right one, feeds from the previous tank) -->
      <rect x="8" y="196" width="14" height="8" rx="2" fill="#3a5b6e" stroke="#0a1620" stroke-width="1.5"/>
      <circle class="outlet-anchor outlet-anchor-left" cx="2" cy="200" r="6" fill="#4d7488" stroke="#0a1620" stroke-width="1.5"/>
      ` : ""}

      <!-- body outline on top so ribbing/pipes stay inside -->
      <path d="M20,26 Q20,14 80,14 Q140,14 140,26 L140,208 Q140,222 80,222 Q20,222 20,208 Z"
            fill="none" stroke="#0a1620" stroke-width="2"/>

      <!-- glossy highlight -->
      <path d="M32,30 Q30,120 32,205" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" opacity="0.06"/>
    </svg>
    <div class="tank-pct"><span class="pct-value">--</span><span class="pct-unit">%</span></div>
    <div class="tank-meta"><span class="volume-value">--</span> L</div>
    <div class="tank-max-line">Max: <span class="max-value">${instance.capacityL || "--"}</span> L</div>
  `;
  container.appendChild(card);

  const waterEl = card.querySelector(".tank-water");
  const pctEl = card.querySelector(".pct-value");
  const volEl = card.querySelector(".volume-value");
  const statusBadge = card.querySelector(".tank-status-badge");
  const wifiEl = card.querySelector(".wifi-value");
  const fwEl = card.querySelector(".fw-value");
  const aliasEl = card.querySelector(".tank-alias-line");
  const maxEl = card.querySelector(".max-value");

  let capacityL = instance.capacityL;

  function setAlias(alias) {
    aliasEl.textContent = labelFor(alias);
  }

  function setMaxLiters(newCapacityL) {
    capacityL = newCapacityL;
    maxEl.textContent = capacityL >= 1 ? Math.round(capacityL) : "--";
  }

  function updateFromTelemetry(data) {
    if (!data) {
      statusBadge.textContent = "Offline";
      statusBadge.className = "tank-status-badge offline";
      wifiEl.textContent = "--";
      fwEl.textContent = "--";
      return;
    }

    const age = Date.now() - data.server_ts;
    const online = age <= STALE_THRESHOLD_MS;

    if (data.valid && data.level_pct >= 0) {
      const pct = Math.round(data.level_pct);
      waterEl.style.height = pct + "%";
      pctEl.textContent = pct;
      volEl.textContent = capacityL >= 1 ? Math.round((data.level_pct / 100) * capacityL) : "n/a";
    } else {
      waterEl.style.height = "0%";
      pctEl.innerHTML = '<span class="na">n/a</span>';
      volEl.textContent = "n/a";
    }

    statusBadge.textContent = online ? "Online" : "Offline";
    statusBadge.className = "tank-status-badge " + (online ? "online" : "offline");

    wifiEl.textContent = online && typeof data.rssi === "number"
      ? `${data.rssi} dBm · ${wifiQualityLabel(data.rssi)}`
      : "--";

    fwEl.textContent = data.fw_version ? `v${data.fw_version}` : "--";
  }

  return { instance, cardEl: card, setAlias, setMaxLiters, updateFromTelemetry };
}

// Draws the connecting pipe + solenoid valve between Tank 1 and Tank 2.
// Geometry is computed in JS from each card's actual rendered outlet-anchor
// coordinates, recomputed on layoutConnectors() (initial render + resize).
function buildConnectors(container, cardRenders) {
  if (cardRenders.length < 2) return null;

  const links = [];
  for (let i = 0; i < cardRenders.length - 1; i++) {
    links.push({ from: cardRenders[i], to: cardRenders[i + 1] });
  }

  const overlay = document.createElement("div");
  overlay.className = "pipe-overlay-wrap";
  overlay.innerHTML = `
    <svg class="pipe-overlay" aria-hidden="true">
      ${links.map((link, i) => `
        <g class="connector" data-index="${i}">
          <rect class="connector-pipe" height="10" fill="#4d7488" stroke="#0a1620" stroke-width="1.5"/>
          <line class="connector-flow" stroke="#8fe0ff" stroke-width="3" stroke-linecap="round" stroke-dasharray="6 10"/>
          <g class="connector-valve">
            <rect class="valve-coil" x="-10" y="-40" width="20" height="30" rx="3" fill="#22394a" stroke="#0a1620" stroke-width="2"/>
            <line class="valve-lead" x1="-6" y1="-40" x2="-6" y2="-48" stroke="#0a1620" stroke-width="2"/>
            <line class="valve-lead" x1="6" y1="-40" x2="6" y2="-48" stroke="#0a1620" stroke-width="2"/>
            <rect class="valve-body" x="-14" y="-10" width="28" height="20" rx="3" fill="#3a5b6e" stroke="#0a1620" stroke-width="2"/>
            <circle class="valve-light" cx="0" cy="-25" r="6.5" fill="var(--good)"/>
          </g>
        </g>
      `).join("")}
    </svg>
  `;
  container.appendChild(overlay);

  return links.map((link, i) => ({
    ...link,
    pipeEl: overlay.querySelector(`.connector[data-index="${i}"] .connector-pipe`),
    valveEl: overlay.querySelector(`.connector[data-index="${i}"] .connector-valve`),
    lightEl: overlay.querySelector(`.connector[data-index="${i}"] .valve-light`),
    flowEl: overlay.querySelector(`.connector[data-index="${i}"] .connector-flow`),
    svgEl: overlay.querySelector("svg"),
  }));
}

function anchorCenter(circleEl, containerRect) {
  const r = circleEl.getBoundingClientRect();
  return { x: r.left + r.width / 2 - containerRect.left, y: r.top + r.height / 2 - containerRect.top, r: r.width / 2 };
}

function layoutConnectors(container, connectors) {
  if (!connectors || !connectors.length) return;
  const containerRect = container.getBoundingClientRect();
  const svg = connectors[0].svgEl;
  svg.setAttribute("width", containerRect.width);
  svg.setAttribute("height", containerRect.height);
  svg.setAttribute("viewBox", `0 0 ${containerRect.width} ${containerRect.height}`);

  connectors.forEach((c) => {
    const rightAnchor = c.from.cardEl.querySelector(".outlet-anchor-right");
    const leftAnchor = c.to.cardEl.querySelector(".outlet-anchor-left");
    const p1 = anchorCenter(rightAnchor, containerRect);
    const p2 = anchorCenter(leftAnchor, containerRect);
    const y = (p1.y + p2.y) / 2;
    // Extend past each anchor's own center by its radius, so the drawn pipe
    // touches the outer edge of both anchor nubs (a seamless join) instead
    // of stopping halfway through them.
    const leftPoint = p1.x <= p2.x ? p1 : p2;
    const rightPoint = p1.x <= p2.x ? p2 : p1;
    const x1 = leftPoint.x - leftPoint.r;
    const x2 = rightPoint.x + rightPoint.r;
    const valveX = (x1 + x2) / 2;

    c.pipeEl.setAttribute("x", x1);
    c.pipeEl.setAttribute("y", y - 5);
    c.pipeEl.setAttribute("width", x2 - x1);

    if (c.valveEl) {
      c.valveEl.setAttribute("transform", `translate(${valveX}, ${y})`);
    }
    if (c.flowEl) {
      // x1 is always the tank1-ward end, x2 the tank2-ward end (links are
      // built in on-screen left-to-right order) -- the dash animation in
      // CSS always walks from x2 toward x1, i.e. tank2 -> tank1.
      c.flowEl.setAttribute("x1", x1);
      c.flowEl.setAttribute("x2", x2);
      c.flowEl.setAttribute("y1", y);
      c.flowEl.setAttribute("y2", y);
    }
  });
}

// Grows or shrinks every tank card (and the gaps/padding around it) via the
// --tank-scale CSS variable so the whole tanks-row actually fills the space
// available below the header, instead of always rendering at one fixed
// size regardless of window size. Measured at scale 1 first, then solved
// for the largest scale that still fits the available height; clamped so
// it never gets unreadably small or absurdly large.
function computeAndApplyTankScale(container) {
  container.style.setProperty("--tank-scale", "1");

  const naturalWidth = container.scrollWidth;
  let naturalHeight = 0;
  container.querySelectorAll(".tank-card").forEach((card) => {
    naturalHeight = Math.max(naturalHeight, card.getBoundingClientRect().height);
  });
  if (!naturalWidth || !naturalHeight) return;

  const topRect = container.getBoundingClientRect();
  const availableHeight = window.innerHeight - topRect.top - 24; // breathing room above the footer

  // Scale by available *height* only -- any width overflow this causes on a
  // narrow window is caught by .tanks-row's own horizontal scroll.
  let scale = (availableHeight / naturalHeight) * 0.9; // 10% smaller than a full fit
  scale = Math.max(0.6, Math.min(scale, 2.4));
  container.style.setProperty("--tank-scale", scale.toFixed(3));
}

function startValveBlink(connectors) {
  const withValves = (connectors || []).filter((c) => c.lightEl);
  if (!withValves.length) return;

  function applyState(green) {
    withValves.forEach((c) => {
      c.lightEl.setAttribute("fill", green ? "var(--good)" : "var(--bad)");
      // Open (green) = water is actually moving tank2 -> tank1; closed
      // (red) = no flow, so the animated dashes stop and fade out.
      if (c.flowEl) c.flowEl.classList.toggle("is-flowing", green);
    });
  }

  let green = true;
  applyState(green);
  setInterval(() => {
    green = !green;
    applyState(green);
  }, VALVE_BLINK_MS);
}

function showModal(id) {
  document.getElementById(id).hidden = false;
}

function hideModal(id) {
  document.getElementById(id).hidden = true;
}

function setupModalCloseButtons() {
  document.querySelectorAll(".modal-close").forEach((btn) => {
    btn.addEventListener("click", () => hideModal(btn.dataset.close));
  });
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (evt) => {
      if (evt.target === backdrop) backdrop.hidden = true;
    });
  });
}

function setupSettingsGate() {
  const gearBtn = document.getElementById("settings-gear");
  const gateForm = document.getElementById("gate-form");
  const gatePassword = document.getElementById("gate-password");
  const gateStatus = document.getElementById("gate-status");
  const gateBtn = document.getElementById("gate-btn");

  gearBtn.addEventListener("click", () => {
    if (unlockedPassword) {
      openSettingsPanel();
    } else {
      gateStatus.textContent = "";
      gateStatus.className = "status-msg";
      gatePassword.value = "";
      showModal("gate-backdrop");
      gatePassword.focus();
    }
  });

  gateForm.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    gateBtn.disabled = true;
    gateStatus.textContent = "";
    gateStatus.className = "status-msg";

    const result = await verifyPassword(gatePassword.value);
    gateBtn.disabled = false;

    if (result.ok) {
      unlockedPassword = gatePassword.value;
      hideModal("gate-backdrop");
      openSettingsPanel();
    } else if (result.status === 429) {
      gateStatus.textContent = "Too many attempts -- wait a few minutes and try again.";
      gateStatus.className = "status-msg error";
    } else {
      gateStatus.textContent = "Wrong password.";
      gateStatus.className = "status-msg error";
    }
  });
}

function openSettingsPanel() {
  showModal("settings-backdrop");
}

function setupForgotPasswordForm() {
  const link = document.getElementById("forgot-link");
  const form = document.getElementById("forgot-form");
  const emailInput = document.getElementById("forgot-email");
  const statusEl = document.getElementById("forgot-status");
  const btn = document.getElementById("forgot-btn");

  link.addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) emailInput.focus();
  });

  form.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    btn.disabled = true;
    statusEl.textContent = "";
    statusEl.className = "status-msg";

    await requestPasswordReset(emailInput.value.trim());

    // Same message either way -- the response never reveals whether the
    // email matched what's configured on the Worker.
    statusEl.textContent = "If that email is the one on file, a reset link is on its way.";
    statusEl.className = "status-msg ok";
    btn.disabled = false;
    emailInput.value = "";
  });
}

function renderTankSettingsForm(group, container, onSaved) {
  const wrap = document.createElement("div");
  wrap.className = "tank-settings-block";
  wrap.innerHTML = `
    <h3>${group.name}</h3>
    <form class="tank-settings-form">
      <label class="field">
        <span>Alias (shown on the dashboard instead of "${group.name}")</span>
        <input type="text" class="tank-alias" maxlength="40" placeholder="${group.name}">
      </label>
      <label class="field">
        <span>Sensor Outlet (mm)</span>
        <input type="number" class="outlet-mm" min="20" max="4500" required>
      </label>
      <label class="field">
        <span>Sensor Overflow (mm)</span>
        <input type="number" class="overflow-mm" min="20" max="4500" required>
      </label>
      <p class="muted volume-note">Diameter/Height are used only to calculate the litres shown for display -- they have no effect on the % reading above.</p>
      <label class="field">
        <span>Diameter (mm)</span>
        <input type="number" class="diameter-mm" min="100" max="10000" required>
      </label>
      <label class="field">
        <span>Height (mm)</span>
        <input type="number" class="height-mm" min="100" max="10000" required>
      </label>
      <button type="submit" class="save-tank-btn">Save ${group.name} settings</button>
      <div class="status-msg tank-cal-status" role="status"></div>
    </form>
  `;
  container.appendChild(wrap);

  const aliasInput = wrap.querySelector(".tank-alias");
  const outletInput = wrap.querySelector(".outlet-mm");
  const overflowInput = wrap.querySelector(".overflow-mm");
  const diameterInput = wrap.querySelector(".diameter-mm");
  const heightInput = wrap.querySelector(".height-mm");
  const statusEl = wrap.querySelector(".tank-cal-status");
  const saveBtn = wrap.querySelector(".save-tank-btn");
  const form = wrap.querySelector("form");

  fetchConfig(group.id).then((cfg) => {
    if (!cfg) return;
    aliasInput.value = cfg.alias || "";
    outletInput.value = cfg.sensor_outlet_mm;
    overflowInput.value = cfg.sensor_overflow_mm;
    diameterInput.value = cfg.diameter_mm || "";
    heightInput.value = cfg.height_mm || "";
  });

  form.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    statusEl.textContent = "";
    statusEl.className = "status-msg";

    const alias = aliasInput.value.trim();
    const outletMm = parseInt(outletInput.value, 10);
    const overflowMm = parseInt(overflowInput.value, 10);
    if (!Number.isInteger(outletMm) || !Number.isInteger(overflowMm) || outletMm <= overflowMm) {
      statusEl.textContent = "Sensor Outlet must be a bigger number than Sensor Overflow.";
      statusEl.className = "status-msg error";
      return;
    }

    const diameterMm = parseInt(diameterInput.value, 10);
    const heightMm = parseInt(heightInput.value, 10);
    if (!Number.isInteger(diameterMm) || diameterMm < 100 || !Number.isInteger(heightMm) || heightMm < 100) {
      statusEl.textContent = "Diameter and Height must be positive numbers (in mm).";
      statusEl.className = "status-msg error";
      return;
    }

    saveBtn.disabled = true;
    const result = await saveConfig(group.id, outletMm, overflowMm, diameterMm, heightMm, alias, unlockedPassword);
    saveBtn.disabled = false;

    if (result.ok) {
      statusEl.textContent = "Saved. " + group.name + " will pick this up within a minute.";
      statusEl.className = "status-msg ok";
      const capacityL = computeCapacityL(diameterMm, heightMm);
      if (onSaved) onSaved(alias, capacityL);
    } else if (result.status === 401) {
      statusEl.textContent = "Session expired -- close Settings and unlock again.";
      statusEl.className = "status-msg error";
      unlockedPassword = null;
    } else if (result.status === 429) {
      statusEl.textContent = "Too many attempts -- wait a few minutes and try again.";
      statusEl.className = "status-msg error";
    } else {
      statusEl.textContent = "Could not save (" + result.status + ").";
      statusEl.className = "status-msg error";
    }
  });
}

function setupChangePasswordForm() {
  const newInput = document.getElementById("new-password");
  const confirmInput = document.getElementById("confirm-password");
  const statusEl = document.getElementById("password-status");
  const btn = document.getElementById("password-btn");
  const form = document.getElementById("password-form");

  form.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    statusEl.textContent = "";
    statusEl.className = "status-msg";

    if (newInput.value.length < 8) {
      statusEl.textContent = "Password must be at least 8 characters.";
      statusEl.className = "status-msg error";
      return;
    }
    if (newInput.value !== confirmInput.value) {
      statusEl.textContent = "Passwords don't match.";
      statusEl.className = "status-msg error";
      return;
    }

    btn.disabled = true;
    const result = await changePassword(unlockedPassword, newInput.value);
    btn.disabled = false;

    if (result.ok) {
      unlockedPassword = newInput.value;
      statusEl.textContent = "Password updated.";
      statusEl.className = "status-msg ok";
      newInput.value = "";
      confirmInput.value = "";
    } else if (result.status === 401) {
      statusEl.textContent = "Session expired -- close Settings and unlock again.";
      statusEl.className = "status-msg error";
      unlockedPassword = null;
    } else if (result.status === 429) {
      statusEl.textContent = "Too many attempts -- wait a few minutes and try again.";
      statusEl.className = "status-msg error";
    } else {
      statusEl.textContent = "Could not update password (" + result.status + ").";
      statusEl.className = "status-msg error";
    }
  });
}

async function main() {
  const container = document.getElementById("tanks");

  const groupConfigs = await Promise.all(TANKS.map((group) => fetchConfig(group.id)));

  const instances = TANKS.map((group, i) => {
    const groupCfg = groupConfigs[i];
    const hasDims = groupCfg && Number.isInteger(groupCfg.diameter_mm) && Number.isInteger(groupCfg.height_mm);
    return {
      group,
      groupCfg,
      capacityL: hasDims ? computeCapacityL(groupCfg.diameter_mm, groupCfg.height_mm) : null,
      isFirstOverall: i === 0,
    };
  });

  const cardRenders = instances.map((inst) => renderTankCard(inst, container));

  computeAndApplyTankScale(container);
  const connectors = buildConnectors(container, cardRenders);
  if (connectors) {
    layoutConnectors(container, connectors);
    window.addEventListener("resize", () => {
      computeAndApplyTankScale(container);
      layoutConnectors(container, connectors);
    });
    startValveBlink(connectors);
  }

  async function pollAll() {
    await Promise.all(TANKS.map(async (group) => {
      const data = await fetchTelemetry(group.id);

      cardRenders
        .filter((r) => r.instance.group.id === group.id)
        .forEach((r) => r.updateFromTelemetry(data));
    }));
    document.getElementById("lastUpdate").textContent = new Date().toLocaleTimeString();
  }

  pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);

  setupModalCloseButtons();
  setupSettingsGate();
  setupForgotPasswordForm();

  const settingsList = document.getElementById("tank-settings-list");
  TANKS.forEach((group) => {
    renderTankSettingsForm(group, settingsList, (alias, capacityL) => {
      const card = cardRenders.find((r) => r.instance.group.id === group.id);
      if (card) {
        card.setAlias(alias);
        card.setMaxLiters(capacityL);
      }
      computeAndApplyTankScale(container);
      if (connectors) layoutConnectors(container, connectors);
    });
  });

  setupChangePasswordForm();
}

main();
