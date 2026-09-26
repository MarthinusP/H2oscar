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

// =====================================================================
// TEMPORARY DEV-ONLY STUB -- REMOVE ONCE THE REAL SENSORS ARE ONLINE.
// Sensors aren't wired up yet, so real telemetry never arrives; while
// that's true, a fake distance reading (mm) is substituted per group so
// the tank graphics/settings can be developed against something. Once
// ESP1/ESP2 are actually reporting, delete this block (and the fallback
// that uses it in pollAll()) -- real telemetry always wins over this
// when it's present, but leaving the stub in after that just risks
// masking a real "sensor gone offline" situation with fake data.
const DEV_FAKE_DISTANCE_MM = {
  tank1: 850,
  tank2: 1280,
};
// =====================================================================

let unlockedPassword = null; // kept in memory only, cleared on page reload

function clampTankCount(n) {
  n = parseInt(n, 10);
  if (!Number.isInteger(n) || n < TANK_COUNT_MIN) return TANK_COUNT_MIN;
  if (n > TANK_COUNT_MAX) return TANK_COUNT_MAX;
  return n;
}

// Mirrors the Worker's own derivation, so the UI can update instantly on
// save without waiting on a re-fetch -- the Worker remains the source of
// truth for what's actually stored.
function computeCapacityL(diameterMm, heightMm) {
  const radiusMm = diameterMm / 2;
  return Math.max(1, Math.round((Math.PI * radiusMm * radiusMm * heightMm) / 1e6));
}

