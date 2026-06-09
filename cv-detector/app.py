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
  Response JSON (200 ONLY on a successful inference — an empty list then means a genuinely empty lane):
     { "counts": { "cars", "vans", "trucks", "buses" },
       "detections": [ { "type", "confidence", "x","y","w","h" } ],  # PIXEL coords
       "width", "height", "allowZero": true, "model": "yolov8s.pt", "elapsedMs": 0 }
  FAILURE (image fetch/decode error, model not loaded, inference error, or the service is busy) returns
  a NON-200 (502/503) so the Node side records "detector unavailable" and falls back to the heuristic —
  it must NEVER look like "0 vehicles". Only a successful inference with zero boxes is a real zero.

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
import threading

import requests
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from PIL import Image
from ultralytics import YOLO

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("cv-detector")

# Model ladder (see README): yolov8n=fast/low-mem fallback, yolov8s=production default,
# yolov8m=only with confirmed RAM headroom (Pro). Switch via CV_MODEL — no code change.
MODEL_NAME = os.environ.get("CV_MODEL", "yolov8s.pt")
# Border-camera vehicles are small/distant → a slightly lower confidence catches them.
CONF_THRESHOLD = float(os.environ.get("CV_CONF", "0.25"))
# Cap inference resolution to bound memory/latency (0 = model's native handling). 640 is a good default.
CV_IMGSZ = int(os.environ.get("CV_IMGSZ", "0") or "0")
# Bounded concurrency: never run more than this many YOLO inferences at once (memory safety under a
# refresh burst). Extra requests wait up to CV_QUEUE_TIMEOUT, then get a controlled 503 (Node falls
# back to the heuristic instead of piling up an inference storm / OOM).
CV_MAX_CONCURRENCY = max(1, int(os.environ.get("CV_MAX_CONCURRENCY", "1") or "1"))
CV_QUEUE_TIMEOUT = float(os.environ.get("CV_QUEUE_TIMEOUT", "8"))
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

app = FastAPI(title="PrijelazRadar CV detector", version="1.2")
_model = None
_model_lock = threading.Lock()
# Bound concurrent inferences. BoundedSemaphore so an over-release is a loud bug, not a silent leak.
_infer_sema = threading.BoundedSemaphore(CV_MAX_CONCURRENCY)
_started_at = time.time()
_stats_lock = threading.Lock()
_stats = {
    "total": 0,          # /detect requests received
    "failed": 0,         # image-load / inference / busy failures
    "zeroResults": 0,    # successful inferences that found no vehicles
    "active": 0,         # inferences in flight right now
    "queuedRejected": 0,  # 503s from the concurrency gate
    "lastInferenceMs": None,
    "lastError": None,
}


def _bump(**delta):
    with _stats_lock:
        for k, v in delta.items():
            if k in ("lastInferenceMs", "lastError"):
                _stats[k] = v
            else:
                _stats[k] = _stats.get(k, 0) + v


def _memory_mb():
    # Stdlib-only RSS (Linux/macOS). ru_maxrss is KB on Linux, bytes on macOS.
    try:
        import resource  # noqa: PLC0415 - optional, unix only
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        import sys
        return round((rss / 1024) if sys.platform != "darwin" else (rss / 1024 / 1024), 1)
    except Exception:  # noqa: BLE001
        return None


def get_model():
    global _model
    if _model is None:
        with _model_lock:                 # load exactly once even under concurrent first requests
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
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        del raw  # don't retain the encoded bytes beyond decode
        return img
    url = req.imageUrl or req.cameraUrl
    if not url:
        raise ValueError("no imageBase64 and no imageUrl/cameraUrl")
    resp = requests.get(url, timeout=FETCH_TIMEOUT, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    return Image.open(io.BytesIO(resp.content)).convert("RGB")


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
    with _stats_lock:
        s = dict(_stats)
    return {
        "ok": True,
        "model": MODEL_NAME,
        "conf": CONF_THRESHOLD,
        "imgsz": CV_IMGSZ or "native",
        "maxConcurrency": CV_MAX_CONCURRENCY,
        "warm": _model is not None,
        "uptimeSec": round(time.time() - _started_at),
        "memoryMb": _memory_mb(),
        "totalRequests": s["total"],
        "failedRequests": s["failed"],
        "zeroResultRequests": s["zeroResults"],
        "activeInferences": s["active"],
        "queuedRejected": s["queuedRejected"],
        "lastInferenceMs": s["lastInferenceMs"],
        "lastError": s["lastError"],
    }


@app.post("/detect")
def detect(req: DetectRequest, authorization: str | None = Header(default=None)):
    if AUTH_TOKEN and authorization != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")
    _bump(total=1)

    started = time.time()
    try:
        image = _load_image(req)
    except Exception as exc:  # noqa: BLE001 - fetch/decode failures are expected occasionally
        log.warning("image load failed for %s/%s: %s", req.crossingId, req.cameraId, exc)
        _bump(failed=1, lastError=f"image-load: {str(exc)[:120]}")
        # NON-200 so Node records "detector unavailable" + heuristic fallback — NOT a fake-empty lane.
        raise HTTPException(status_code=502, detail="image-unavailable")

    # Concurrency gate: bound simultaneous inferences so a refresh burst can't OOM the box.
    if not _infer_sema.acquire(timeout=CV_QUEUE_TIMEOUT):
        _bump(failed=1, queuedRejected=1, lastError="busy: inference concurrency limit")
        log.warning("inference busy (>=%d active) — rejecting %s/%s", CV_MAX_CONCURRENCY, req.crossingId, req.cameraId)
        raise HTTPException(status_code=503, detail="busy")
    _bump(active=1)
    try:
        kwargs = {"conf": CONF_THRESHOLD, "verbose": False}
        if CV_IMGSZ:
            kwargs["imgsz"] = CV_IMGSZ
        results = get_model().predict(image, **kwargs)
    except Exception as exc:  # noqa: BLE001 - inference error (incl. recoverable OOM) ≠ "0 vehicles"
        _bump(failed=1, lastError=f"inference: {str(exc)[:120]}")
        log.error("inference failed for %s/%s: %s", req.crossingId, req.cameraId, exc)
        raise HTTPException(status_code=503, detail="inference-failed")
    finally:
        _bump(active=-1)
        _infer_sema.release()

    width, height = image.size
    counts = {"cars": 0, "vans": 0, "trucks": 0, "buses": 0}
    detections = []
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
    _bump(lastInferenceMs=elapsed, lastError=None)
    if not detections:
        _bump(zeroResults=1)
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
