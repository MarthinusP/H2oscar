// Only the H2oscar GitHub Pages site is allowed to call this API from a
// browser. Update this if you serve the site from a different origin
// (e.g. a custom domain) -- CORS matches origin only, not path.
export const ALLOWED_ORIGIN = "https://marthinusp.github.io";

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Dashboard-Password",
    "Access-Control-Max-Age": "86400",
  };
}

export function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

export function jsonResponse(body, status = 200) {
  return withCors(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}
