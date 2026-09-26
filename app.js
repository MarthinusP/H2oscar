// API_BASE lives in site-config.js, shared with reset.html.
// leftOutlet: true draws a mirrored outlet stub on that tank's left side, so
// a connecting pipe can run from the previous tank's right outlet into it.
const TANKS = [
  { id: "tank1", name: "Tank 1" },
  { id: "tank2", name: "Tank 2", leftOutlet: true },
];
const POLL_INTERVAL_MS = 5000;
const STALE_THRESHOLD_MS = 15000; // ~3x the firmware's push interval
const VALVE_BLINK_MS = 10000;

let lastGoodFetchAt = 0;
let unlockedPassword = null; // kept in memory only, cleared on page reload

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

async function saveConfig(tankId, outletMm, overflowMm, capacityL, alias, password) {
  const res = await fetch(`${API_BASE}/api/tanks/${tankId}/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Dashboard-Password": password,
    },
    body: JSON.stringify({
      sensor_outlet_mm: outletMm,
      sensor_overflow_mm: overflowMm,
      tank_capacity_l: capacityL,
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

// Builds one tank card's DOM and returns a poll() function that refreshes it.
function renderTank(tank, container) {
  const card = document.createElement("div");
  card.className = "card tank-card";
  card.innerHTML = `
    <div class="tank-alias-line">${tank.name}</div>
    <div class="tank-topline">
      <span></span>
      <span class="tank-status-badge offline">Offline</span>
      <span></span>
    </div>
    <div class="wifi-line"><span class="wifi-value">--</span></div>
    <div class="fw-line">Firmware: <span class="fw-value">--</span></div>
    <svg class="tank-shell" viewBox="0 0 160 230" aria-hidden="true">
      <defs>
        <clipPath id="clip-${tank.id}">
          <path d="M20,26 Q20,14 80,14 Q140,14 140,26 L140,208 Q140,222 80,222 Q20,222 20,208 Z"/>
        </clipPath>
        <linearGradient id="body-${tank.id}" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#1a2c38"/>
          <stop offset="10%" stop-color="#22394a"/>
          <stop offset="50%" stop-color="#16252f"/>
          <stop offset="90%" stop-color="#22394a"/>
          <stop offset="100%" stop-color="#1a2c38"/>
        </linearGradient>
      </defs>

      <!-- tank body -->
      <path d="M20,26 Q20,14 80,14 Q140,14 140,26 L140,208 Q140,222 80,222 Q20,222 20,208 Z"
            fill="url(#body-${tank.id})" stroke="#0a1620" stroke-width="2"/>

      <!-- water fill, clipped to the tank silhouette -->
      <g clip-path="url(#clip-${tank.id})">
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

      <!-- overflow pipe (upper) -->
      <rect x="138" y="44" width="16" height="8" rx="2" fill="#3a5b6e" stroke="#0a1620" stroke-width="1.5"/>

      <!-- outlet pipe + valve (lower, right) -->
      <rect x="138" y="196" width="14" height="8" rx="2" fill="#3a5b6e" stroke="#0a1620" stroke-width="1.5"/>
      <circle class="outlet-anchor outlet-anchor-right" cx="158" cy="200" r="6" fill="#4d7488" stroke="#0a1620" stroke-width="1.5"/>

      ${tank.leftOutlet ? `
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
  `;
  container.appendChild(card);

  const waterEl = card.querySelector(".tank-water");
  const pctEl = card.querySelector(".pct-value");
  const volEl = card.querySelector(".volume-value");
  const statusBadge = card.querySelector(".tank-status-badge");
  const wifiEl = card.querySelector(".wifi-value");
  const fwEl = card.querySelector(".fw-value");
  const aliasEl = card.querySelector(".tank-alias-line");

  function setAlias(alias) {
    aliasEl.textContent = alias && alias.trim() ? alias.trim() : tank.name;
  }

  async function poll() {
    const data = await fetchTelemetry(tank.id);
    if (!data) {
      statusBadge.textContent = "Offline";
      statusBadge.className = "tank-status-badge offline";
      wifiEl.textContent = "--";
      return false;
    }

    lastGoodFetchAt = Date.now();
    const age = Date.now() - data.server_ts;
    const online = age <= STALE_THRESHOLD_MS;

    if (data.valid && data.level_pct >= 0) {
      const pct = Math.round(data.level_pct);
      waterEl.style.height = pct + "%";
      pctEl.textContent = pct;
    } else {
      waterEl.style.height = "0%";
      pctEl.innerHTML = '<span class="na">n/a</span>';
    }
    volEl.textContent = data.volume_l >= 0 ? Math.round(data.volume_l) : "n/a";

    statusBadge.textContent = online ? "Online" : "Offline";
    statusBadge.className = "tank-status-badge " + (online ? "online" : "offline");

    wifiEl.textContent = online && typeof data.rssi === "number"
      ? `${data.rssi} dBm · ${wifiQualityLabel(data.rssi)}`
      : "--";

    fwEl.textContent = data.fw_version ? `v${data.fw_version}` : "--";

    return online;
  }

  const aliasLoaded = fetchConfig(tank.id).then((cfg) => setAlias(cfg && cfg.alias));

  return { poll, cardEl: card, setAlias, aliasLoaded };
}

// Draws the inter-tank pipe(s) + solenoid valve(s) as one absolutely
// positioned SVG overlaid on top of the tank cards, so the pipe can start
// and end exactly on each tank's outlet anchor regardless of card layout.
// Geometry is recomputed on layoutConnectors() (initial render + resize);
// only the valve's colour changes on the blink interval.
function buildConnectors(container, tankRenders) {
  const links = [];
  for (let i = 0; i < tankRenders.length - 1; i++) {
    const from = tankRenders[i];
    const to = tankRenders[i + 1];
    if (!to.tank.leftOutlet) continue;
    links.push({ from, to });
  }
  if (!links.length) return null;

  const overlay = document.createElement("div");
  overlay.className = "pipe-overlay-wrap";
  overlay.innerHTML = `
    <svg class="pipe-overlay" aria-hidden="true">
      ${links.map((_, i) => `
        <g class="connector" data-index="${i}">
          <rect class="connector-pipe" height="8" fill="#3a5b6e" stroke="#0a1620" stroke-width="1.5"/>
          <g class="connector-valve">
            <rect class="valve-coil" x="-6" y="-24" width="12" height="18" rx="2" fill="#22394a" stroke="#0a1620" stroke-width="1.5"/>
            <line class="valve-lead" x1="-4" y1="-24" x2="-4" y2="-30" stroke="#0a1620" stroke-width="1.5"/>
            <line class="valve-lead" x1="4" y1="-24" x2="4" y2="-30" stroke="#0a1620" stroke-width="1.5"/>
            <rect class="valve-body" x="-8" y="-6" width="16" height="12" rx="2" fill="#3a5b6e" stroke="#0a1620" stroke-width="1.5"/>
            <circle class="valve-light" cx="0" cy="-15" r="4" fill="var(--good)"/>
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
    svgEl: overlay.querySelector("svg"),
  }));
}

