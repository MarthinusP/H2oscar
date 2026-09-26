// API_BASE lives in site-config.js, shared with reset.html.
// Each entry in TANKS is one physical sensor group (one ESP32). How many
// tank graphics it renders is a per-group setting (tank_count, 1-5) set in
// Settings and fetched from the Worker -- not hardcoded here. Sub-tanks
// within a group all show identical readings (one shared sensor, plumbed
// together), labelled with a letter suffix (A, B, C...) when count > 1.
const TANKS = [
  { id: "tank1", name: "Tank 1" },
  { id: "tank2", name: "Tank 2" },
];
const POLL_INTERVAL_MS = 5000;
const STALE_THRESHOLD_MS = 15000; // ~3x the firmware's push interval
const VALVE_BLINK_MS = 10000;
const TANK_COUNT_MIN = 1;
const TANK_COUNT_MAX = 5;
const SUB_TANK_LETTERS = ["A", "B", "C", "D", "E"];

let unlockedPassword = null; // kept in memory only, cleared on page reload

function clampTankCount(n) {
  n = parseInt(n, 10);
  if (!Number.isInteger(n) || n < TANK_COUNT_MIN) return TANK_COUNT_MIN;
  if (n > TANK_COUNT_MAX) return TANK_COUNT_MAX;
  return n;
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

async function saveConfig(tankId, outletMm, overflowMm, tankCount, diameterMm, heightMm, sensorTank, alias, password) {
  const res = await fetch(`${API_BASE}/api/tanks/${tankId}/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Dashboard-Password": password,
    },
    body: JSON.stringify({
      sensor_outlet_mm: outletMm,
      sensor_overflow_mm: overflowMm,
      tank_count: tankCount,
      tank_diameter_mm: diameterMm,
      tank_height_mm: heightMm,
      sensor_tank: sensorTank,
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

// Builds one tank card's DOM for a single rendered instance -- a group
// renders more than one of these when its tank_count setting is > 1.
// Returns an update function the group-level poller calls with shared
// telemetry (every instance in a group shows the same reading), plus
// setAlias for the Settings panel to drive live.
function renderTankCard(instance, container) {
  const group = instance.group;
  const uid = instance.uid;

  function labelFor(alias) {
    const base = alias && alias.trim() ? alias.trim() : group.name;
    return instance.subLabel ? `${base} ${instance.subLabel}` : base;
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

      ${instance.hasSensor ? `
      <!-- ultrasonic sensor housing -- marks which sub-tank physically holds it -->
      <rect x="72" y="1" width="16" height="10" rx="2" fill="#4d7488" stroke="#0a1620" stroke-width="1.2"/>
      <circle cx="80" cy="6" r="2" fill="#2fb4d9"/>
      ` : ""}

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
    aliasEl.textContent = labelFor(alias);
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
  }

  return { instance, cardEl: card, setAlias, updateFromTelemetry };
}

// Draws the connecting pipe(s) + solenoid valve(s) between every
// consecutive pair of rendered tank cards -- including across group
// boundaries (Tank 1's last sub-tank feeds into Tank 2's first). Geometry
// is computed in JS from each card's actual rendered outlet-anchor
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
        <span>Number of tanks (1-5) -- more than one adds sub-tanks A, B, C... all showing this sensor's reading, linked by pipes</span>
        <input type="number" class="tank-count" min="${TANK_COUNT_MIN}" max="${TANK_COUNT_MAX}" required>
      </label>
      <label class="field sensor-tank-field" hidden>
        <span>Which tank contains the sensor?</span>
        <select class="sensor-tank"></select>
      </label>
      <label class="field">
        <span>Sensor Outlet (mm)</span>
        <input type="number" class="outlet-mm" min="20" max="4500" required>
      </label>
      <label class="field">
        <span>Sensor Overflow (mm)</span>
        <input type="number" class="overflow-mm" min="20" max="4500" required>
      </label>
      <p class="muted volume-note">Used only to calculate the litres shown for display -- has no effect on the % reading above.</p>
      <label class="field">
        <span>Tank Diameter (mm)</span>
        <input type="number" class="diameter-mm" min="100" max="10000" required>
      </label>
      <label class="field">
        <span>Tank Height (mm)</span>
        <input type="number" class="height-mm" min="100" max="10000" required>
      </label>
      <button type="submit" class="save-tank-btn">Save ${group.name} settings</button>
      <div class="status-msg tank-cal-status" role="status"></div>
    </form>
  `;
  container.appendChild(wrap);

  const aliasInput = wrap.querySelector(".tank-alias");
  const countInput = wrap.querySelector(".tank-count");
  const sensorTankField = wrap.querySelector(".sensor-tank-field");
  const sensorTankSelect = wrap.querySelector(".sensor-tank");
  const outletInput = wrap.querySelector(".outlet-mm");
  const overflowInput = wrap.querySelector(".overflow-mm");
  const diameterInput = wrap.querySelector(".diameter-mm");
  const heightInput = wrap.querySelector(".height-mm");
  const statusEl = wrap.querySelector(".tank-cal-status");
  const saveBtn = wrap.querySelector(".save-tank-btn");
  const form = wrap.querySelector("form");

  let renderedCount = TANK_COUNT_MIN;
  countInput.value = renderedCount;

  function refreshSensorTankOptions(count, selected) {
    sensorTankField.hidden = count <= 1;
    const options = SUB_TANK_LETTERS.slice(0, count);
    sensorTankSelect.innerHTML = options.map((l) => `<option value="${l}">${l}</option>`).join("");
    sensorTankSelect.value = options.includes(selected) ? selected : options[0];
  }

  refreshSensorTankOptions(renderedCount, "A");
  countInput.addEventListener("input", () => {
    refreshSensorTankOptions(clampTankCount(countInput.value), sensorTankSelect.value);
  });

  fetchConfig(group.id).then((cfg) => {
    if (!cfg) return;
    aliasInput.value = cfg.alias || "";
    outletInput.value = cfg.sensor_outlet_mm;
    overflowInput.value = cfg.sensor_overflow_mm;
    diameterInput.value = cfg.tank_diameter_mm || "";
    heightInput.value = cfg.tank_height_mm || "";
    renderedCount = clampTankCount(cfg.tank_count);
    countInput.value = renderedCount;
    refreshSensorTankOptions(renderedCount, cfg.sensor_tank || "A");
  });

  form.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    statusEl.textContent = "";
    statusEl.className = "status-msg";

    const alias = aliasInput.value.trim();
    const tankCount = clampTankCount(countInput.value);
    const sensorTank = sensorTankSelect.value;
    const outletMm = parseInt(outletInput.value, 10);
    const overflowMm = parseInt(overflowInput.value, 10);
    const diameterMm = parseInt(diameterInput.value, 10);
    const heightMm = parseInt(heightInput.value, 10);
    if (!Number.isInteger(outletMm) || !Number.isInteger(overflowMm) || outletMm <= overflowMm) {
      statusEl.textContent = "Sensor Outlet must be a bigger number than Sensor Overflow.";
      statusEl.className = "status-msg error";
      return;
    }
    if (!Number.isInteger(diameterMm) || diameterMm < 100 || !Number.isInteger(heightMm) || heightMm < 100) {
      statusEl.textContent = "Tank Diameter and Height must be positive numbers (in mm).";
      statusEl.className = "status-msg error";
      return;
    }

    saveBtn.disabled = true;
    const result = await saveConfig(
      group.id, outletMm, overflowMm, tankCount, diameterMm, heightMm, sensorTank, alias, unlockedPassword
    );
    saveBtn.disabled = false;

    if (result.ok) {
      if (tankCount !== renderedCount) {
        statusEl.textContent = "Saved. Reloading to rebuild the tank layout...";
        statusEl.className = "status-msg ok";
        setTimeout(() => location.reload(), 1200);
      } else {
        statusEl.textContent = "Saved. " + group.name + " will pick this up within a minute.";
        statusEl.className = "status-msg ok";
        if (onSaved) onSaved(alias);
      }
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

  // Each group's tank_count decides how many cards it renders -- fetch all
  // of them up front so the whole layout (including inter-tank pipes) can
  // be built once, correctly, instead of growing/shifting as data trickles in.
  const groupConfigs = await Promise.all(TANKS.map((group) => fetchConfig(group.id)));

  const instances = [];
  TANKS.forEach((group, gi) => {
    const groupCfg = groupConfigs[gi];
    const count = clampTankCount(groupCfg && groupCfg.tank_count);
    const sensorTank = (groupCfg && groupCfg.sensor_tank) || "A";
    for (let i = 0; i < count; i++) {
      const subLabel = count > 1 ? SUB_TANK_LETTERS[i] : null;
      instances.push({
        group,
        groupCfg,
        uid: `${group.id}_${i}`,
        subLabel,
        hasSensor: count > 1 && subLabel === sensorTank,
      });
    }
  });
  instances.forEach((inst, idx) => {
    inst.isFirstOverall = idx === 0;
  });

  const cardRenders = instances.map((inst) => renderTankCard(inst, container));

  const connectors = buildConnectors(container, cardRenders);
  if (connectors) {
    layoutConnectors(container, connectors);
    window.addEventListener("resize", () => layoutConnectors(container, connectors));
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
    renderTankSettingsForm(group, settingsList, (alias) => {
      cardRenders
        .filter((r) => r.instance.group.id === group.id)
        .forEach((r) => r.setAlias(alias));
      if (connectors) layoutConnectors(container, connectors);
    });
  });

  setupChangePasswordForm();
}

main();
