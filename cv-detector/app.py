"""
PrijelazRadar CV detector microservice (YOLO).

A small object-detection service the Node backend calls when CAMERA_CV_ENDPOINT
(or YOLO_ENDPOINT) is set. It runs a real YOLO model on the camera still and
returns per-class vehicle counts AND detection boxes, which take priority over
the built-in pixel heuristic for the vehicle mix, the queue band and the wait.

Contract (matches server/index.js runCvDetector + runYoloDetector):
  POST <endpoint>
  Headers: Authorization: Bearer <CAMERA_CV_API_KEY>   (optional)
  Body JSON: one of
     { cameraId, crossingId, direction, imageBase64, contentType }   # preferred (Node already fetched it)
     { cameraId, crossingId, direction, imageUrl }                   # fallback (service fetches it)
  Response JSON:
     { "counts": { "cars", "vans", "trucks", "buses" },
       "detections": [ { "type", "confidence", "x","y","w","h" } ],  # PIXEL coords
       "width", "height",            # so the Node side can normalise px -> percent
       "allowZero": true, "model": "yolov8n.pt", "elapsedMs": 0 }

Run locally:
  pip install -r requirements.txt
  CV_AUTH_TOKEN=secret uvicorn app:app --host 0.0.0.0 --port 8000
Then on the Node side:
  CAMERA_CV_ENDPOINT=http://localhost:8000/detect
  CAMERA_CV_API_KEY=secret
  YOLO_ENABLED=true                  # use YOLO for the wait (omit for shadow-compare only)
"""
import os
import io
import time
import base64
import logging

import requests
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from PIL import Image
from ultralytics import YOLO

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("cv-detector")

# yolov8s ("small") by default: the nano model misses the small/distant/compressed vehicles on the
# HAK/BIHAMK border stills (the "AI nije pronašao vozila" on a full lane). Use yolov8m for more
# accuracy if the host has the CPU/RAM, or set CV_MODEL=yolov8n.pt to go back to the fast nano.
MODEL_NAME = os.environ.get("CV_MODEL", "yolov8s.pt")
# Border-camera vehicles are small/distant → a slightly lower confidence catches them (was 0.30).
CONF_THRESHOLD = float(os.environ.get("CV_CONF", "0.25"))
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
BUCKET_TO_TYPE = {"cars": "car", "vans": "van", "trucks": "truck", "buses": "bus"}

app = FastAPI(title="PrijelazRadar CV detector", version="1.1")
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
    # The Node server normally sends the bytes it already fetched (preferred — avoids a second
    # fetch and works behind its image proxy / User-Agent). imageUrl is a fallback.
    imageBase64: str | None = None
    contentType: str | None = None
    imageUrl: str | None = None
    cameraUrl: str | None = None   # legacy alias for imageUrl
    source: str | None = None


def _load_image(req: DetectRequest) -> Image.Image:
    if req.imageBase64:
        raw = base64.b64decode(req.imageBase64)
        return Image.open(io.BytesIO(raw)).convert("RGB")
    url = req.imageUrl or req.cameraUrl
    if not url:
        raise ValueError("no imageBase64 and no imageUrl/cameraUrl")
    resp = requests.get(url, timeout=FETCH_TIMEOUT, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    return Image.open(io.BytesIO(resp.content)).convert("RGB")


def _empty(allow_zero: bool):
    return {"counts": {"cars": 0, "vans": 0, "trucks": 0, "buses": 0},
            "detections": [], "width": 0, "height": 0, "allowZero": allow_zero}


@app.on_event("startup")
def _warm_model():
    # Load the model at boot so the FIRST /detect is fast (no cold inference that would time out the
    # Node client and force a heuristic fallback). On CPU/Railway the first inference is the slow one.
    try:
        get_model()
        log.info("model warmed at startup: %s", MODEL_NAME)
    except Exception as exc:  # noqa: BLE001
        log.warning("model warm failed (will retry on first request): %s", exc)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME, "conf": CONF_THRESHOLD, "warm": _model is not None}


@app.post("/detect")
def detect(req: DetectRequest, authorization: str | None = Header(default=None)):
    if AUTH_TOKEN:
        if authorization != f"Bearer {AUTH_TOKEN}":
            raise HTTPException(status_code=401, detail="unauthorized")

    started = time.time()
    try:
        image = _load_image(req)
    except Exception as exc:  # noqa: BLE001 - fetch/decode failures are expected occasionally
        log.warning("image load failed for %s/%s: %s", req.crossingId, req.cameraId, exc)
        # allowZero=False → the Node side ignores us and falls back to the heuristic,
        # instead of reporting a fake-empty lane.
        return _empty(False)

    width, height = image.size
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
                "type": BUCKET_TO_TYPE[bucket],
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
        "width": width,
        "height": height,
        "model": MODEL_NAME,
        "elapsedMs": elapsed,
    }
