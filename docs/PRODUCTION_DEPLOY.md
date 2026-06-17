# PrijelazRadar — Production Deploy (first launch)

Practical deploy guide for Railway / staging / production. Conservative first launch:
the map, public sources, cameras and a stable wait estimate. The "smart but unproven"
layers (Prediction v2 headline, verified live location) ship **disabled** behind flags.

---

## 1. Required env vars

| Var | Purpose |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | Railway sets this automatically; the app reads `process.env.PORT` (falls back to 5050 locally). |
| `SESSION_SECRET` | Long random string. Signs auth tokens. **Required** before real deploy. |
| `VITE_GOOGLE_MAPS_API_KEY` | Browser Google Maps JS key (restrict by HTTP referrer). Build-time. |
| `GOOGLE_MAPS_SERVER_KEY` | Server Google Routes key (server-side only). Without it the map shows the calibrated zone but no live Google traffic. |
| `CAMERA_INGEST_API_KEY` | Protects `POST /api/camera-ingest`. |
| `BORDERFLOW_ADMIN_EMAIL` / `BORDERFLOW_ADMIN_PASSWORD` | Seeds the first admin (used only when the users table/file is empty). |

## 2. Optional env vars

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | _(empty)_ | Postgres connection. **Empty → file datastore** (`data/runtime-store.json`). Set it for production persistence. |
| `DATABASE_SSL` | `false` | `true` if your Postgres requires SSL. |
| `VITE_GOOGLE_MAPS_MAP_ID` | _(empty)_ | Optional Map ID for Advanced Markers. |
| `CAMERA_CV_ENDPOINT` | _(empty)_ | YOLO/cv-detector `/detect` URL. **Empty → heuristic only (no crash).** Set to your live cv-detector domain to enable AI counting. |
| `CAMERA_CV_API_KEY` | _(empty)_ | Bearer token for the cv-detector. |
| `SOURCE_FETCH_ENABLED` | `true` | BIHAMK / AMS / camera public-source ingestion. Graceful fallback if they're slow/down. |
| `CORS_ORIGINS` | _(empty)_ | Comma-separated allowed origins for production. |
| Readiness thresholds | see `.env.example` | `TRAFFIC_VISION_*` gate for promoting Prediction v2 — informational until you flip the flag. |

## 3. Railway deploy steps

1. Create a Railway project from this repo. Add a Postgres plugin (recommended) → it provides `DATABASE_URL`.
2. Set the env vars from sections 1–2 (at minimum: `NODE_ENV`, `SESSION_SECRET`, `VITE_GOOGLE_MAPS_API_KEY`, `GOOGLE_MAPS_SERVER_KEY`, `CAMERA_INGEST_API_KEY`, admin seed). Add `DATABASE_URL` for persistence.
3. Build command: `npm run build` (Vite client build). Start command: `npm start` (`node server/index.js`).
4. The server serves the built client and the API from one process on `PORT`.
5. Set the Railway healthcheck path to `/health`.

## 4. Database migration steps

- Schema is **idempotent** and applied automatically at boot (postgres mode): `server/index.js → ensureSqlSchema()` runs `sql/001_schema.sql`, which is entirely `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`.
- No manual migration step is required — deploy with `DATABASE_URL` set and the tables are created/verified on startup.
- Tables: `borderflow_users`, `borderflow_admin_overrides`, `borderflow_status_overrides`, `borderflow_driver_reports`, `borderflow_audit`, `borderflow_route_searches`, `borderflow_history_snapshots`, `borderflow_source_snapshots`, `borderflow_camera_snapshots`, `borderflow_prediction_accuracy`, `borderflow_measured_sessions`, `borderflow_camera_roi_configs`, `borderflow_location_wait_sessions`, `borderflow_alert_subscriptions`.
- **No `DATABASE_URL` → file datastore fallback** (`data/runtime-store.json`). Fine for a single-instance pilot; use Postgres for production durability (Railway FS is ephemeral).

## 5. Health / readiness check

- `GET /health` → liveness. Always `200 {ok,status:"alive",uptimeSeconds}` while the process is up. Use this for the Railway healthcheck.
- `GET /readiness` → state. `200` with booleans only (no secrets): `datastore`, `dbConnected`, and `checks.{googleMapsConfigured,cameraCvConfigured,publicSourcesEnabled,predictionV2Enabled,verifiedLocationEnabled,lastSourceRefreshAgeSeconds}`. `ready` is `false` only if Postgres is configured but unreachable. A missing optional integration (YOLO/Google) does **not** make it unready.

## 6. Feature flags for first launch

```env
PREDICTION_V2_ENABLED=false        # v2 runs in shadow; headline uses the proven legacy fusion
VERIFIED_LOCATION_ENABLED=true     # CORE signal: arms anonymous A→B passes + near-border measurement prompt (set false to disable)
YOLO_ROI_V2_ENABLED=true           # ROI queue counting (safe: no ROI → lower confidence, never crashes)
YOLO_ROI_EDITOR_ENABLED=false      # internal polygon editor stays 404
TRAFFIC_VISION_DEBUG=false         # internal cv-health/readiness debug stays 404
SOURCE_FETCH_ENABLED=true
```

YOLO turns on automatically when `CAMERA_CV_ENDPOINT` is set; leave it empty to launch on the heuristic.

## 7. What is intentionally disabled for launch

- **Prediction v2 headline** — computed in shadow + visible in the source breakdown, but the user-facing wait stays on the proven legacy fusion. Promote only when `/api/internal/traffic-vision/readiness` reports `readyForPredictionV2Headline:true`.
- **Verified live location (A→B)** — the map "Moja lokacija" button + own blue dot work, but no session is armed and no wait is measured. No raw GPS trail is ever stored.
- **Internal tools** — ROI editor (`/internal/roi-editor`) and Traffic-Vision debug endpoints return 404 unless their flag + token are set.

## 8. Smoke test checklist

- [ ] App opens
- [ ] Map loads
- [ ] Select direction HR → BiH
- [ ] Select direction BiH → HR
- [ ] Maljevac route crosses the border
- [ ] Izačić has no loop
- [ ] Vinjani Gornji crosses the border
- [ ] Main listed crossings have a usable route (both sides of the border)
- [ ] Camera status does not crash (heuristic or AI; no raw error text)
- [ ] Prediction card displays a sensible wait or fallback
- [ ] Mobile layout usable
- [ ] `GET /health` → 200
- [ ] `GET /readiness` → 200, no secrets
- [ ] `npm run build` OK

## 9. Rollback notes

- Stateless app: roll back by redeploying the previous image/commit on Railway.
- DB schema is additive + idempotent — a rollback to a prior app version is safe (older code ignores newer columns/tables; no destructive migrations).
- To instantly disable a risky layer without a redeploy, set its flag (`PREDICTION_V2_ENABLED`, `VERIFIED_LOCATION_ENABLED`, `CAMERA_CV_ENDPOINT`) and restart.

## 10. Known post-launch backlog (not required for launch)

1. Field-verify the calibrated display corridors for the manual crossings (Izačić, Vinjani Gornji) against the live map and refine where a road curves.
2. Promote Prediction v2 to the headline once accuracy/coverage thresholds in `/readiness` are met.
3. Enable verified live location after validating start/end anchors on 1–2 key crossings.
4. Train/connect a real YOLO model + commit reviewed ROI polygons for the key cameras.
5. Move ROI overrides + location sessions fully onto Postgres-only in multi-instance setups.