// Mirrors the firmware's own LevelSensor::levelPercent() -- only used to
// turn the temporary DEV_FAKE_DISTANCE_MM stub into a plausible percent;
// real telemetry already carries level_pct computed by the firmware itself.
function computeLevelPercent(distanceMm, outletMm, overflowMm) {
  if (!outletMm || !overflowMm || outletMm <= overflowMm) return -1;
  const usable = outletMm - overflowMm;
  const fromFull = distanceMm - overflowMm;
  let pct = 100 * (1 - fromFull / usable);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
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

async function saveConfig(tankId, outletMm, overflowMm, tankCount, tankDims, sensorTank, alias, password) {
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
      tank_dims: tankDims,
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
// renders more than one of these when its tank_count setting is > 1. Each
// instance carries its own subCapacityL (from that sub-tank's own stored
// diameter/height), separate from the group's summed total. Returns an
// update function the group-level poller calls with shared telemetry
// (every instance in a group shows the same % reading), plus setAlias for
// the Settings panel to drive live.
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
    <div class="tank-max-line">Max: <span class="max-value">${instance.subCapacityL || "--"}</span> L</div>
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

  let subCapacityL = instance.subCapacityL;

  function setAlias(alias) {
    aliasEl.textContent = labelFor(alias);
  }

  function setMaxLiters(capacityL) {
    subCapacityL = capacityL;
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
      volEl.textContent = subCapacityL >= 1 ? Math.round((data.level_pct / 100) * subCapacityL) : "n/a";
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

// Draws the connecting pipe(s) between every consecutive pair of rendered
// tank cards. Within a group (sub-tanks of the same sensor, e.g. Tank 1 A
// to Tank 1 B) it's a plain pipe only -- they're permanently coupled and
// always share one level, nothing to valve. Only *between* groups (Tank 1's
// last sub-tank into Tank 2's first) is there an actual solenoid valve,
// drawn larger since it's the one meaningful control point. Geometry is
// computed in JS from each card's actual rendered outlet-anchor
// coordinates, recomputed on layoutConnectors() (initial render + resize).
function buildConnectors(container, cardRenders) {
  if (cardRenders.length < 2) return null;

  const links = [];
  for (let i = 0; i < cardRenders.length - 1; i++) {
    const from = cardRenders[i];
    const to = cardRenders[i + 1];
    links.push({ from, to, isInterGroup: from.instance.group.id !== to.instance.group.id });
  }

  const overlay = document.createElement("div");
  overlay.className = "pipe-overlay-wrap";
  overlay.innerHTML = `
    <svg class="pipe-overlay" aria-hidden="true">
      ${links.map((link, i) => `
        <g class="connector" data-index="${i}">
          <rect class="connector-pipe" height="10" fill="#4d7488" stroke="#0a1620" stroke-width="1.5"/>
          ${link.isInterGroup ? `
          <line class="connector-flow" stroke="#8fe0ff" stroke-width="3" stroke-linecap="round" stroke-dasharray="6 10"/>
          <g class="connector-valve">
            <rect class="valve-coil" x="-10" y="-40" width="20" height="30" rx="3" fill="#22394a" stroke="#0a1620" stroke-width="2"/>
            <line class="valve-lead" x1="-6" y1="-40" x2="-6" y2="-48" stroke="#0a1620" stroke-width="2"/>
            <line class="valve-lead" x1="6" y1="-40" x2="6" y2="-48" stroke="#0a1620" stroke-width="2"/>
            <rect class="valve-body" x="-14" y="-10" width="28" height="20" rx="3" fill="#3a5b6e" stroke="#0a1620" stroke-width="2"/>
            <circle class="valve-light" cx="0" cy="-25" r="6.5" fill="var(--good)"/>
          </g>
          ` : ""}
        </g>
      `).join("")}
    </svg>
  `;
  container.appendChild(overlay);

  return links.map((link, i) => ({
    ...link,
    pipeEl: overlay.querySelector(`.connector[data-index="${i}"] .connector-pipe`),
    valveEl: link.isInterGroup ? overlay.querySelector(`.connector[data-index="${i}"] .connector-valve`) : null,
    lightEl: link.isInterGroup ? overlay.querySelector(`.connector[data-index="${i}"] .valve-light`) : null,
    flowEl: link.isInterGroup ? overlay.querySelector(`.connector[data-index="${i}"] .connector-flow`) : null,
    svgEl: overlay.querySelector("svg"),
  }));
}

function anchorCenter(circleEl, containerRect) {
  const r = circleEl.getBoundingClientRect();
  return { x: r.left + r.width / 2 - containerRect.left, y: r.top + r.height / 2 - containerRect.top, r: r.width / 2 };
}

// groupFrames (id -> { frame, cardsRow }) is optional -- when given, an
// inter-group valve is centered on the actual gap between the two group
// frame boxes rather than on the midpoint of the two nearest cards' anchors,
// so it sits dead center between the frames even if one frame is wider than
// the other (different sub-tank counts on each side).
function layoutConnectors(container, connectors, groupFrames) {
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
    let x1 = leftPoint.x - leftPoint.r;
    let x2 = rightPoint.x + rightPoint.r;

    let valveX = (x1 + x2) / 2;
    if (c.isInterGroup && groupFrames) {
      const fromFrame = groupFrames.get(c.from.instance.group.id);
      const toFrame = groupFrames.get(c.to.instance.group.id);
      if (fromFrame && toFrame) {
        const fromRight = fromFrame.frame.getBoundingClientRect().right - containerRect.left;
        const toLeft = toFrame.frame.getBoundingClientRect().left - containerRect.left;
        valveX = (fromRight + toLeft) / 2;
        // Re-center the pipe span itself around the frame-gap midpoint too,
        // so the run is exactly as long on both sides of the valve --
        // otherwise a slightly-off anchor measurement on one side alone
        // could make the valve look off-center even though its transform
        // is technically correct.
        const half = (x2 - x1) / 2;
        x1 = valveX - half;
        x2 = valveX + half;
      }
    }

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
// size regardless of window size or how many tanks are configured. Measured
// at scale 1 first, then solved for the largest scale that still fits both
// the available width and the available height; clamped so it never gets
// unreadably small or absurdly large.
function computeAndApplyTankScale(container) {
  container.style.setProperty("--tank-scale", "1");

  const naturalWidth = container.scrollWidth;
  let naturalHeight = 0;
  container.querySelectorAll(".tank-group-frame").forEach((frame) => {
    naturalHeight = Math.max(naturalHeight, frame.getBoundingClientRect().height);
  });
  if (!naturalWidth || !naturalHeight) return;

  const topRect = container.getBoundingClientRect();
  const availableHeight = window.innerHeight - topRect.top - 24; // breathing room above the footer

  // Scale by available *height* only -- with only 1-2 groups the row was
  // nowhere near main's max-width, so capping the scale at the width ratio
  // too (the previous behavior) left the row barely bigger than at scale 1
  // even though most of the screen below it was empty. Any width overflow
  // this causes (many groups/sub-tanks on a narrow window) is caught by
  // .tanks-row's own horizontal scroll, which is the intended release valve.
  let scale = availableHeight / naturalHeight;
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
        <span>Number of tanks (1-5) -- more than one adds sub-tanks A, B, C... all showing this sensor's reading, linked by pipes</span>
        <input type="number" class="tank-count" min="${TANK_COUNT_MIN}" max="${TANK_COUNT_MAX}" required>
      </label>
      <label class="field sensor-tank-field field-reserved">
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
      <p class="muted volume-note">Used only to calculate the litres shown for display -- has no effect on the % reading above. Each linked tank can be a different size.</p>
      <div class="dims-list"></div>
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
  const dimsList = wrap.querySelector(".dims-list");
  const statusEl = wrap.querySelector(".tank-cal-status");
  const saveBtn = wrap.querySelector(".save-tank-btn");
  const form = wrap.querySelector("form");

  let renderedCount = TANK_COUNT_MIN;
  countInput.value = renderedCount;

  function refreshSensorTankOptions(count, selected) {
    // Kept in the grid (visibility, not hidden/display:none) so this row
    // still reserves its place -- see .field-reserved in style.css, which
    // keeps this settings block's rows aligned with the other tank's.
    sensorTankField.classList.toggle("field-reserved", count <= 1);
    const options = SUB_TANK_LETTERS.slice(0, count);
    sensorTankSelect.innerHTML = options.map((l) => `<option value="${l}">${l}</option>`).join("");
    sensorTankSelect.value = options.includes(selected) ? selected : options[0];
  }

  // Rebuilds the diameter/height row list to match `count`, preserving
  // whatever's already been typed (by position) when just growing/shrinking
  // the count, or using `existingDims` (from a fetched config) when given.
  function refreshDimsFields(count, existingDims) {
    const prevValues = Array.from(dimsList.querySelectorAll(".dims-row")).map((row) => ({
      diameter: row.querySelector(".diameter-mm").value,
      height: row.querySelector(".height-mm").value,
    }));
    dimsList.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const existing = existingDims && existingDims[i];
      const prev = prevValues[i];
      const diameterVal = existing ? existing.diameter_mm : (prev ? prev.diameter : "");
      const heightVal = existing ? existing.height_mm : (prev ? prev.height : "");
      const row = document.createElement("div");
      row.className = "dims-row";
      row.innerHTML = `
        <p class="dims-row-label">Tank${count > 1 ? " " + SUB_TANK_LETTERS[i] : ""}</p>
        <label class="field">
          <span>Diameter (mm)</span>
          <input type="number" class="diameter-mm" min="100" max="10000" value="${diameterVal}" required>
        </label>
        <label class="field">
          <span>Height (mm)</span>
          <input type="number" class="height-mm" min="100" max="10000" value="${heightVal}" required>
        </label>
      `;
      dimsList.appendChild(row);
    }
  }

  refreshSensorTankOptions(renderedCount, "A");
  refreshDimsFields(renderedCount, null);

  countInput.addEventListener("input", () => {
    const count = clampTankCount(countInput.value);
    refreshSensorTankOptions(count, sensorTankSelect.value);
    refreshDimsFields(count, null);
  });

  fetchConfig(group.id).then((cfg) => {
    if (!cfg) return;
    aliasInput.value = cfg.alias || "";
    outletInput.value = cfg.sensor_outlet_mm;
    overflowInput.value = cfg.sensor_overflow_mm;
    renderedCount = clampTankCount(cfg.tank_count);
    countInput.value = renderedCount;
    refreshSensorTankOptions(renderedCount, cfg.sensor_tank || "A");
    refreshDimsFields(renderedCount, cfg.tank_dims);
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
    if (!Number.isInteger(outletMm) || !Number.isInteger(overflowMm) || outletMm <= overflowMm) {
      statusEl.textContent = "Sensor Outlet must be a bigger number than Sensor Overflow.";
      statusEl.className = "status-msg error";
      return;
    }

    const tankDims = Array.from(dimsList.querySelectorAll(".dims-row")).map((row) => ({
      diameter_mm: parseInt(row.querySelector(".diameter-mm").value, 10),
      height_mm: parseInt(row.querySelector(".height-mm").value, 10),
    }));
    const dimsBad = tankDims.some(
      (d) => !Number.isInteger(d.diameter_mm) || d.diameter_mm < 100 || !Number.isInteger(d.height_mm) || d.height_mm < 100
    );
    if (dimsBad) {
      statusEl.textContent = "Each tank's Diameter and Height must be positive numbers (in mm).";
      statusEl.className = "status-msg error";
      return;
    }

    saveBtn.disabled = true;
    const result = await saveConfig(group.id, outletMm, overflowMm, tankCount, tankDims, sensorTank, alias, unlockedPassword);
    saveBtn.disabled = false;

    if (result.ok) {
      if (tankCount !== renderedCount) {
        statusEl.textContent = "Saved. Reloading to rebuild the tank layout...";
        statusEl.className = "status-msg ok";
        setTimeout(() => location.reload(), 1200);
      } else {
        statusEl.textContent = "Saved. " + group.name + " will pick this up within a minute.";
        statusEl.className = "status-msg ok";
        const subCapacities = tankDims.map((d) => computeCapacityL(d.diameter_mm, d.height_mm));
        if (onSaved) onSaved(alias, subCapacities);
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
  const groupCfgById = new Map(TANKS.map((group, i) => [group.id, groupConfigs[i]]));

  const instances = [];
  TANKS.forEach((group, gi) => {
    const groupCfg = groupConfigs[gi];
    const count = clampTankCount(groupCfg && groupCfg.tank_count);
    const sensorTank = (groupCfg && groupCfg.sensor_tank) || "A";
    const dims = groupCfg && Array.isArray(groupCfg.tank_dims) ? groupCfg.tank_dims : null;
    for (let i = 0; i < count; i++) {
      const subLabel = count > 1 ? SUB_TANK_LETTERS[i] : null;
      const d = dims && dims[i];
      instances.push({
        group,
        groupCfg,
        uid: `${group.id}_${i}`,
        indexInGroup: i,
        subLabel,
        hasSensor: count > 1 && subLabel === sensorTank,
        subCapacityL: d ? computeCapacityL(d.diameter_mm, d.height_mm) : null,
      });
    }
  });
  instances.forEach((inst, idx) => {
    inst.isFirstOverall = idx === 0;
  });

  // Each group gets its own bordered frame (a nested flex row with a
  // tighter gap than the outer row, which now only spaces frames apart from
  // each other -- sub-tanks within a group sit close together since
  // they're just pipe-coupled, not valved).
  const groupFrames = new Map();
  function cardsRowFor(group) {
    if (!groupFrames.has(group.id)) {
      const frame = document.createElement("div");
      frame.className = "tank-group-frame";
      const cardsRow = document.createElement("div");
      cardsRow.className = "tank-group-cards";
      frame.appendChild(cardsRow);
      container.appendChild(frame);
      groupFrames.set(group.id, { frame, cardsRow });
    }
    return groupFrames.get(group.id).cardsRow;
  }

  const cardRenders = instances.map((inst) => renderTankCard(inst, cardsRowFor(inst.group)));

  // A summary row per group, below its cards, inside the same frame: the
  // combined current litres (from the shared % reading) and the combined
  // max capacity (sum of every sub-tank's own capacity).
  const groupSummaries = new Map();
  TANKS.forEach((group, gi) => {
    const entry = groupFrames.get(group.id);
    const frame = entry && entry.frame;
    if (!frame) return;
    const groupCfg = groupConfigs[gi];
    const summary = document.createElement("div");
    summary.className = "group-summary";
    summary.innerHTML = `
      <div>Current: <span class="group-total-value">--</span> L</div>
      <div>Capacity: <span class="group-capacity-value">${(groupCfg && groupCfg.tank_capacity_l) || "--"}</span> L</div>
    `;
    frame.appendChild(summary);
    groupSummaries.set(group.id, {
      totalEl: summary.querySelector(".group-total-value"),
      capacityEl: summary.querySelector(".group-capacity-value"),
      capacityL: (groupCfg && groupCfg.tank_capacity_l) || null,
    });
  });

  computeAndApplyTankScale(container);
  const connectors = buildConnectors(container, cardRenders);
  if (connectors) {
    layoutConnectors(container, connectors, groupFrames);
    window.addEventListener("resize", () => {
      computeAndApplyTankScale(container);
      layoutConnectors(container, connectors, groupFrames);
    });
    startValveBlink(connectors);
  }

  async function pollAll() {
    await Promise.all(TANKS.map(async (group) => {
      let data = await fetchTelemetry(group.id);
      const isStale = data && (Date.now() - data.server_ts) > STALE_THRESHOLD_MS;

      // TEMPORARY DEV-ONLY FALLBACK -- see DEV_FAKE_DISTANCE_MM above.
      // Kicks in whenever there's no telemetry that's actually fresh right
      // now -- either none was ever posted, or what's stored is stale (e.g.
      // a real device posted once during earlier bench testing and hasn't
      // since) -- not just on a hard absence of any stored data.
      if ((!data || isStale) && DEV_FAKE_DISTANCE_MM[group.id] != null) {
        const gcfg = groupCfgById.get(group.id);
        const distanceMm = DEV_FAKE_DISTANCE_MM[group.id];
        const pct = gcfg ? computeLevelPercent(distanceMm, gcfg.sensor_outlet_mm, gcfg.sensor_overflow_mm) : -1;
        data = {
          distance_mm: distanceMm,
          level_pct: pct,
          valid: pct >= 0,
          rssi: null,
          uptime_s: 0,
          fw_version: null,
          server_ts: Date.now(),
        };
      }

      cardRenders
        .filter((r) => r.instance.group.id === group.id)
        .forEach((r) => r.updateFromTelemetry(data));

      const summary = groupSummaries.get(group.id);
      if (summary) {
        summary.totalEl.textContent =
          data && data.valid && data.level_pct >= 0 && summary.capacityL
            ? Math.round((data.level_pct / 100) * summary.capacityL)
            : "--";
      }
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
    renderTankSettingsForm(group, settingsList, (alias, subCapacities) => {
      const groupCards = cardRenders.filter((r) => r.instance.group.id === group.id);
      groupCards.forEach((r) => {
        r.setAlias(alias);
        r.setMaxLiters(subCapacities[r.instance.indexInGroup]);
      });

      const summary = groupSummaries.get(group.id);
      if (summary) {
        summary.capacityL = subCapacities.reduce((sum, c) => sum + c, 0);
        summary.capacityEl.textContent = Math.round(summary.capacityL);
      }

      computeAndApplyTankScale(container);
      if (connectors) layoutConnectors(container, connectors, groupFrames);
    });
  });

  setupChangePasswordForm();
}

main();
