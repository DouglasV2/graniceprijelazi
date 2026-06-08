# Maljevac — Production Smoke Test

Flagship crossing end-to-end verification. Run before every Maljevac-affecting deploy.
A step is **PASS** only if the *expected result* is met exactly; anything else is **FAIL** (note it).

> Automated companion: `tests/api/maljevac-smoke.test.js` (code-level surfaces) +
> `tests/api/location-wait-per-crossing.test.js` (verified A→B gating). Run `npm test`.

---

## 0. Env flags for the test

| Flag | Value for test | Effect |
| --- | --- | --- |
| `CAMERA_CV_ENDPOINT` | `https://<your cv-detector>` | enables YOLO (set `CV_MODEL=yolov8m.pt`, `CV_CONF=0.20`) |
| `TRAFFIC_VISION_DEBUG` | `true` | unlocks the internal debug endpoints |
| `TRAFFIC_VISION_DEBUG_TOKEN` | `<token>` | send as `x-debug-token` header |
| `VERIFIED_LOCATION_ENABLED` | `true` | turns on verified A→B globally |
| `VERIFIED_LOCATION_CROSSINGS` | `maljevac` | **arms A→B for Maljevac only** |
| `GOOGLE_MAPS_SERVER_KEY` | `<key>` | traffic-aware Google duration (else honest "unavailable") |

When `VERIFIED_LOCATION_ENABLED` is unset/false: A→B endpoints return `404 {disabled:true}` and the UI shows no live-location prompt — that is the correct disabled state.

---

## 1. Main app

| # | Step | Expected | P/F |
| --- | --- | --- | --- |
| 1.1 | Open the app | Loads, no crash, no raw JSON / stack trace anywhere | |
| 1.2 | Select Maljevac | Detail opens with a prediction card | |
| 1.3 | Direction HR → BiH | Wait/label/sources recompute for `toBih` | |
| 1.4 | Direction BiH → HR | Wait/label/sources recompute for `toHr` | |
| 1.5 | Open the camera tab | Images load OR fail gracefully (no broken-token text) | |

## 2. Camera / ROI (after yolov8m)

Debug (header `x-debug-token: <token>`):
```
GET /api/internal/traffic-vision/cv-health?cameraId=mal-hak-hr-exit&direction=toBih
GET /api/internal/traffic-vision/cv-health?cameraId=mal-hak-hr-entry&direction=toHr
```

| # | Step | Expected | P/F |
| --- | --- | --- | --- |
| 2.1 | cv-health both directions | `model:"yolov8m"`, `visibleDetections > 0` if cars are visible, `detectionsByClass` populated | |
| 2.2 | `roiTrusted` | `false` while ROI is only seeded → camera stays **visual-only** | |
| 2.3 | UI copy when YOLO sees cars but ROI untrusted | "Kamera prikazuje moguću kolonu" / "AI brojanje nije dovoljno pouzdano" — **never** a confident exact wait | |
| 2.4 | UI must NOT say | "AI kamera ne vidi kolonu" while ROI is untrusted | |

> Only mark an ROI `roiTrusted` after reviewing the polygon in `/internal/roi-editor` over the live frame. **Do not fake trusted.**

## 3. Driver reports (Dojave)

| # | Step | Expected | P/F |
| --- | --- | --- | --- |
| 3.1 | Tap "Dojavi", pick a high category (Gužva 60+ / Kontrola / Zatvoreno) | Sends `crossingId=maljevac`, `direction=<current>`, `waitMinutes` | |
| 3.2 | Success | Toast "Hvala — dojava je zabilježena." | |
| 3.3 | Effect on estimate | A fresh report ≥35 min becomes authoritative → estimate does **not** stay at "do 20" | |
| 3.4 | Debug (`/api/admin/traffic-vision/maljevac/<dir>`) | `sourceBreakdown.userReports.sampleCount ≥ 1`, `medianWaitMin` reflects it | |

Fusion rules (unit-tested): one report can't swing it (dedupe + trust), an outlier far from consensus is dropped (`detectReportAnomalies`), stale reports decay (half-life 25 min), measured/GPS outweighs anonymous.

## 4. Verified A→B (opt-in, Maljevac only)

Set `VERIFIED_LOCATION_ENABLED=true`, `VERIFIED_LOCATION_CROSSINGS=maljevac`.

| # | Step | Expected | P/F |
| --- | --- | --- | --- |
| 4.1 | Disabled (flags off) | A→B endpoints `404 {disabled}`, UI no crash, no pings | |
| 4.2 | Maljevac session start | `POST /api/location-wait/session {crossingId:"maljevac"}` → `armed:true, status:"pending"` | |
| 4.3 | Non-listed crossing | same call for another crossing → `armed:false, status:"disarmed"` | |
| 4.4 | Ping before start anchor | stays `pending` | |
| 4.5 | Ping inside start geofence | → `active` ("Live signal aktivan") | |
| 4.6 | Ping inside end geofence | → `completed`, finite `measuredWaitMin` (server timestamps) | |
| 4.7 | Status payload | NO `lat`/`lng`/`trail` (no raw GPS stored) | |
| 4.8 | Debug breakdown | `sourceBreakdown.verifiedLocation.sampleCount ≥ 1` after a completed session | |

Privacy: opt-in only (button), `watchPosition` starts **only after opt-in**, throttled pings, no other users rendered, stops on completed/cancelled/expired.

## 5. Location recommendation (separate from A→B)

| # | Step | Expected | P/F |
| --- | --- | --- | --- |
| 5.1 | "Pregled" tab | Card "Pronađi najbolji prijelaz prema tvojoj lokaciji" + "Koristi moju lokaciju" / "Ne sada" | |
| 5.2 | Deny permission | "Lokacija nije uključena…", app keeps working | |
| 5.3 | Allow permission | Blue dot on map; best crossing + alternatives shown | |
| 5.4 | Ranking | total = driveTime + wait + reliabilityPenalty; farther-but-lower-wait does not always win | |
| 5.5 | Click a recommendation | Selects that crossing + opens detail | |

Recommendation uses a **one-shot** `getCurrentPosition` (no continuous pings, no trail).

## 6. Maljevac estimate guardrails (the P0 blocker)

| # | Scenario | Expected | P/F |
| --- | --- | --- | --- |
| 6.1 | Camera visual medium/large queue | Never "do 20 min" — shows "od X min" / range | |
| 6.2 | Fresh user report ~120 min | Estimate high, not "do 20" | |
| 6.3 | Google low / blue approach | Does NOT by itself force a low estimate | |
| 6.4 | Untrusted YOLO no-detections | Does NOT lower the estimate | |
| 6.5 | Fresh verified A→B measurement | Dominates (ground truth) | |

---

## Debug endpoints (recap)

- `GET /api/internal/traffic-vision/cv-health?cameraId=&direction=` — model / detections / ROI (token).
- `GET /api/admin/traffic-vision/:crossingId/:direction` — finalEstimate, **sourceBreakdown**, **decision**, sourceStrength (admin).
- `GET /api/internal/traffic-vision/calibration?crossingId=maljevac&hours=72` — accuracy vs ground truth (token).
- `POST /api/internal/traffic-vision/ground-truth` — log an observed wait to score predictions (token).

## PASS / FAIL

- **PASS** = every section's expected result met; Maljevac never shows a confident "do 20 min" when any queue signal exists.
- **FAIL** = any crash, raw token/JSON leak, a confident low estimate against a visible/reported queue, raw GPS persisted, or pings while the feature is disabled. Record the step number + observed result.
