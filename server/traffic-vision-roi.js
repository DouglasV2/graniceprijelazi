// YOLO ROI v2 — pure geometry + queue-classification + multi-frame helpers. No network, no store,
// no globals → fully unit-testable. The server wires these into the camera prediction path behind
// YOLO_ROI_V2_ENABLED / CAMERA_YOLO_MULTI_FRAME_ENABLED with a heuristic fallback, so a failure
// here never crashes the camera pipeline.
const isNum = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const round2 = (v) => Math.round(Number(v) * 100) / 100;

// Normalise a single coordinate to 0..1. coordSpace: 'normalized' | 'percent' | 'pixel' | 'auto'.
// 'auto' infers: ≤1 → already normalized, ≤100 → percent, else pixel (needs dim).
function normCoord(v, dim, coordSpace = 'auto') {
  if (!isNum(v)) return null;
  const n = Number(v);
  if (coordSpace === 'normalized') return clamp01(n);
  if (coordSpace === 'percent') return clamp01(n / 100);
  if (coordSpace === 'pixel') return dim > 0 ? clamp01(n / dim) : clamp01(n);
  // auto
  if (n >= 0 && n <= 1) return clamp01(n);
  if (n <= 100) return clamp01(n / 100);
  return dim > 0 ? clamp01(n / dim) : clamp01(n / 100);
}

export function normalizePoint(point = {}, width = 0, height = 0, coordSpace = 'auto') {
  return { x: normCoord(point.x, width, coordSpace), y: normCoord(point.y, height, coordSpace) };
}

