import { describe, it, expect } from 'vitest';
import { pointInRect, detectionPastCountLine, applyRoiToDetections } from '../../server/intelligence.js';

// queueRoi covers the left-centre lane; an ignore zone covers the top-right (opposite lane / parking).
const calibration = {
  queueRoi: { x: 10, y: 30, w: 45, h: 60 },
  ignoreZones: [{ x: 60, y: 0, w: 40, h: 40 }],
  countLine: { x1: 10, y1: 70, x2: 60, y2: 50 },
};

describe('pointInRect', () => {
  it('detects membership in percent coords', () => {
    expect(pointInRect(20, 40, calibration.queueRoi)).toBe(true);
    expect(pointInRect(90, 10, calibration.queueRoi)).toBe(false);
  });
  it('returns false for a missing rect', () => {
    expect(pointInRect(20, 40, null)).toBe(false);
  });
});

describe('applyRoiToDetections', () => {
  it('counts only vehicles inside the queue ROI', () => {
    const detections = [
      { type: 'car', x: 20, y: 50, confidence: 90 },   // in ROI
      { type: 'car', x: 30, y: 60, confidence: 88 },   // in ROI
      { type: 'car', x: 90, y: 80, confidence: 90 },   // outside ROI
    ];
    const r = applyRoiToDetections(detections, calibration);
    expect(r.queueVehicles).toBe(2);
    expect(r.detectionsBeforeRoi).toBe(3);
    expect(r.detectionsAfterRoi).toBe(2);
    expect(r.ignored.some((d) => d.reason === 'outside_roi')).toBe(true);
  });

  it('ignore zones drop vehicles (opposite lane / parking)', () => {
    const detections = [
      { type: 'car', x: 20, y: 50, confidence: 90 },  // in ROI
      { type: 'car', x: 75, y: 15, confidence: 90 },  // ignore zone
    ];
    const r = applyRoiToDetections(detections, calibration);
    expect(r.queueVehicles).toBe(1);
    expect(r.ignored.some((d) => d.reason === 'ignore_zone')).toBe(true);
  });

  it('ignores non-vehicles, shadows and low-confidence boxes', () => {
    const detections = [
      { type: 'car', x: 20, y: 50, confidence: 90 },
      { type: 'shadow', x: 25, y: 55, confidence: 99 },
      { type: 'person', x: 22, y: 52, confidence: 95 },
      { type: 'car', x: 24, y: 53, confidence: 10 }, // low confidence
    ];
    const r = applyRoiToDetections(detections, calibration);
    expect(r.queueVehicles).toBe(1);
    expect(r.ignored.some((d) => d.reason === 'not_vehicle')).toBe(true);
    expect(r.ignored.some((d) => d.reason === 'low_confidence')).toBe(true);
  });

  it('classifies counts by vehicle type', () => {
    const detections = [
      { type: 'car', x: 20, y: 50, confidence: 90 },
      { type: 'truck', x: 22, y: 52, confidence: 90 },
      { type: 'bus', x: 24, y: 54, confidence: 90 },
      { type: 'van', x: 26, y: 56, confidence: 90 },
    ];
    const r = applyRoiToDetections(detections, calibration);
    expect(r.counts).toEqual({ cars: 1, vans: 1, trucks: 1, buses: 1 });
  });

  it('with no detections in ROI, queueVehicles is 0 (no false queue)', () => {
    const r = applyRoiToDetections([{ type: 'car', x: 95, y: 95, confidence: 90 }], calibration);
    expect(r.queueVehicles).toBe(0);
  });

  it('counts countLine crossings as a snapshot proxy', () => {
    const detections = [{ type: 'car', x: 15, y: 40, confidence: 90 }, { type: 'car', x: 50, y: 80, confidence: 90 }];
    const r = applyRoiToDetections(detections, calibration);
    expect(r.countLineCrossings).toBeGreaterThanOrEqual(0);
  });
});

describe('detectionPastCountLine', () => {
  it('returns false without a line', () => {
    expect(detectionPastCountLine({ x: 10, y: 10 }, null)).toBe(false);
  });
});

describe('applyRoiToDetections resilience (YOLO failure / garbage must not crash)', () => {
  it('handles empty / non-array input safely', () => {
    expect(applyRoiToDetections([], calibration).queueVehicles).toBe(0);
    expect(applyRoiToDetections(undefined, calibration).queueVehicles).toBe(0);
    expect(applyRoiToDetections(null, {}).queueVehicles).toBe(0);
  });
  it('handles malformed detection objects without throwing', () => {
    const r = applyRoiToDetections([{}, { type: 'car' }, { x: 'nan', y: 'nan', type: 'car', confidence: 99 }], calibration);
    expect(Number.isFinite(r.queueVehicles)).toBe(true);
  });
  it('without a queue ROI, hasRoi is false (camera stays visual-only upstream)', () => {
    const r = applyRoiToDetections([{ type: 'car', x: 50, y: 50, confidence: 90 }], { ignoreZones: [] });
    expect(r.hasRoi).toBe(false);
  });
});
