// YOLO ROI v2 + multi-frame — pure-logic tests.
import { describe, it, expect } from 'vitest';
import {
  normalizePoint,
  validatePolygon,
  validateRoiConfig,
  pointInPolygon,
  getDetectionCenter,
  isDetectionInPolygon,
  classifyDetectionsByRoi,
  computeRoiCameraFeatures,
  trackStoppedMoving,
} from '../../server/traffic-vision-roi.js';

// A square queue polygon covering the lower-left/centre of the frame.
const queue = [{ x: 0.1, y: 0.4 }, { x: 0.8, y: 0.4 }, { x: 0.8, y: 0.95 }, { x: 0.1, y: 0.95 }];
// An ignore polygon top-left (parking / opposite side).
const ignore = [{ x: 0.0, y: 0.0 }, { x: 0.35, y: 0.0 }, { x: 0.35, y: 0.3 }, { x: 0.0, y: 0.3 }];
const roiConfig = { queuePolygon: queue, ignorePolygons: [ignore], roiVersion: '2026-06-roi-1', cameraReliability: 0.75, nightReliability: 0.45 };

describe('ROI geometry helpers', () => {
  it('pointInPolygon: inside', () => {
    expect(pointInPolygon({ x: 0.5, y: 0.7 }, queue)).toBe(true);
  });
  it('pointInPolygon: outside', () => {
    expect(pointInPolygon({ x: 0.95, y: 0.1 }, queue)).toBe(false);
  });
  it('getDetectionCenter handles {x,y,w,h} percent coords', () => {
    const c = getDetectionCenter({ x: 40, y: 60, w: 10, h: 10 }, 0, 0, 'percent');
    expect(c.x).toBeCloseTo(0.45, 2);
    expect(c.y).toBeCloseTo(0.65, 2);
  });
  it('getDetectionCenter handles bbox pixel coords', () => {
    const c = getDetectionCenter({ bbox: [100, 200, 300, 400] }, 1000, 1000, 'pixel');
    expect(c.x).toBeCloseTo(0.2, 2);
    expect(c.y).toBeCloseTo(0.3, 2);
  });
  it('getDetectionCenter handles {xmin,ymin,xmax,ymax} normalized', () => {
    const c = getDetectionCenter({ xmin: 0.2, ymin: 0.6, xmax: 0.4, ymax: 0.8 }, 0, 0, 'normalized');
    expect(c.x).toBeCloseTo(0.3, 2);
    expect(c.y).toBeCloseTo(0.7, 2);
  });
  it('malformed detection does not crash → null center, invalid bucket', () => {
    expect(getDetectionCenter(null)).toBeNull();
    expect(getDetectionCenter({})).toBeNull();
    expect(() => classifyDetectionsByRoi([null, 'x', {}], roiConfig, 0, 0, 'percent')).not.toThrow();
  });
});

