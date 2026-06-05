// Verified-ROI ACCURACY: with a REAL committed ROI polygon (STATIC_ROI_CONFIGS) and known YOLO
// detections, the queue count must be EXACT (parking/opposite/off-lane excluded) and the resulting
// camera wait must match queue ÷ service-rate. This is the "da točnost bude točna" guarantee for the
// ROI → count → wait chain (independent of whether a live YOLO model is attached).
import { describe, it, expect } from 'vitest';
import { computeRoiCameraFeatures } from '../../server/traffic-vision-roi.js';
import { estimateCameraWaitV2 } from '../../server/traffic-vision.js';
import { STATIC_ROI_CONFIGS } from '../../server/camera-roi-config.js';

const cfg = STATIC_ROI_CONFIGS['mal-hak-hr-exit'];
// Detection whose CENTER sits at (cx, cy) in PERCENT coords (center = x + w/2).
const det = (cx, cy, type = 'car') => ({ type, x: cx - 2, y: cy - 2, w: 4, h: 4, confidence: 85 });
const meta = { width: 1280, height: 720, coordSpace: 'percent' };

describe('committed Maljevac exit ROI counts only the real queue', () => {
  it('has a committed polygon to test against', () => {
    expect(cfg).toBeTruthy();
    expect(cfg.queuePolygon.length).toBeGreaterThanOrEqual(3);
  });

  it('counts exactly the in-queue vehicles, excludes ignore-zone + off-ROI', () => {
    const detections = [
      // 8 vehicles inside the queue lane
      det(50, 50), det(45, 60), det(50, 70), det(55, 80), det(48, 85), det(52, 90), det(46, 55), det(54, 65),
      // 2 vehicles parked in the top-right ignore zone
      det(90, 30), det(85, 25),
      // 1 vehicle clearly outside any ROI
      det(95, 5),
    ];
    const f = computeRoiCameraFeatures(detections, cfg, meta);
    expect(f.roiCalibrated).toBe(true);
    expect(f.visibleVehicleCount).toBe(11);
    expect(f.vehiclesInQueueRoi).toBe(8);     // EXACT — not 11
    expect(f.vehiclesIgnored).toBe(2);
    expect(f.vehiclesOutsideRoi).toBe(1);
  });

  it('the wait equals queue ÷ service-rate (+booth), driven by the ROI count not the raw count', () => {
    const f = computeRoiCameraFeatures([det(50, 50), det(45, 60), det(50, 70), det(55, 80), det(48, 85), det(52, 90), det(46, 55), det(54, 65), det(90, 30), det(85, 25), det(95, 5)], cfg, meta);
    const cam = estimateCameraWaitV2(
      { vehiclesInQueueRoi: f.vehiclesInQueueRoi, roiCalibrated: true, averageDetectionConfidence: 85, visibleVehicleCount: f.visibleVehicleCount },
      { serviceRate: 1.5 }
    );
    expect(cam.estimatedQueueVehicles).toBe(8);            // uses the 8 in-queue, NOT 11 visible
    expect(cam.estimatedCameraWaitMin).toBe(Math.round(8 / 1.5 + 2)); // 7 min, exact
    expect(cam.cameraConfidence).toBeGreaterThanOrEqual(0.7);
  });

  it('an empty queue lane → 0 vehicles → 0 min, even if cars are parked in the ignore zone', () => {
    const f = computeRoiCameraFeatures([det(90, 30), det(85, 25), det(95, 5)], cfg, meta);
    expect(f.vehiclesInQueueRoi).toBe(0);
    const cam = estimateCameraWaitV2({ vehiclesInQueueRoi: 0, roiCalibrated: true }, { serviceRate: 1.5 });
    expect(cam.estimatedCameraWaitMin).toBe(0);
  });
});
