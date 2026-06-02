import { describe, it, expect } from 'vitest';
import {
  estimateWaitFromCameraSignals,
  cameraYoloEligibility,
  detectCameraClearConflict,
} from '../../server/intelligence.js';

describe('estimateWaitFromCameraSignals (V6 §8)', () => {
  const roiDir = { hasRoi: true, hasDirection: true, hasCountLine: true };

  it('returns no wait without ROI or direction', () => {
    expect(estimateWaitFromCameraSignals({ queueVehicles: 20, hasRoi: false, hasDirection: true }).waitMinutes).toBeNull();
    expect(estimateWaitFromCameraSignals({ queueVehicles: 20, hasRoi: true, hasDirection: false }).waitMinutes).toBeNull();
  });

  it('high queue + low flow → higher wait than high queue + high flow', () => {
    const lowFlow = estimateWaitFromCameraSignals({ queueVehicles: 30, flowVehiclesPerMinute: 0.5, ...roiDir });
    const highFlow = estimateWaitFromCameraSignals({ queueVehicles: 30, flowVehiclesPerMinute: 6, ...roiDir });
    expect(lowFlow.waitMinutes).toBeGreaterThan(highFlow.waitMinutes);
  });

  it('low queue + high flow → low wait', () => {
    const r = estimateWaitFromCameraSignals({ queueVehicles: 3, flowVehiclesPerMinute: 6, ...roiDir });
    expect(r.waitMinutes).toBeLessThanOrEqual(5);
  });

  it('no flow → wide range, not a precise single number, with a reason code', () => {
    const r = estimateWaitFromCameraSignals({ queueVehicles: 20, flowVehiclesPerMinute: null, ...roiDir });
    expect(r.precise).toBe(false);
    expect(r.reasonCodes).toContain('insufficient_frames_for_flow');
    expect(r.waitRange.max - r.waitRange.min).toBeGreaterThan(0);
  });

  it('uncalibrated → low confidence; calibrated + flow + countLine → precise', () => {
    const uncal = estimateWaitFromCameraSignals({ queueVehicles: 20, flowVehiclesPerMinute: 4, ...roiDir });
    expect(uncal.confidence).toBe('low');
    expect(uncal.reasonCodes).toContain('uncalibrated');
    const cal = estimateWaitFromCameraSignals({ queueVehicles: 20, flowVehiclesPerMinute: 4, ...roiDir, calibrationProfile: { enoughMeasuredVolume: true } });
    expect(cal.precise).toBe(true);
  });

  it('stopped queue (flow 0) is flagged and not trivially low', () => {
    const r = estimateWaitFromCameraSignals({ queueVehicles: 15, flowVehiclesPerMinute: 0, ...roiDir });
    expect(r.reasonCodes).toContain('stopped_queue');
    expect(r.waitMinutes).toBeGreaterThan(0);
  });
});

describe('cameraYoloEligibility (V6 §11)', () => {
  const camFull = { cameraId: 'c1', validForDirections: ['toBih'], calibration: { roi: {}, countLine: {} } };

  it('a camera without ROI is not eligible (shadow or fusion)', () => {
    const e = cameraYoloEligibility({ cameraId: 'x', validForDirections: ['toBih'] }, 'toBih', {}, { fusionAllowlist: ['x'] });
    expect(e.eligibleForShadow).toBe(false);
    expect(e.eligibleForFusion).toBe(false);
    expect(e.reasonCodes).toContain('missing_queue_roi');
  });

  it('a camera not valid for the requested direction is not eligible for that direction', () => {
    const e = cameraYoloEligibility(camFull, 'toHr', {}, { fusionAllowlist: ['c1'] });
    expect(e.validForDir).toBe(false);
    expect(e.eligibleForFusion).toBe(false);
  });

  it('without a countLine a camera can shadow but NOT fuse', () => {
    const cam = { cameraId: 'c2', validForDirections: ['toBih'], calibration: { roi: {} } };
    const e = cameraYoloEligibility(cam, 'toBih', {}, { fusionAllowlist: ['c2'] });
    expect(e.eligibleForShadow).toBe(true);
    expect(e.eligibleForFusion).toBe(false);
    expect(e.reasonCodes).toContain('missing_count_line');
  });

  it('not on the fusion allowlist → not fusion eligible even if otherwise perfect', () => {
    const e = cameraYoloEligibility(camFull, 'toBih', {}, { fusionAllowlist: [] });
    expect(e.eligibleForFusion).toBe(false);
  });

  it('allowlisted + ROI + direction + countLine + fresh + no error → fusion eligible', () => {
    const e = cameraYoloEligibility(camFull, 'toBih', { hasFreshFrame: true, latencyMs: 1000, confidence: 80 }, { fusionAllowlist: ['c1'], maxLatencyMs: 8000, minConfidence: 35 });
    expect(e.eligibleForFusion).toBe(true);
  });

  it('a stale frame or runtime error blocks fusion', () => {
    expect(cameraYoloEligibility(camFull, 'toBih', { hasFreshFrame: false }, { fusionAllowlist: ['c1'] }).eligibleForFusion).toBe(false);
    expect(cameraYoloEligibility(camFull, 'toBih', { error: 'boom' }, { fusionAllowlist: ['c1'] }).eligibleForFusion).toBe(false);
    expect(cameraYoloEligibility(camFull, 'toBih', { latencyMs: 99999 }, { fusionAllowlist: ['c1'], maxLatencyMs: 8000 }).eligibleForFusion).toBe(false);
  });
});

describe('detectCameraClearConflict (Šamac inverse conflict)', () => {
  it('flags when camera shows little/no queue but the wait is very high', () => {
    expect(detectCameraClearConflict({ visualBand: 'mala', fusedWait: 360 }).conflict).toBe(true);
    expect(detectCameraClearConflict({ visualBand: 'nema', fusedWait: 120 }).conflict).toBe(true);
  });
  it('no conflict when the wait is moderate', () => {
    expect(detectCameraClearConflict({ visualBand: 'mala', fusedWait: 20 }).conflict).toBe(false);
  });
  it('no conflict when the camera itself shows a big queue', () => {
    expect(detectCameraClearConflict({ visualBand: 'velika', fusedWait: 360 }).conflict).toBe(false);
  });
  it('no conflict without a numeric wait or unknown band', () => {
    expect(detectCameraClearConflict({ visualBand: 'mala', fusedWait: null }).conflict).toBe(false);
    expect(detectCameraClearConflict({ visualBand: null, fusedWait: 360 }).conflict).toBe(false);
  });
});