function anchorCenter(circleEl, containerRect) {
  const r = circleEl.getBoundingClientRect();
  return { x: r.left + r.width / 2 - containerRect.left, y: r.top + r.height / 2 - containerRect.top };
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
    const x1 = Math.min(p1.x, p2.x);
    const x2 = Math.max(p1.x, p2.x);

    c.pipeEl.setAttribute("x", x1);
    c.pipeEl.setAttribute("y", y - 4);
    c.pipeEl.setAttribute("width", x2 - x1);
    c.valveEl.setAttribute("transform", `translate(${(x1 + x2) / 2}, ${y})`);
  });
}

function startValveBlink(connectors) {
  if (!connectors || !connectors.length) return;
  let green = true;
  setInterval(() => {
    green = !green;
    connectors.forEach((c) => {
      c.lightEl.setAttribute("fill", green ? "var(--good)" : "var(--bad)");
    });
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

function renderTankSettingsForm(tank, container, onSaved) {
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <h3>${tank.name}</h3>
    <form class="tank-settings-form">
      <label class="field">
        <span>Alias (shown on the dashboard instead of "${tank.name}")</span>
        <input type="text" class="tank-alias" maxlength="40" placeholder="${tank.name}">
      </label>
      <label class="field">
        <span>Sensor Outlet (mm)</span>
        <input type="number" class="outlet-mm" min="20" max="4500" required>
      </label>
      <label class="field">
        <span>Sensor Overflow (mm)</span>
        <input type="number" class="overflow-mm" min="20" max="4500" required>
      </label>
      <label class="field">
        <span>Tank Capacity (litres)</span>
        <input type="number" class="capacity-l" min="1" max="1000000" required>
      </label>
      <button type="submit" class="save-tank-btn">Save ${tank.name} settings</button>
      <div class="status-msg tank-cal-status" role="status"></div>
    </form>
  `;
  container.appendChild(wrap);

  const aliasInput = wrap.querySelector(".tank-alias");
  const outletInput = wrap.querySelector(".outlet-mm");
  const overflowInput = wrap.querySelector(".overflow-mm");
  const capacityInput = wrap.querySelector(".capacity-l");
  const statusEl = wrap.querySelector(".tank-cal-status");
  const saveBtn = wrap.querySelector(".save-tank-btn");
  const form = wrap.querySelector("form");

  fetchConfig(tank.id).then((cfg) => {
    if (!cfg) return;
    aliasInput.value = cfg.alias || "";
    outletInput.value = cfg.sensor_outlet_mm;
    overflowInput.value = cfg.sensor_overflow_mm;
    capacityInput.value = cfg.tank_capacity_l;
  });

  form.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    statusEl.textContent = "";
    statusEl.className = "status-msg";

    const alias = aliasInput.value.trim();
    const outletMm = parseInt(outletInput.value, 10);
    const overflowMm = parseInt(overflowInput.value, 10);
    const capacityL = parseInt(capacityInput.value, 10);
    if (!Number.isInteger(outletMm) || !Number.isInteger(overflowMm) || outletMm <= overflowMm) {
      statusEl.textContent = "Sensor Outlet must be a bigger number than Sensor Overflow.";
      statusEl.className = "status-msg error";
      return;
    }
    if (!Number.isInteger(capacityL) || capacityL < 1) {
      statusEl.textContent = "Tank Capacity must be a positive number.";
      statusEl.className = "status-msg error";
      return;
    }

    saveBtn.disabled = true;
    const result = await saveConfig(tank.id, outletMm, overflowMm, capacityL, alias, unlockedPassword);
    saveBtn.disabled = false;

    if (result.ok) {
      statusEl.textContent = "Saved. " + tank.name + " will pick this up within a minute.";
      statusEl.className = "status-msg ok";
      if (onSaved) onSaved(alias);
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

function main() {
  const container = document.getElementById("tanks");
  const tankRenders = TANKS.map((tank) => ({ tank, ...renderTank(tank, container) }));

  const connectors = buildConnectors(container, tankRenders);
  if (connectors) {
    layoutConnectors(container, connectors);
    window.addEventListener("resize", () => layoutConnectors(container, connectors));
    startValveBlink(connectors);
    // Aliases load async and can change a card's height (longer/shorter text
    // than the "Tank N" placeholder), so re-align once they're in too.
    Promise.all(tankRenders.map((t) => t.aliasLoaded)).then(() => layoutConnectors(container, connectors));
  }

  async function pollAll() {
    await Promise.all(tankRenders.map((t) => t.poll()));
    document.getElementById("lastUpdate").textContent = new Date().toLocaleTimeString();
  }

  pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);

  setupModalCloseButtons();
  setupSettingsGate();
  setupForgotPasswordForm();

  const settingsList = document.getElementById("tank-settings-list");
  TANKS.forEach((tank) => {
    const tankRender = tankRenders.find((t) => t.tank.id === tank.id);
    renderTankSettingsForm(tank, settingsList, (alias) => {
      if (!tankRender) return;
      tankRender.setAlias(alias);
      if (connectors) layoutConnectors(container, connectors);
    });
  });

  setupChangePasswordForm();
}

main();
