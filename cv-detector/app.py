"""
PrijelazRadar CV detector microservice.

A small object-detection service that the Node backend calls when
CAMERA_CV_ENDPOINT is set. It runs a real YOLO model on the public camera
still and returns per-class vehicle counts, which take priority over the
built-in pixel heuristic for the displayed vehicle mix (auto / kombi /
kamion / bus) and lane signals.

Contract (must match server/index.js runCvDetector):
  POST <CAMERA_CV_ENDPOINT>
  Headers: Authorization: Bearer <CAMERA_CV_API_KEY>   (optional)
  Body JSON: { cameraId, crossingId, direction, imageUrl, source }
  Response JSON: { "counts": { "cars", "vans", "trucks", "buses" },
                   "allowZero": true, "detections": [...], "model": "..." }

Run locally:
  pip install -r requirements.txt
  CV_AUTH_TOKEN=secret uvicorn app:app --host 0.0.0.0 --port 8000
Then on the Node side:
  CAMERA_CV_ENDPOINT=http://localhost:8000/detect
  CAMERA_CV_API_KEY=secret
"""
import os
import io
import time
import logging

import requests
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from PIL import Image
from ultralytics import YOLO

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("cv-detector")

MODEL_NAME = os.environ.get("CV_MODEL", "yolov8n.pt")  # nano by default; use yolov8s/m for accuracy
CONF_THRESHOLD = float(os.environ.get("CV_CONF", "0.30"))
FETCH_TIMEOUT = float(os.environ.get("CV_FETCH_TIMEOUT", "6"))
AUTH_TOKEN = os.environ.get("CV_AUTH_TOKEN", "")  # if set, require matching Bearer
USER_AGENT = os.environ.get(
    "CV_USER_AGENT",
    "Mozilla/5.0 (compatible; PrijelazRadar-CV/1.0)",
)

# COCO class id -> our vehicle bucket. COCO has no "van"; vans are usually
# detected as car or truck, so we leave vans=0 and document it rather than
# guess. motorcycle is folded into cars for queue purposes.
COCO_TO_BUCKET = {
    2: "cars",        # car
    3: "cars",        # motorcycle
    5: "buses",       # bus
    7: "trucks",      # truck
}

app = FastAPI(title="PrijelazRadar CV detector", version="1.0")
_model = None


def get_model():
    global _model
    if _model is None:
        log.info("loading YOLO model: %s", MODEL_NAME)
        _model = YOLO(MODEL_NAME)
    return _model


class DetectRequest(BaseModel):
    cameraId: str | None = None
    crossingId: str | None = None
    direction: str | None = None
    imageUrl: str
    source: str | None = None


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME, "conf": CONF_THRESHOLD}


@app.post("/detect")
def detect(req: DetectRequest, authorization: str | None = Header(default=None)):
    if AUTH_TOKEN:
        expected = f"Bearer {AUTH_TOKEN}"
        if authorization != expected:
            raise HTTPException(status_code=401, detail="unauthorized")

    started = time.time()
    try:
        resp = requests.get(
            req.imageUrl,
            timeout=FETCH_TIMEOUT,
            headers={"User-Agent": USER_AGENT},
        )
        resp.raise_for_status()
        image = Image.open(io.BytesIO(resp.content)).convert("RGB")
    except Exception as exc:  # noqa: BLE001 - fetch/decode failures are expected occasionally
        log.warning("image fetch/decode failed for %s: %s", req.imageUrl, exc)
        # Returning counts=0 with allowZero=false makes the Node side ignore us
        # and fall back to the heuristic, instead of reporting a fake-empty lane.
        return {"counts": {"cars": 0, "vans": 0, "trucks": 0, "buses": 0}, "allowZero": False}

    counts = {"cars": 0, "vans": 0, "trucks": 0, "buses": 0}
    detections = []
    results = get_model().predict(image, conf=CONF_THRESHOLD, verbose=False)
    for result in results:
        for box in result.boxes:
            cls = int(box.cls[0])
            bucket = COCO_TO_BUCKET.get(cls)
            if not bucket:
                continue
            counts[bucket] += 1
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0])
            detections.append({
                "type": bucket[:-1],  # cars->car, trucks->truck, buses->buse(=bus below)
                "confidence": round(float(box.conf[0]) * 100),
                "x": round(x1, 1), "y": round(y1, 1),
                "w": round(x2 - x1, 1), "h": round(y2 - y1, 1),
            })

    elapsed = round((time.time() - started) * 1000)
    log.info("detected %s on %s/%s in %dms", counts, req.crossingId, req.cameraId, elapsed)
    return {
        "counts": counts,
        "allowZero": True,   # a genuinely empty lane is a valid result for us
        "detections": detections,
        "model": MODEL_NAME,
        "elapsedMs": elapsed,
    }