describe('validation', () => {
  it('validatePolygon: ≥3 normalized points', () => {
    expect(validatePolygon(queue)).toBe(true);
    expect(validatePolygon([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }])).toBe(false); // <3
    expect(validatePolygon([{ x: 1.5, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }])).toBe(false); // out of range
  });
  it('validateRoiConfig: rejects invalid polygon + out-of-range reliability', () => {
    expect(validateRoiConfig(roiConfig).valid).toBe(true);
    expect(validateRoiConfig({ queuePolygon: [{ x: 0.1, y: 0.1 }] }).valid).toBe(false);
    expect(validateRoiConfig({ cameraReliability: 2 }).valid).toBe(false);
  });
  it('normalizePoint converts percent/pixel to 0..1', () => {
    expect(normalizePoint({ x: 50, y: 50 }, 0, 0, 'percent')).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizePoint({ x: 640, y: 360 }, 1280, 720, 'pixel')).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe('classifyDetectionsByRoi', () => {
  const inQ = { type: 'car', x: 50, y: 70, w: 6, h: 6 };       // center ~ (0.53,0.73) → in queue
  const inIgnore = { type: 'car', x: 10, y: 5, w: 6, h: 6 };   // center ~ (0.13,0.08) → in ignore
  const outside = { type: 'car', x: 90, y: 10, w: 6, h: 6 };   // center ~ (0.93,0.13) → outside

  it('vehicle inside queue polygon counts as in-queue', () => {
    const r = classifyDetectionsByRoi([inQ], roiConfig, 0, 0, 'percent');
    expect(r.insideQueueRoi.length).toBe(1);
  });
  it('vehicle inside ignore polygon is ignored', () => {
    const r = classifyDetectionsByRoi([inIgnore], roiConfig, 0, 0, 'percent');
    expect(r.ignored.length).toBe(1);
    expect(r.insideQueueRoi.length).toBe(0);
  });
  it('ignore polygon WINS over queue polygon (vehicle in both → ignored)', () => {
    // queue covers y 0.4..0.95; ignore covers y 0..0.3 → make an overlap polygon that contains the point in both
    const overlapIgnore = [{ x: 0.1, y: 0.4 }, { x: 0.8, y: 0.4 }, { x: 0.8, y: 0.95 }, { x: 0.1, y: 0.95 }];
    const cfg = { queuePolygon: queue, ignorePolygons: [overlapIgnore] };
    const r = classifyDetectionsByRoi([inQ], cfg, 0, 0, 'percent');
    expect(r.ignored.length).toBe(1);
    expect(r.insideQueueRoi.length).toBe(0);
  });
  it('vehicle outside queue polygon does not count as queue', () => {
    const r = classifyDetectionsByRoi([outside], roiConfig, 0, 0, 'percent');
    expect(r.insideQueueRoi.length).toBe(0);
    expect(r.outsideQueueRoi.length).toBe(1);
  });
});

describe('computeRoiCameraFeatures', () => {
  const dets = [
    { type: 'car', x: 50, y: 70, w: 6, h: 6 },   // in queue
    { type: 'truck', x: 40, y: 80, w: 8, h: 8 },  // in queue
    { type: 'car', x: 10, y: 5, w: 6, h: 6 },     // ignored (parking)
    { type: 'car', x: 92, y: 12, w: 6, h: 6 },    // outside
  ];
  it('ROI calibrated: counts only queue vehicles, ignores parking, marks roiCalibrated', () => {
    const f = computeRoiCameraFeatures(dets, roiConfig, { width: 1280, height: 720, coordSpace: 'percent' });
    expect(f.roiCalibrated).toBe(true);
    expect(f.roiVersion).toBe('2026-06-roi-1');
    expect(f.visibleVehicleCount).toBe(4);
    expect(f.vehiclesInQueueRoi).toBe(2);
    expect(f.vehiclesIgnored).toBe(1);
    expect(f.vehiclesOutsideRoi).toBe(1);
    expect(f.fallbackReason).toBeNull();
  });
  it('no ROI config → roiCalibrated false + NO_ROI_CONFIG, still reports visible count', () => {
    const f = computeRoiCameraFeatures(dets, null, { width: 1280, height: 720, coordSpace: 'percent' });
    expect(f.roiCalibrated).toBe(false);
    expect(f.fallbackReason).toBe('NO_ROI_CONFIG');
    expect(f.visibleVehicleCount).toBe(4);
    expect(f.vehiclesInQueueRoi).toBeNull();
  });
});

describe('multi-frame trackStoppedMoving', () => {
  const frame = (offset = 0) => [
    { type: 'car', x: 40 + offset, y: 70, w: 5, h: 5 },
    { type: 'car', x: 45 + offset, y: 78, w: 5, h: 5 },
    { type: 'truck', x: 50 + offset, y: 85, w: 6, h: 6 },
  ];
  const meta = { width: 1280, height: 720, coordSpace: 'percent' };

  it('stopped vehicles → high stoppedVehicleRatio', () => {
    const r = trackStoppedMoving([frame(0), frame(0.3)], { roiConfig, imageMeta: meta });
    expect(r.multiFrameUsed).toBe(true);
    expect(r.stoppedVehicleRatio).toBeGreaterThanOrEqual(0.9);
    expect(r.queueMovingSlowly).toBe(true);
  });
  it('moving vehicles → high movingVehicleRatio', () => {
    const r = trackStoppedMoving([frame(0), frame(8)], { roiConfig, imageMeta: meta }); // +8% per frame = moving
    expect(r.movingVehicleRatio).toBeGreaterThanOrEqual(0.9);
    expect(r.queueMovingSlowly).toBe(false);
  });
  it('insufficient frames → fallback reason', () => {
    expect(trackStoppedMoving([frame(0)]).multiFrameFallbackReason).toBe('INSUFFICIENT_FRAMES');
  });
  it('no matches (empty frames) → INSUFFICIENT_MATCHES', () => {
    expect(trackStoppedMoving([[], []], { roiConfig, imageMeta: meta }).multiFrameFallbackReason).toBe('INSUFFICIENT_MATCHES');
  });
  it('ROI filters detections before tracking (vehicles outside queue ignored)', () => {
    const f1 = [{ type: 'car', x: 92, y: 12, w: 5, h: 5 }, ...frame(0)]; // first det is outside queue
    const f2 = [{ type: 'car', x: 92, y: 12, w: 5, h: 5 }, ...frame(0.2)];
    const r = trackStoppedMoving([f1, f2], { roiConfig, imageMeta: meta });
    expect(r.matchedCount).toBe(3); // only the 3 in-queue vehicles tracked, not the outside one
  });
});
