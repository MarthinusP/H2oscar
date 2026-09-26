import { jsonResponse, withCors, corsHeaders } from "./cors.js";
import { timingSafeEqual, getDeviceSecret, checkBearerAuth, getDashboardPassword } from "./auth.js";
import { sendResetEmail } from "./email.js";

const TANK_ID_RE = /^[a-z0-9_-]+$/;
const ROUTE_RE = /^\/api\/tanks\/([a-z0-9_-]+)\/(telemetry|config)$/;

const CONFIG_MIN_MM = 20;
const CONFIG_MAX_MM = 4500;
const ALIAS_MAX_LEN = 40;
const TANK_COUNT_MIN = 1;
const TANK_COUNT_MAX = 5;
const SUB_TANK_LETTERS = ["A", "B", "C", "D", "E"];
const DIAMETER_MIN_MM = 100;
const DIAMETER_MAX_MM = 10000;
const HEIGHT_MIN_MM = 100;
const HEIGHT_MAX_MM = 10000;
const PASSWORD_MIN_LEN = 8;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const RATE_LIMIT_WINDOW_S = 300;

const RESET_TOKEN_TTL_S = 900; // 15 minutes
const RESET_MIN_PASSWORD_LEN = 8;
const RESET_RATE_LIMIT_MAX_ATTEMPTS = 5;
const RESET_RATE_LIMIT_WINDOW_S = 3600;

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/reset-request" && request.method === "POST") {
        return await handleResetRequest(request, env);
      }
      if (url.pathname === "/api/reset-confirm" && request.method === "POST") {
        return await handleResetConfirm(request, env);
      }
      if (url.pathname === "/api/verify-password" && request.method === "POST") {
        return await handleVerifyPassword(request, env);
      }
      if (url.pathname === "/api/change-password" && request.method === "POST") {
        return await handleChangePassword(request, env);
      }

      const match = url.pathname.match(ROUTE_RE);
      if (!match) {
        return jsonResponse({ error: "not_found" }, 404);
      }
      const [, tankId, resource] = match;
      if (!TANK_ID_RE.test(tankId)) {
        return jsonResponse({ error: "invalid_tank_id" }, 400);
      }

      if (resource === "telemetry") {
        if (request.method === "POST") return await handleTelemetryPost(request, env, tankId);
        if (request.method === "GET") return await handleTelemetryGet(env, tankId);
      } else if (resource === "config") {
        if (request.method === "GET") return await handleConfigGet(env, tankId);
        if (request.method === "POST") return await handleConfigPost(request, env, tankId);
      }
    } catch (err) {
      return jsonResponse({ error: "internal_error", detail: String(err) }, 500);
    }

    return jsonResponse({ error: "method_not_allowed" }, 405);
  },
};

async function handleTelemetryPost(request, env, tankId) {
  const secret = getDeviceSecret(env, tankId);
  if (!checkBearerAuth(request, secret)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  if (typeof body.distance_mm !== "number" || typeof body.valid !== "boolean") {
    return jsonResponse({ error: "missing_fields" }, 400);
  }

  const record = {
    distance_mm: body.distance_mm,
    level_pct: typeof body.level_pct === "number" ? body.level_pct : -1,
    volume_l: typeof body.volume_l === "number" ? body.volume_l : -1,
    valid: body.valid,
    rssi: typeof body.rssi === "number" ? body.rssi : null,
    uptime_s: typeof body.uptime_s === "number" ? body.uptime_s : null,
    fw_version: typeof body.fw_version === "string" ? body.fw_version : null,
    server_ts: Date.now(),
  };

  await env.TELEMETRY_KV.put(`tank:${tankId}:telemetry`, JSON.stringify(record));
  return jsonResponse({ ok: true });
}

async function handleTelemetryGet(env, tankId) {
  const stored = await env.TELEMETRY_KV.get(`tank:${tankId}:telemetry`);
  if (!stored) return jsonResponse({ error: "no_data" }, 404);
  return withCors(new Response(stored, { headers: { "Content-Type": "application/json" } }));
}

async function handleConfigGet(env, tankId) {
  const stored = await env.TELEMETRY_KV.get(`tank:${tankId}:config`);
  if (!stored) return jsonResponse({ error: "no_data" }, 404);
  return withCors(new Response(stored, { headers: { "Content-Type": "application/json" } }));
}

async function handleConfigPost(request, env, tankId) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const password = request.headers.get("X-Dashboard-Password") || "";
  const auth = await checkDashboardAuth(env, ip, password);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const outletMm = body.sensor_outlet_mm;
  const overflowMm = body.sensor_overflow_mm;
  const tankCount = body.tank_count;
  const diameterMm = body.tank_diameter_mm;
  const heightMm = body.tank_height_mm;
  const sensorTank = body.sensor_tank;
  if (
    !Number.isInteger(outletMm) ||
    !Number.isInteger(overflowMm) ||
    !Number.isInteger(tankCount) ||
    !Number.isInteger(diameterMm) ||
    !Number.isInteger(heightMm) ||
    outletMm < CONFIG_MIN_MM ||
    outletMm > CONFIG_MAX_MM ||
    overflowMm < CONFIG_MIN_MM ||
    overflowMm > CONFIG_MAX_MM ||
    outletMm <= overflowMm ||
    tankCount < TANK_COUNT_MIN ||
    tankCount > TANK_COUNT_MAX ||
    diameterMm < DIAMETER_MIN_MM ||
    diameterMm > DIAMETER_MAX_MM ||
    heightMm < HEIGHT_MIN_MM ||
    heightMm > HEIGHT_MAX_MM ||
    typeof sensorTank !== "string" ||
    !SUB_TANK_LETTERS.slice(0, tankCount).includes(sensorTank)
  ) {
    return jsonResponse({ error: "invalid_config" }, 400);
  }

  const alias = typeof body.alias === "string" ? body.alias.trim().slice(0, ALIAS_MAX_LEN) : "";

  // Volume is derived here (not trusted from the client) from a simple
  // cylindrical-tank formula -- diameter/height are what the user actually
  // measures; the firmware only ever needs the resulting litre figure.
  const radiusMm = diameterMm / 2;
  const capacityL = Math.max(1, Math.round((Math.PI * radiusMm * radiusMm * heightMm) / 1e6));

  const record = {
    sensor_outlet_mm: outletMm,
    sensor_overflow_mm: overflowMm,
    tank_count: tankCount,
    tank_diameter_mm: diameterMm,
    tank_height_mm: heightMm,
    tank_capacity_l: capacityL,
    sensor_tank: sensorTank,
    alias,
    updated_ts: Date.now(),
  };
  await env.TELEMETRY_KV.put(`tank:${tankId}:config`, JSON.stringify(record));
  return jsonResponse({ ok: true });
}

