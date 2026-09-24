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

Seed the config key so `GET /config` doesn't 404 before the first save from the site:

```
npx wrangler kv key put --binding=TELEMETRY_KV "tank:tank1:config" "{\"sensor_outlet_mm\":2000,\"sensor_overflow_mm\":250,\"updated_ts\":0}"
```

### 2. Enable GitHub Pages

Repo Settings -> Pages -> Source = "Deploy from a branch" -> `main` / `/ (root)`.
Note the URL it serves from. If it's not `https://marthinusp.github.io`, update
`ALLOWED_ORIGIN` in `worker/src/cors.js` to match and redeploy the worker.

### 3. Point the site at your Worker

Edit `app.js`, set `API_BASE` to the `*.workers.dev` URL from step 1, commit and push.

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

## Adding another tank later

Give the new ESP32 its own `TANK_ID` (e.g. `tank2`) and its own
`wrangler secret put TANK2_DEVICE_SECRET`; add it to the `TANKS` array at the
top of `app.js`. No other changes needed -- the Worker and the site are both
already keyed by tank id.
