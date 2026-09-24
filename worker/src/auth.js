// Constant-time-ish string compare -- always walks the full length of the
// longer string so a mismatch doesn't return faster than a match would.
// Cheap insurance at this traffic scale, not a hard security requirement.
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

export function getDeviceSecret(env, tankId) {
  const key = `${tankId.toUpperCase()}_DEVICE_SECRET`;
  return env[key];
}

export function checkBearerAuth(request, expectedSecret) {
  if (!expectedSecret) return false;
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return false;
  return timingSafeEqual(match[1], expectedSecret);
}

// The dashboard password lives in KV (mutable, so a reset can change it) with
// the DASHBOARD_PASSWORD secret only used as the seed value the first time
// -- before any reset has ever happened.
export async function getDashboardPassword(env) {
  const stored = await env.TELEMETRY_KV.get("auth:dashboard_password");
  return stored || env.DASHBOARD_PASSWORD || "";
}
