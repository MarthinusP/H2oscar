# H2oscar

Water tank monitoring dashboard. A static site (this repo, hosted on GitHub Pages)
shows Tank 1's live fill level and lets you adjust its calibration, from home or
away. A small Cloudflare Worker (`worker/`) sits in between so the ESP32 never
has to accept inbound connections from the internet.

```
ESP32 (Tank 1) --HTTPS POST telemetry--> Cloudflare Worker --KV--> this site
               <--HTTPS GET config------                  <--fetch--
                                     ^
                     POST config (password-gated) ----------|
```

The firmware side of this lives in the separate `esp32_water_monitor` project
(`src/cloud_client.h`, `src/calibration.h`).

## One-time setup

### 1. Deploy the Cloudflare Worker

```
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create TELEMETRY_KV
```

Paste the returned `id` into `worker/wrangler.toml`'s `[[kv_namespaces]]` block.

```
npx wrangler secret put TANK1_DEVICE_SECRET   # a long random string; the ESP32 uses this
npx wrangler secret put DASHBOARD_PASSWORD    # the password you'll type into the website
npx wrangler deploy
```

Note the `https://h2oscar-api.<subdomain>.workers.dev` URL it prints.

Seed the config key so `GET /config` doesn't 404 before the first save from the site
(a file sidesteps shell-quoting issues an inline JSON string can run into on Windows):

```
npx wrangler kv key put --binding=TELEMETRY_KV "tank:tank1:config" --path tank1-config.json
```

where `tank1-config.json` (in the `worker` folder) contains:

```json
{"sensor_outlet_mm":2000,"sensor_overflow_mm":250,"tank_capacity_l":5000,"updated_ts":0}
```

### 2. Enable GitHub Pages

Repo Settings -> Pages -> Source = "Deploy from a branch" -> `main` / `/ (root)`.
Note the URL it serves from. If it's not `https://marthinusp.github.io`, update
`ALLOWED_ORIGIN` in `worker/src/cors.js` to match and redeploy the worker.

### 3. Point the site at your Worker

Edit `site-config.js`, set `API_BASE` to the `*.workers.dev` URL from step 1, commit and push.
(Both `index.html` and `reset.html` load this one file, so it only needs setting once.)

### 4. Point the firmware at your Worker

In `esp32_water_monitor/src/config.h`, set `CLOUD_API_BASE` to the same URL, and
`TANK_DEVICE_SECRET` to the same value you gave `wrangler secret put
TANK1_DEVICE_SECRET`. Flash as usual.

## Verifying it works

```
curl https://h2oscar-api.<subdomain>.workers.dev/api/tanks/tank1/config
```

should return the seeded JSON. Once the ESP32 is flashed and on your home WiFi,
its serial monitor should print `[CLOUD] Telemetry push: HTTP 200` every ~7s,
and the site should show Tank 1's live level within a few seconds. Changing the
calibration on the site should show up in the ESP32's serial log (`[CLOUD]
Config updated from cloud: ...`) within about a minute, and survive a
power-cycle.

## Settings on the site

Calibration and the password live behind the gear icon in the top-right
corner, not on the page itself. Clicking it asks for the dashboard password
(checked via `POST /api/verify-password`, no calibration payload needed);
once verified, the password is kept in memory for the rest of that page
load (not persisted anywhere) and the Settings panel opens with:

- **Alias / Sensor Outlet / Sensor Overflow / Diameter / Height** -- saved
  together via `POST /api/tanks/:id/config`. Alias is an optional display
  name (falls back to "Tank 1"/"Tank 2"). Diameter/Height (mm) are a
  physical measurement, separate from Sensor Outlet/Overflow -- the Worker
  derives the litres from them (`pi*(diameter/2)^2*height`) into
  `tank_capacity_l`, for display only; none of this affects the
  fill-percent calculation, which only ever depends on Sensor
  Outlet/Overflow.
- **Change password** -- a new `POST /api/change-password` endpoint, gated
  by the *current* password (sent the same way as a config save) rather
  than an emailed token. Successfully changing it updates the in-memory
  password used for the rest of the session too.

Both endpoints share the same brute-force rate limit as config saves (10
attempts per 5 minutes per IP) since they all gate on the same password.

## Password reset

If you forget the dashboard password, the "Forgot password?" link on the site
emails you a one-time link to set a new one -- but only if the email you type
in matches `RESET_EMAIL`, which you configure once yourself (a Worker can't
read your Cloudflare account's email, so this has to be set explicitly):

```
cd worker
npx wrangler secret put RESET_EMAIL        # the only email address resets will be sent to
npx wrangler secret put RESEND_API_KEY     # from resend.com -- free tier, no domain verification needed
npx wrangler deploy
```

Also set `SITE_URL` in `worker/wrangler.toml`'s `[vars]` block to your real
Pages URL (used to build the link inside the email) if it differs from the
default, then redeploy.

Sending uses Resend's shared `onboarding@resend.dev` address, which only
delivers to the email on your own Resend account -- which is `RESET_EMAIL`
here anyway, so no domain setup is needed. A wrong email at the reset form
gets exactly the same on-screen response as a correct one; only a match
actually triggers an email, so there's no way to tell from the outside
whether an address matched.

Once you request a reset, the emailed link goes to `reset.html`, is valid for
15 minutes, and works once. Setting a new password there replaces the one in
KV -- the original `DASHBOARD_PASSWORD` secret is now only used as a fallback
before the first-ever reset.

## Tank 2

A second ESP32 ("ESP2"), physically identical to ESP1 (same A02YYUW wiring,
same button/LED pins), reports as `tank2`. Its firmware is a full duplicate
of `esp32_water_monitor` at `../esp32_water_monitor_tank2`, differing only
in `config.h` (`AP_SSID`/`AP_PASSWORD` = `"H2-Oscar2"`/`"H2oscar2@123!"`,
`TANK_ID = "tank2"`, its own `TANK_DEVICE_SECRET`) -- its own setup network,
WiFi provisioning flow, and default-button behaviour work exactly like ESP1.

To bring it online:

```
cd worker
npx wrangler secret put TANK2_DEVICE_SECRET   # must match esp32_water_monitor_tank2/src/config.h
npx wrangler deploy
npx wrangler kv key put --binding=TELEMETRY_KV "tank:tank2:config" --path tank2-config.json
```

Tank 2 shows up automatically on the site (it's in the `TANKS` array in
`app.js`) with its own Settings section, to the right of Tank 1, connected
to it by a pipe with a solenoid valve graphic in the middle -- for now that
valve just alternates green/red every 10 seconds as a placeholder for a
real transfer-control feature later.

## Adding a third tank later

Same pattern as Tank 2: duplicate the firmware project, give it its own
`AP_SSID`/`TANK_ID`/`TANK_DEVICE_SECRET`, set a matching `wrangler secret
put TANK3_DEVICE_SECRET`, seed `tank:tank3:config`, and add it to the
`TANKS` array in `app.js`. It'll automatically pipe on from Tank 2 -- no
extra flag needed.
