import { jsonResponse, withCors, corsHeaders } from "./cors.js";
import { timingSafeEqual, getDeviceSecret, checkBearerAuth } from "./auth.js";

const TANK_ID_RE = /^[a-z0-9_-]+$/;
const ROUTE_RE = /^\/api\/tanks\/([a-z0-9_-]+)\/(telemetry|config)$/;

const CONFIG_MIN_MM = 20;
const CONFIG_MAX_MM = 4500;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const RATE_LIMIT_WINDOW_S = 300;

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const match = url.pathname.match(ROUTE_RE);
    if (!match) {
      return jsonResponse({ error: "not_found" }, 404);
    }
    const [, tankId, resource] = match;
    if (!TANK_ID_RE.test(tankId)) {
      return jsonResponse({ error: "invalid_tank_id" }, 400);
    }

    try {
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
  const rateLimitKey = `ratelimit:config:${ip}`;

  const rateLimitRaw = await env.TELEMETRY_KV.get(rateLimitKey);
  const rateLimit = rateLimitRaw ? JSON.parse(rateLimitRaw) : { count: 0 };
  if (rateLimit.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    return jsonResponse({ error: "too_many_attempts" }, 429);
  }

  const password = request.headers.get("X-Dashboard-Password") || "";
  if (!timingSafeEqual(password, env.DASHBOARD_PASSWORD || "")) {
    await env.TELEMETRY_KV.put(
      rateLimitKey,
      JSON.stringify({ count: rateLimit.count + 1 }),
      { expirationTtl: RATE_LIMIT_WINDOW_S }
    );
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  await env.TELEMETRY_KV.delete(rateLimitKey);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const outletMm = body.sensor_outlet_mm;
  const overflowMm = body.sensor_overflow_mm;
  if (
    !Number.isInteger(outletMm) ||
    !Number.isInteger(overflowMm) ||
    outletMm < CONFIG_MIN_MM ||
    outletMm > CONFIG_MAX_MM ||
    overflowMm < CONFIG_MIN_MM ||
    overflowMm > CONFIG_MAX_MM ||
    outletMm <= overflowMm
  ) {
    return jsonResponse({ error: "invalid_config" }, 400);
  }

  const record = { sensor_outlet_mm: outletMm, sensor_overflow_mm: overflowMm, updated_ts: Date.now() };
  await env.TELEMETRY_KV.put(`tank:${tankId}:config`, JSON.stringify(record));
  return jsonResponse({ ok: true });
}