// Shared by every endpoint that checks the dashboard password, so brute-force
// attempts against any of them count against the same per-IP limit.
async function checkDashboardAuth(env, ip, password) {
  const rateLimitKey = `ratelimit:auth:${ip}`;

  if (await isRateLimited(env, rateLimitKey, RATE_LIMIT_MAX_ATTEMPTS)) {
    return { ok: false, status: 429, error: "too_many_attempts" };
  }

  const expectedPassword = await getDashboardPassword(env);
  if (!timingSafeEqual(password, expectedPassword)) {
    await recordRateLimitFailure(env, rateLimitKey, RATE_LIMIT_WINDOW_S);
    return { ok: false, status: 401, error: "unauthorized" };
  }

  await env.TELEMETRY_KV.delete(rateLimitKey);
  return { ok: true };
}

async function handleVerifyPassword(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  const password = typeof body.password === "string" ? body.password : "";
  const auth = await checkDashboardAuth(env, ip, password);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  return jsonResponse({ ok: true });
}

async function handleChangePassword(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const currentPassword = request.headers.get("X-Dashboard-Password") || "";
  const auth = await checkDashboardAuth(env, ip, currentPassword);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (newPassword.length < PASSWORD_MIN_LEN) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }

  await env.TELEMETRY_KV.put("auth:dashboard_password", newPassword);
  return jsonResponse({ ok: true });
}

async function isRateLimited(env, key, maxAttempts) {
  const raw = await env.TELEMETRY_KV.get(key);
  const count = raw ? JSON.parse(raw).count : 0;
  return count >= maxAttempts;
}

async function recordRateLimitFailure(env, key, windowS) {
  const raw = await env.TELEMETRY_KV.get(key);
  const count = raw ? JSON.parse(raw).count : 0;
  await env.TELEMETRY_KV.put(key, JSON.stringify({ count: count + 1 }), { expirationTtl: windowS });
}

// Always responds the same way regardless of whether the email matched, so
// the response itself never reveals which email address is configured.
async function handleResetRequest(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateLimitKey = `ratelimit:reset:${ip}`;

  if (await isRateLimited(env, rateLimitKey, RESET_RATE_LIMIT_MAX_ATTEMPTS)) {
    return jsonResponse({ error: "too_many_attempts" }, 429);
  }
  // Counts every attempt, not just failures -- this caps how many emails a
  // single IP can trigger, separate from guarding the password itself.
  await recordRateLimitFailure(env, rateLimitKey, RESET_RATE_LIMIT_WINDOW_S);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const expectedEmail = (env.RESET_EMAIL || "").trim().toLowerCase();

  if (email && expectedEmail && timingSafeEqual(email, expectedEmail)) {
    const token = crypto.randomUUID().replace(/-/g, "");
    await env.TELEMETRY_KV.put(
      `reset:${token}`,
      JSON.stringify({ createdAt: Date.now() }),
      { expirationTtl: RESET_TOKEN_TTL_S }
    );
    const resetUrl = `${env.SITE_URL}/reset.html?token=${token}`;
    try {
      await sendResetEmail(env, expectedEmail, resetUrl);
    } catch {
      // Swallow errors -- the response must look identical either way.
    }
  }

  return jsonResponse({ ok: true });
}

async function handleResetConfirm(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const token = typeof body.token === "string" ? body.token : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!token || newPassword.length < RESET_MIN_PASSWORD_LEN) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }

  const tokenKey = `reset:${token}`;
  const tokenRecord = await env.TELEMETRY_KV.get(tokenKey);
  if (!tokenRecord) {
    return jsonResponse({ error: "invalid_or_expired_token" }, 400);
  }

  await env.TELEMETRY_KV.delete(tokenKey);
  await env.TELEMETRY_KV.put("auth:dashboard_password", newPassword);
  return jsonResponse({ ok: true });
}
