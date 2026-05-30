# PrijelazRadar CV detector

Real object-detection microservice for vehicle counting on the border cameras.
The Node backend (`server/index.js` → `runCvDetector`) calls this service when
`CAMERA_CV_ENDPOINT` is set; the returned per-class counts take priority over
the built-in pixel heuristic for the displayed vehicle mix (auto / kombi /
kamion / bus) and lane signals.

## Why

The built-in heuristic estimates a queue from pixel darkness/edges + occupied
lane area. It is good enough for "how full is the lane" but cannot reliably tell
a car from a truck from a bus. A real model (YOLO here) gives trustworthy
per-class counts, which is what improves `auto/kamion/bus` detection.

## API contract

```
POST <CAMERA_CV_ENDPOINT>            # e.g. http://cv:8000/detect
Authorization: Bearer <CAMERA_CV_API_KEY>   # optional, must equal CV_AUTH_TOKEN
Content-Type: application/json
{ "cameraId": "...", "crossingId": "...", "direction": "toBih",
  "imageUrl": "https://www.hak.hr/info/kamere/429.jpg", "source": "HAK" }

200 OK
{ "counts": { "cars": 7, "vans": 0, "trucks": 1, "buses": 0 },
  "allowZero": true, "detections": [ ... ], "model": "yolov8n.pt" }
```

- `allowZero: true` means an empty result is a real "no vehicles" reading.
- On fetch/decode failure the service returns `allowZero: false`, so the Node
  side ignores it and falls back to the heuristic instead of reporting a
  fake-empty lane (preserves user trust).

## Run

### Local
```bash
cd cv-detector
pip install -r requirements.txt
CV_AUTH_TOKEN=choose-a-secret uvicorn app:app --host 0.0.0.0 --port 8000
```

### Docker
```bash
docker build -t prijelazradar-cv ./cv-detector
docker run -p 8000:8000 -e CV_AUTH_TOKEN=choose-a-secret prijelazradar-cv
```

### Wire the Node backend
In `.env.local` / hosting env:
```
CAMERA_CV_ENDPOINT=http://localhost:8000/detect
CAMERA_CV_API_KEY=choose-a-secret
```

## Config (env)

| Var | Default | Notes |
|-----|---------|-------|
| `CV_MODEL` | `yolov8n.pt` | Use `yolov8s.pt` / `yolov8m.pt` for higher accuracy (slower). |
| `CV_CONF` | `0.30` | Detection confidence threshold. |
| `CV_FETCH_TIMEOUT` | `6` | Seconds to fetch the camera still. |
| `CV_AUTH_TOKEN` | _(empty)_ | If set, require `Authorization: Bearer <token>`. |

## Accuracy notes / roadmap

- COCO has no "van" class — vans are detected as car/truck, so `vans` stays 0.
  If you need vans, fine-tune a model or add a size/aspect heuristic on `truck`.
- For best results per camera, crop to the queue lane before inference. The
  request already includes `cameraId`/`direction`; you can keep a per-camera ROI
  map here and crop `image` before `predict()` (mirrors `calibration.roi` on the
  Node side).
- Counts currently improve the displayed vehicle **mix**. To also let the model
  drive the **wait**, feed `counts` total into the queue estimate on the Node
  side (follow-up in `buildCameraAnalyticsPayload`).
```
