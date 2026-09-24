// Fill in with the URL printed by `wrangler deploy` (see the repo README).
const API_BASE = "https://h2oscar-api.H2oscarsub.workers.dev";

const TANKS = [{ id: "tank1", name: "Tank 1" }];
const POLL_INTERVAL_MS = 2000;
const STALE_THRESHOLD_MS = 6000; // ~3x the firmware's push interval

const PASSWORD_STORAGE_KEY = "h2oscar_dash_password";

let lastGoodFetchAt = 0;

function setConn(ok) {
  document.getElementById("dot").className = "status-dot" + (ok ? " ok" : "");
  document.getElementById("connLabel").textContent = ok ? "Live" : "Disconnected – retrying…";
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

async function saveConfig(tankId, outletMm, overflowMm, password) {
  const res = await fetch(`${API_BASE}/api/tanks/${tankId}/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Dashboard-Password": password,
    },
    body: JSON.stringify({ sensor_outlet_mm: outletMm, sensor_overflow_mm: overflowMm }),
  });
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, body };
}

// Builds one tank card's DOM and returns a poll() function that refreshes it.
function renderTank(tank, container) {
  const card = document.createElement("div");
  card.className = "card tank-card";
  card.innerHTML = `
    <h2 class="tank-name">${tank.name}</h2>
    <div class="tank-shell">
      <div class="tank-water" style="height: 0%;"></div>
      <div class="tank-pct"><span class="pct-value">--</span><span class="pct-unit">%</span></div>
    </div>
    <div class="tank-meta">
      <div>Distance: <span class="distance-value">--</span> mm</div>
      <div>Volume: <span class="volume-value">--</span> L</div>
      <div class="tank-status stale">no data yet</div>
    </div>
  `;
  container.appendChild(card);

  const waterEl = card.querySelector(".tank-water");
  const pctEl = card.querySelector(".pct-value");
  const distEl = card.querySelector(".distance-value");
  const volEl = card.querySelector(".volume-value");
  const statusEl = card.querySelector(".tank-status");

  async function poll() {
    const data = await fetchTelemetry(tank.id);
    if (!data) {
      statusEl.textContent = "no data yet";
      statusEl.className = "tank-status stale";
      return false;
    }

    lastGoodFetchAt = Date.now();
    const age = Date.now() - data.server_ts;
    const stale = age > STALE_THRESHOLD_MS;

    if (data.valid && data.level_pct >= 0) {
      const pct = Math.round(data.level_pct);
      waterEl.style.height = pct + "%";
      pctEl.textContent = pct;
    } else {
      waterEl.style.height = "0%";
      pctEl.innerHTML = '<span class="na">n/a</span>';
    }
    distEl.textContent = data.valid ? Math.round(data.distance_mm) : "--";
    volEl.textContent = data.volume_l >= 0 ? Math.round(data.volume_l) : "n/a";

    statusEl.textContent = stale ? `stale (${Math.round(age / 1000)}s old)` : "live";
    statusEl.className = "tank-status " + (stale ? "stale" : "ok");
    return !stale;
  }

  return { poll };
}

function setupCalibrationForm() {
  const outletInput = document.getElementById("outlet-mm");
  const overflowInput = document.getElementById("overflow-mm");
  const passwordInput = document.getElementById("dash-password");
  const rememberBox = document.getElementById("remember-password");
  const statusEl = document.getElementById("cal-status");
  const saveBtn = document.getElementById("save-btn");
  const form = document.getElementById("cal-form");

  // Convenience only -- read from this browser's own storage, never
  // shipped in the page's source.
  try {
    const remembered = localStorage.getItem(PASSWORD_STORAGE_KEY);
    if (remembered) {
      passwordInput.value = remembered;
      rememberBox.checked = true;
    }
  } catch { /* storage unavailable (private mode etc.) -- ignore */ }

  fetchConfig("tank1").then((cfg) => {
    if (!cfg) return;
    outletInput.value = cfg.sensor_outlet_mm;
    overflowInput.value = cfg.sensor_overflow_mm;
  });

  form.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    statusEl.textContent = "";
    statusEl.className = "status-msg";

    const outletMm = parseInt(outletInput.value, 10);
    const overflowMm = parseInt(overflowInput.value, 10);
    if (!Number.isInteger(outletMm) || !Number.isInteger(overflowMm) || outletMm <= overflowMm) {
      statusEl.textContent = "Sensor Outlet must be a bigger number than Sensor Overflow.";
      statusEl.className = "status-msg error";
      return;
    }

    saveBtn.disabled = true;
    const password = passwordInput.value;
    const result = await saveConfig("tank1", outletMm, overflowMm, password);
    saveBtn.disabled = false;

    if (result.ok) {
      statusEl.textContent = "Saved. Tank 1 will pick this up within a minute.";
      statusEl.className = "status-msg ok";
      try {
        if (rememberBox.checked) localStorage.setItem(PASSWORD_STORAGE_KEY, password);
        else localStorage.removeItem(PASSWORD_STORAGE_KEY);
      } catch { /* ignore */ }
    } else if (result.status === 401) {
      statusEl.textContent = "Wrong password.";
      statusEl.className = "status-msg error";
    } else if (result.status === 429) {
      statusEl.textContent = "Too many attempts -- wait a few minutes and try again.";
      statusEl.className = "status-msg error";
    } else {
      statusEl.textContent = "Could not save (" + result.status + ").";
      statusEl.className = "status-msg error";
    }
  });
}

function main() {
  const container = document.getElementById("tanks");
  const tanks = TANKS.map((tank) => renderTank(tank, container));

  async function pollAll() {
    const results = await Promise.all(tanks.map((t) => t.poll()));
    setConn(results.some((ok) => ok) || Date.now() - lastGoodFetchAt < STALE_THRESHOLD_MS);
    document.getElementById("lastUpdate").textContent = new Date().toLocaleTimeString();
  }

  pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);

  setupCalibrationForm();
}

main();