// A polygon is an array of ≥3 {x,y} points, each in 0..1.
export function validatePolygon(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  return polygon.every((p) => p && isNum(p.x) && isNum(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
}

// Validate a full ROI config → { valid, errors }. Never throws.
export function validateRoiConfig(config = {}) {
  const errors = [];
  if (!config || typeof config !== 'object') return { valid: false, errors: ['config nije objekt'] };
  if (config.queuePolygon !== null && config.queuePolygon !== undefined) {
    if (!validatePolygon(config.queuePolygon)) errors.push('queuePolygon mora imati ≥3 točke, svaka x,y u 0..1');
  }
  if (config.ignorePolygons !== null && config.ignorePolygons !== undefined) {
    if (!Array.isArray(config.ignorePolygons)) errors.push('ignorePolygons mora biti array poligona');
    else config.ignorePolygons.forEach((poly, i) => { if (!validatePolygon(poly)) errors.push(`ignorePolygons[${i}] nije valjan poligon (≥3 točke, 0..1)`); });
  }
  if (config.lanePolygons !== null && config.lanePolygons !== undefined) {
    if (!Array.isArray(config.lanePolygons)) errors.push('lanePolygons mora biti array poligona');
    else config.lanePolygons.forEach((poly, i) => { if (!validatePolygon(poly)) errors.push(`lanePolygons[${i}] nije valjan poligon`); });
  }
  for (const key of ['cameraReliability', 'nightReliability']) {
    if (config[key] !== null && config[key] !== undefined && (!isNum(config[key]) || config[key] < 0 || config[key] > 1)) {
      errors.push(`${key} mora biti broj 0..1`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// Ray-casting point-in-polygon. point + polygon in the SAME (normalized 0..1) space.
export function pointInPolygon(point, polygon) {
  if (!point || !isNum(point.x) || !isNum(point.y) || !Array.isArray(polygon) || polygon.length < 3) return false;
  const { x, y } = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x; const yi = polygon[i].y;
    const xj = polygon[j].x; const yj = polygon[j].y;
    const intersects = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// Extract a normalized 0..1 center from many possible detection shapes; null if unusable.
export function getDetectionCenter(detection = {}, imageWidth = 0, imageHeight = 0, coordSpace = 'auto') {
  if (!detection || typeof detection !== 'object') return null;
  let cx; let cy;
  if (Array.isArray(detection.bbox) && detection.bbox.length >= 4) {
    cx = (Number(detection.bbox[0]) + Number(detection.bbox[2])) / 2;
    cy = (Number(detection.bbox[1]) + Number(detection.bbox[3])) / 2;
  } else if (isNum(detection.xmin) && isNum(detection.xmax)) {
    cx = (Number(detection.xmin) + Number(detection.xmax)) / 2;
    cy = (Number(detection.ymin) + Number(detection.ymax)) / 2;
  } else if (isNum(detection.width) || isNum(detection.w)) {
    const w = Number(detection.width ?? detection.w ?? 0);
    const h = Number(detection.height ?? detection.h ?? 0);
    cx = Number(detection.x) + w / 2;
    cy = Number(detection.y) + h / 2;
  } else if (isNum(detection.cx) && isNum(detection.cy)) {
    cx = Number(detection.cx); cy = Number(detection.cy);
  } else if (isNum(detection.x) && isNum(detection.y)) {
    cx = Number(detection.x); cy = Number(detection.y); // already a center point
  } else {
    return null;
  }
  const x = normCoord(cx, imageWidth, coordSpace);
  const y = normCoord(cy, imageHeight, coordSpace);
  if (x === null || y === null) return null;
  return { x, y };
}

export function isDetectionInPolygon(detection, polygon, imageWidth = 0, imageHeight = 0, coordSpace = 'auto') {
  const c = getDetectionCenter(detection, imageWidth, imageHeight, coordSpace);
  if (!c) return false;
  return pointInPolygon(c, polygon);
}

function isVehicle(detection = {}) {
  const t = String(detection.type || detection.label || detection.cls || detection.class || 'car').toLowerCase();
  return ['car', 'auto', 'truck', 'kamion', 'bus', 'autobus', 'van', 'kombi', 'motorcycle', 'motor'].some((k) => t.includes(k));
}
function vehicleBucket(detection = {}) {
  const t = String(detection.type || detection.label || detection.cls || detection.class || 'car').toLowerCase();
  if (t.includes('truck') || t.includes('kamion')) return 'truck';
  if (t.includes('bus')) return 'bus';
  if (t.includes('van') || t.includes('kombi')) return 'van';
  if (t.includes('motor')) return 'motorcycle';
  return 'car';
}
function detConfidence(d = {}) {
  const c = Number(d.confidence ?? d.score ?? d.conf ?? 0);
  return c <= 1 ? c * 100 : c; // normalise to 0..100
}

// Classify YOLO detections against the ROI config. ignorePolygon WINS over queuePolygon.
// Returns { insideQueueRoi, ignored, outsideQueueRoi, invalid }.
export function classifyDetectionsByRoi(detections = [], roiConfig = {}, imageWidth = 0, imageHeight = 0, coordSpace = 'auto') {
  const out = { insideQueueRoi: [], ignored: [], outsideQueueRoi: [], invalid: [] };
  const list = Array.isArray(detections) ? detections : [];
  const queue = roiConfig && validatePolygon(roiConfig.queuePolygon) ? roiConfig.queuePolygon : null;
  const ignores = roiConfig && Array.isArray(roiConfig.ignorePolygons) ? roiConfig.ignorePolygons.filter(validatePolygon) : [];
  for (const d of list) {
    if (!d || typeof d !== 'object' || !isVehicle(d)) { out.invalid.push(d); continue; }
    const center = getDetectionCenter(d, imageWidth, imageHeight, coordSpace);
    if (!center) { out.invalid.push(d); continue; }
    if (ignores.some((poly) => pointInPolygon(center, poly))) { out.ignored.push(d); continue; } // ignore wins
    if (queue) {
      if (pointInPolygon(center, queue)) out.insideQueueRoi.push(d);
      else out.outsideQueueRoi.push(d);
    } else {
      out.outsideQueueRoi.push(d); // no queue polygon → nothing is "in queue"
    }
  }
  return out;
}

// Build the rich sourceBreakdown.yoloCamera feature object from detections + ROI config + image
// meta. roiConfig null/empty → roiCalibrated:false + fallbackReason NO_ROI_CONFIG (still returns
// visibleVehicleCount). Never throws.
export function computeRoiCameraFeatures(detections = [], roiConfig = null, imageMeta = {}) {
  const width = Number(imageMeta.width || 0);
  const height = Number(imageMeta.height || 0);
  const coordSpace = imageMeta.coordSpace || 'auto';
  const list = Array.isArray(detections) ? detections.filter((d) => d && typeof d === 'object') : [];
  const vehicles = list.filter(isVehicle);
  const visibleVehicleCount = vehicles.length;
  const byClass = {};
  for (const d of vehicles) { const b = vehicleBucket(d); byClass[b] = (byClass[b] || 0) + 1; }
  const confs = vehicles.map(detConfidence).filter((c) => c > 0);
  const averageDetectionConfidence = confs.length ? round2(confs.reduce((a, b) => a + b, 0) / confs.length / 100) : null;

  const roiValid = roiConfig && validatePolygon(roiConfig.queuePolygon);
  if (!roiValid) {
    return {
      visibleVehicleCount,
      vehiclesInQueueRoi: null,
      vehiclesIgnored: 0,
      vehiclesOutsideRoi: null,
      vehicleCountByClass: byClass,
      averageDetectionConfidence,
      queueLengthPixels: null,
      queueLengthMeters: null,
      laneOccupancy: null,
      laneFullness: null,
      detectionsNearBooth: null,
      detectionsFarQueue: null,
      isNightOrLowLight: Boolean(imageMeta.isNightOrLowLight),
      cameraImageQualityScore: isNum(imageMeta.qualityScore) ? round2(imageMeta.qualityScore) : null,
      roiCalibrated: false,
      roiTrusted: false,
      roiVersion: null,
      fallbackReason: 'NO_ROI_CONFIG',
    };
  }

  const classified = classifyDetectionsByRoi(vehicles, roiConfig, width, height, coordSpace);
  const inQueue = classified.insideQueueRoi;
  const queueByClass = {};
  for (const d of inQueue) { const b = vehicleBucket(d); queueByClass[b] = (queueByClass[b] || 0) + 1; }
  // queue length (pixels) along the vertical extent of in-queue detections; meters if calibrated.
  let queueLengthPixels = null; let queueLengthMeters = null;
  if (inQueue.length >= 2 && height > 0) {
    const ys = inQueue.map((d) => getDetectionCenter(d, width, height, coordSpace)?.y).filter(isNum);
    if (ys.length >= 2) {
      const spanNorm = Math.max(...ys) - Math.min(...ys);
      queueLengthPixels = Math.round(spanNorm * height);
      if (isNum(roiConfig.metersPerPixel) && roiConfig.metersPerPixel > 0) queueLengthMeters = Math.round(queueLengthPixels * roiConfig.metersPerPixel);
    }
  }
  return {
    visibleVehicleCount,
    vehiclesInQueueRoi: inQueue.length,
    vehiclesIgnored: classified.ignored.length,
    vehiclesOutsideRoi: classified.outsideQueueRoi.length,
    vehicleCountByClass: queueByClass,
    averageDetectionConfidence,
    queueLengthPixels,
    queueLengthMeters,
    laneOccupancy: null,
    laneFullness: null,
    detectionsNearBooth: null,
    detectionsFarQueue: null,
    isNightOrLowLight: Boolean(imageMeta.isNightOrLowLight),
    cameraImageQualityScore: isNum(imageMeta.qualityScore) ? round2(imageMeta.qualityScore) : null,
    roiCalibrated: true,
    // TRUSTED only when the polygon is a real reviewed calibration — NOT a rect-derived guess and NOT
    // a seeded config still flagged needsEditorReview. An untrusted ROI may count 0 in a mis-mapped
    // zone, so the UI must not turn that into a confident "no queue" claim.
    roiTrusted: Boolean(roiConfig.roiVersion) && !roiConfig.derivedFromRect && !(roiConfig.metadata && roiConfig.metadata.needsEditorReview),
    roiVersion: roiConfig.roiVersion || null,
    fallbackReason: null,
  };
}

// ── MULTI-FRAME stopped-vs-moving (§4) ─────────────────────────────────────────────────────────
// Simple nearest-match tracker (NOT DeepSORT): match detections between the first and last frame by
// class + nearest normalized center; a small movement = stopped, larger = moving. Pure + safe.
const DEFAULT_MOVE_THRESHOLD = 0.015; // normalized distance

export function trackStoppedMoving(frames = [], { moveThreshold = DEFAULT_MOVE_THRESHOLD, roiConfig = null, imageMeta = {}, frameHashes = [] } = {}) {
  const out = {
    multiFrameUsed: true,
    multiFrameFrameCount: Array.isArray(frames) ? frames.length : 0,
    stoppedVehicleRatio: null,
    movingVehicleRatio: null,
    queueMovingSlowly: null,
    flowDirectionValid: null,
    matchedCount: 0,
    duplicateFrameRatio: 0,
    multiFrameEligible: true,
    multiFrameFallbackReason: null,
  };
  const hashes = Array.isArray(frameHashes) ? frameHashes.filter(Boolean) : [];
  if (hashes.length >= 2) {
    const duplicates = hashes.slice(1).filter((h) => h === hashes[0]).length;
    out.duplicateFrameRatio = round2(duplicates / Math.max(1, hashes.length - 1));
    if (out.duplicateFrameRatio >= 0.75) {
      out.multiFrameEligible = false;
      out.multiFrameFallbackReason = 'DUPLICATE_OR_CACHED_FRAMES';
      return out;
    }
  }
  const valid = (Array.isArray(frames) ? frames : []).filter((f) => Array.isArray(f));
  if (valid.length < 2) { out.multiFrameFallbackReason = 'INSUFFICIENT_FRAMES'; return out; }
  const width = Number(imageMeta.width || 0);
  const height = Number(imageMeta.height || 0);
  const coordSpace = imageMeta.coordSpace || 'auto';
  const queue = roiConfig && validatePolygon(roiConfig.queuePolygon) ? roiConfig.queuePolygon : null;

  const toPoints = (frame) => frame
    .map((d) => ({ bucket: vehicleBucket(d), c: getDetectionCenter(d, width, height, coordSpace) }))
    .filter((p) => p.c && (!queue || pointInPolygon(p.c, queue)));

  const first = toPoints(valid[0]);
  const last = toPoints(valid[valid.length - 1]);
  if (first.length === 0 || last.length === 0) { out.multiFrameFallbackReason = 'INSUFFICIENT_MATCHES'; return out; }

  const usedLast = new Set();
  let stopped = 0; let moving = 0; let matched = 0;
  const dx = []; const dy = [];
  for (const a of first) {
    let bestIdx = -1; let bestDist = Infinity;
    for (let j = 0; j < last.length; j += 1) {
      if (usedLast.has(j)) continue;
      const b = last[j];
      if (b.bucket !== a.bucket) continue;
      const dist = Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y);
      if (dist < bestDist) { bestDist = dist; bestIdx = j; }
    }
    // only accept a match within a reasonable gate (a vehicle shouldn't teleport across the frame)
    if (bestIdx >= 0 && bestDist <= 0.2) {
      usedLast.add(bestIdx);
      matched += 1;
      dx.push(last[bestIdx].c.x - a.c.x);
      dy.push(last[bestIdx].c.y - a.c.y);
      if (bestDist <= moveThreshold) stopped += 1; else moving += 1;
    }
  }
  out.matchedCount = matched;
  if (matched < 2) { out.multiFrameFallbackReason = 'INSUFFICIENT_MATCHES'; return out; }
  out.stoppedVehicleRatio = round2(stopped / matched);
  out.movingVehicleRatio = round2(moving / matched);
  out.queueMovingSlowly = out.movingVehicleRatio <= 0.4 && stopped > 0;
  // flow direction is "valid" when the moving vehicles share a consistent dominant axis of motion.
  const meanDx = dx.reduce((a, b) => a + b, 0) / dx.length;
  const meanDy = dy.reduce((a, b) => a + b, 0) / dy.length;
  out.flowDirectionValid = Math.hypot(meanDx, meanDy) >= moveThreshold * 0.6;
  return out;
}
