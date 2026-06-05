// Traffic + Vision prediction layer v2 — pure-logic tests (the differentiator's brain).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  computeGoogleTrafficV2,
  aggregateGoogleSamples,
  estimateCameraWaitV2,
  serviceRateFor,
  fuseTrafficVision,
  TRAFFIC_VISION_MODEL_VERSION,
} from '../../server/traffic-vision.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const server = readFileSync(join(root, 'server', 'index.js'), 'utf8');
const app = readFileSync(join(root, 'src', 'App.jsx'), 'utf8');

// A short path that straddles a border point (lat increasing), border in the middle.
const border = { lat: 45.10, lng: 16.00 };
function pathAcrossBorder() {
  const pts = [];
  for (let i = 0; i <= 20; i += 1) pts.push({ lat: 45.09 + i * 0.001, lng: 16.0 }); // ~2.2km, border ~middle
  return pts;
}
function pathOneSide() {
  const pts = [];
  for (let i = 0; i <= 20; i += 1) pts.push({ lat: 45.11 + i * 0.001, lng: 16.0 }); // entirely past the border
  return pts;
}

describe('computeGoogleTrafficV2 — border-segment delay', () => {
  it('delay is current − baseline on the border segment, and the route crosses the border', () => {
    const g = computeGoogleTrafficV2({ path: pathAcrossBorder(), durationMinutes: 8, staticMinutes: 3, distanceKm: 2.2, trafficSummary: { worstTrafficLevel: 'SLOW', jamMeters: 200 } }, { borderPoint: border });
    expect(g.delayMin).toBe(5);
    expect(g.delayRatio).toBeCloseTo(2.67, 1);
    expect(g.routeCrossesBorder).toBe(true);
    expect(g.distanceBeforeBorderKm).toBeGreaterThan(0.1);
    expect(g.distanceAfterBorderKm).toBeGreaterThan(0.1);
    expect(g.confidence).toBeGreaterThanOrEqual(0.7);
    expect(g.fallbackReason).toBeNull();
  });

  it('a route that does NOT cross the border gets low confidence + a fallbackReason', () => {
    const g = computeGoogleTrafficV2({ path: pathOneSide(), durationMinutes: 8, staticMinutes: 3, distanceKm: 2.2, trafficSummary: {} }, { borderPoint: border });
    expect(g.routeCrossesBorder).toBe(false);
    expect(g.confidence).toBeLessThanOrEqual(0.4);
    expect(g.fallbackReason).toBeTruthy();
  });

  it('missing duration → fallbackReason, no crash', () => {
    const g = computeGoogleTrafficV2({ path: pathAcrossBorder() }, { borderPoint: border });
    expect(g.delayMin).toBeNull();
    expect(g.fallbackReason).toBe('no-duration');
  });
});

describe('aggregateGoogleSamples — multi-sampling, outliers cannot dominate', () => {
  const crossing = (delayMin, extra = {}) => ({ delayMin, delayRatio: 1.5, routeCrossesBorder: true, confidence: 0.8, worstTrafficLevel: 'SLOW', ...extra });
  it('takes the median delay of border-crossing samples (one outlier does not dominate)', () => {
    const agg = aggregateGoogleSamples([crossing(5), crossing(6), crossing(40)]);
    expect(agg.delayMin).toBe(6); // median, not the 40 outlier
    expect(agg.routeCrossesBorder).toBe(true);
    expect(agg.confidence).toBeGreaterThan(0.6);
  });
  it('when NO sample crosses the border, confidence is low + fallbackReason', () => {
    const agg = aggregateGoogleSamples([{ delayMin: 9, routeCrossesBorder: false, fallbackReason: 'border-at-segment-edge' }]);
    expect(agg.fallbackReason).toBe('no-sample-crossed-border');
    expect(agg.confidence).toBeLessThan(0.6);
  });
  it('no samples → safe empty result', () => {
    expect(aggregateGoogleSamples([]).fallbackReason).toBe('no-samples');
  });
});

describe('serviceRateFor + estimateCameraWaitV2 — queue → wait', () => {
  const noon = new Date('2026-06-04T12:00:00');
  it('12 vehicles at ~1.5/min ≈ 8 min', () => {
    const rate = serviceRateFor('maljevac', 'toBih', { date: noon });
    const cam = estimateCameraWaitV2({ vehiclesInQueueRoi: 12, roiCalibrated: true, averageDetectionConfidence: 80 }, { crossingId: 'maljevac', direction: 'toBih', serviceRate: 1.5 });
    expect(cam.estimatedQueueVehicles).toBe(12);
    expect(cam.estimatedCameraWaitMin).toBeGreaterThanOrEqual(8);
    expect(cam.estimatedCameraWaitMin).toBeLessThanOrEqual(12);
    expect(cam.cameraConfidence).toBeGreaterThanOrEqual(0.7);
    expect(rate).toBeGreaterThan(0);
  });
  it('a high truck ratio lowers the service rate (slower clearance → longer wait)', () => {
    const carRate = serviceRateFor('maljevac', 'toBih', { date: noon, truckRatio: 0 });
    const truckRate = serviceRateFor('maljevac', 'toBih', { date: noon, truckRatio: 0.8 });
    expect(truckRate).toBeLessThan(carRate);
  });
  it('no ROI → lower confidence', () => {
    const withRoi = estimateCameraWaitV2({ vehiclesInQueueRoi: 8, roiCalibrated: true, averageDetectionConfidence: 80 }, { serviceRate: 1.5 });
    const noRoi = estimateCameraWaitV2({ queueVehicles: 8, roiCalibrated: false, averageDetectionConfidence: 80 }, { serviceRate: 1.5 });
    expect(noRoi.cameraConfidence).toBeLessThan(withRoi.cameraConfidence);
  });
  it('0 vehicles → 0 min', () => {
    expect(estimateCameraWaitV2({ vehiclesInQueueRoi: 0, roiCalibrated: true }, { serviceRate: 1.5 }).estimatedCameraWaitMin).toBe(0);
  });
  it('no count → fallbackReason', () => {
    expect(estimateCameraWaitV2({}, { serviceRate: 1.5 }).fallbackReason).toBe('no-queue-count');
  });
});

describe('estimateCameraWaitV2 — multi-frame stopped-vs-moving modifier', () => {
  const base = { vehiclesInQueueRoi: 10, roiCalibrated: true, averageDetectionConfidence: 80 };
  it('a standing queue (most stopped) raises confidence and keeps the queue-based wait', () => {
    const noMf = estimateCameraWaitV2(base, { serviceRate: 1.5 });
    const stopped = estimateCameraWaitV2({ ...base, multiFrame: { multiFrameUsed: true, stoppedVehicleRatio: 0.9, movingVehicleRatio: 0.1, queueMovingSlowly: true } }, { serviceRate: 1.5 });
    expect(stopped.cameraConfidence).toBeGreaterThan(noMf.cameraConfidence);
    expect(stopped.estimatedCameraWaitMin).toBe(noMf.estimatedCameraWaitMin);
    expect(stopped.multiFrameUsed).toBe(true);
  });
  it('a clearly moving queue shaves the wait estimate', () => {
    const noMf = estimateCameraWaitV2(base, { serviceRate: 1.5 });
    const moving = estimateCameraWaitV2({ ...base, multiFrame: { multiFrameUsed: true, stoppedVehicleRatio: 0.1, movingVehicleRatio: 0.9, queueMovingSlowly: false } }, { serviceRate: 1.5 });
    expect(moving.estimatedCameraWaitMin).toBeLessThan(noMf.estimatedCameraWaitMin);
    expect(moving.multiFrameDraining).toBe(true);
  });
  it('an unused / fallback multi-frame result does not change the estimate', () => {
    const noMf = estimateCameraWaitV2(base, { serviceRate: 1.5 });
    const fb = estimateCameraWaitV2({ ...base, multiFrame: { multiFrameUsed: false, multiFrameFallbackReason: 'INSUFFICIENT_MATCHES' } }, { serviceRate: 1.5 });
    expect(fb.estimatedCameraWaitMin).toBe(noMf.estimatedCameraWaitMin);
    expect(fb.cameraConfidence).toBe(noMf.cameraConfidence);
  });
});

describe('fuseTrafficVision — ROI-calibration confidence + no-ROI safety', () => {
  const g = (delayMin) => ({ delayMin, delayRatio: 1 + delayMin / 5, routeCrossesBorder: true, confidence: 0.8, worstTrafficLevel: delayMin >= 5 ? 'SLOW' : 'NORMAL' });
  it('a no-ROI camera alone cannot create an extreme committed wait', () => {
    const noRoiCam = estimateCameraWaitV2({ queueVehicles: 40, roiCalibrated: false, averageDetectionConfidence: 80 }, { serviceRate: 1.5 });
    const r = fuseTrafficVision({ camera: noRoiCam });
    // no Google corroboration + no ROI → must not commit a confident extreme number
    expect(r.confidenceLabel).not.toBe('high');
    expect(r.expectedWaitMin).toBeLessThanOrEqual(noRoiCam.estimatedCameraWaitMin + 1);
  });
  it('a ROI-calibrated camera yields higher fusion confidence than a no-ROI one at the same queue', () => {
    const roiCam = estimateCameraWaitV2({ vehiclesInQueueRoi: 12, roiCalibrated: true, averageDetectionConfidence: 80 }, { serviceRate: 1.5 });
    const noRoiCam = estimateCameraWaitV2({ queueVehicles: 12, roiCalibrated: false, averageDetectionConfidence: 80 }, { serviceRate: 1.5 });
    const rRoi = fuseTrafficVision({ camera: roiCam, google: g(10) });
    const rNo = fuseTrafficVision({ camera: noRoiCam, google: g(10) });
    expect(rRoi.confidenceScore).toBeGreaterThanOrEqual(rNo.confidenceScore);
  });
  it('the moving-queue phrase surfaces in the camera explanation', () => {
    const movingCam = estimateCameraWaitV2({ vehiclesInQueueRoi: 12, roiCalibrated: true, averageDetectionConfidence: 80, multiFrame: { multiFrameUsed: true, movingVehicleRatio: 0.9, stoppedVehicleRatio: 0.1, queueMovingSlowly: false } }, { serviceRate: 1.5 });
    const r = fuseTrafficVision({ camera: movingCam });
    expect(r.explanation).toMatch(/pomiče/);
  });
});

describe('fuseTrafficVision — scenario matrix', () => {
  const g = (delayMin, over = {}) => ({ delayMin, delayRatio: 1 + delayMin / 5, routeCrossesBorder: true, confidence: 0.8, worstTrafficLevel: delayMin >= 5 ? 'SLOW' : 'NORMAL', ...over });
  const c = (waitMin, queue, over = {}) => ({ estimatedCameraWaitMin: waitMin, estimatedQueueVehicles: queue, cameraConfidence: 0.7, cameraWaitRangeMin: Math.max(0, waitMin - 4), cameraWaitRangeMax: waitMin + 5, roiCalibrated: true, ...over });

  it('verified location fresh OVERRIDES everything (ground truth)', () => {
    const r = fuseTrafficVision({ verified: { waitMin: 17, ageMin: 5 }, google: g(2), camera: c(3, 2), publicSig: { waitMin: 40 } });
    expect(r.expectedWaitMin).toBe(17);
    expect(r.lead).toBe('verified');
    expect(r.confidenceLabel).toBe('high');
  });

  it('camera + Google agree LOW → low wait, high confidence', () => {
    const r = fuseTrafficVision({ google: g(1), camera: c(3, 2) });
    expect(r.expectedWaitMin).toBeLessThanOrEqual(6);
    expect(r.confidenceLabel).toBe('high');
    expect(r.lead).toBe('camera+google');
  });

  it('camera + Google agree HIGH → high wait, high confidence', () => {
    const r = fuseTrafficVision({ google: g(12), camera: c(18, 14) });
    expect(r.expectedWaitMin).toBeGreaterThanOrEqual(13);
    expect(r.confidenceLabel).toBe('high');
  });

  it('camera HIGH + Google LOW → medium confidence + conflict explanation', () => {
    const r = fuseTrafficVision({ google: g(1), camera: c(22, 16) });
    expect(r.confidenceLabel).toBe('medium');
    expect(r.lead).toBe('camera+google-conflict');
    expect(r.rangeMax - r.rangeMin).toBeGreaterThan(8);
  });

  it('public HIGH alone (no camera/google) does NOT hold an extreme wait', () => {
    const r = fuseTrafficVision({ publicSig: { waitMin: 60, soft: true } });
    expect(r.expectedWaitMin).toBeLessThanOrEqual(18);
    expect(r.lead).toBe('public');
    expect(r.confidenceLabel).toBe('low');
  });

  it('Google low + (no camera) fresh → leads with google delay', () => {
    const r = fuseTrafficVision({ google: g(6) });
    expect(r.lead).toBe('google');
    expect(r.expectedWaitMin).toBeGreaterThanOrEqual(6);
  });

  it('chat consensus (≥2 fresh) leads when no camera/google', () => {
    const r = fuseTrafficVision({ chat: { waitMin: 25, count: 3, ageMin: 10 } });
    expect(r.lead).toBe('chat');
    expect(r.expectedWaitMin).toBe(25);
  });

  it('nothing usable → baseline, low confidence, model version tagged', () => {
    const r = fuseTrafficVision({ baselineWaitMin: 11 });
    expect(r.lead).toBe('baseline');
    expect(r.modelVersion).toBe(TRAFFIC_VISION_MODEL_VERSION);
    expect(r.sourceBreakdown).toBeTruthy();
  });
});

describe('v2 wiring (server + UI) is in place and safe', () => {
  it('feature flags exist and PREDICTION_V2 is shadow (off) by default', () => {
    expect(server).toMatch(/PREDICTION_V2_ENABLED = process\.env\.PREDICTION_V2_ENABLED === 'true'/);
    expect(server).toMatch(/GOOGLE_TRAFFIC_V2_ENABLED/);
    expect(server).toMatch(/YOLO_ROI_V2_ENABLED/);
    expect(server).toMatch(/CAMERA_YOLO_MULTI_FRAME_ENABLED/);
  });
  it('the fusion is wrapped in try/catch with a legacy fallback (never crashes the estimate)', () => {
    expect(server).toMatch(/predictionV2 = fuseTrafficVision\(/);
    expect(server).toMatch(/predictionV2 = \{ error:/);
    expect(server).toMatch(/if \(PREDICTION_V2_ENABLED && predictionV2 && !predictionV2\.error/);
  });
  it('Google v2 is computed per route + aggregated (multi-sampling) on the snapshot', () => {
    expect(server).toMatch(/computeGoogleTrafficV2\(r, anchor\)/);
    expect(server).toMatch(/aggregateGoogleSamples\(samples\)/);
    expect(server).toMatch(/googleTrafficV2/);
  });
  it('signal + public-state projection expose predictionV2 + modelVersion', () => {
    expect(server).toMatch(/modelVersion: TRAFFIC_VISION_MODEL_VERSION/);
    expect(server).toMatch(/predictionV2: signal\.predictionV2/);
  });
  it('admin debug + accuracy endpoints exist', () => {
    expect(server).toMatch(/\/api\/admin\/traffic-vision\/:crossingId\/:direction/);
    expect(server).toMatch(/\/api\/admin\/traffic-vision-accuracy/);
  });
  it('UI renders the source breakdown (AI camera + Google + public)', () => {
    expect(app).toMatch(/function PredictionBreakdown/);
    expect(app).toMatch(/AI kamera:/);
    expect(app).toMatch(/Google promet:/);
    expect(app).toMatch(/<PredictionBreakdown sourceMeta=/);
  });
  it('UI shows ROI-calibration + multi-frame wording (real queue / stopped / moving)', () => {
    expect(app).toMatch(/u stvarnoj koloni/);
    expect(app).toMatch(/većina stoji/);
    expect(app).toMatch(/kolona se pomiče/);
  });
});

describe('ROI v2 editor + feature wiring is present and flag/token gated', () => {
  it('internal ROI editor endpoints exist (audit/debug/test/config)', () => {
    expect(server).toMatch(/\/api\/internal\/traffic-vision\/roi-audit/);
    expect(server).toMatch(/\/api\/internal\/traffic-vision\/roi-debug\/:cameraId/);
    expect(server).toMatch(/\/api\/internal\/traffic-vision\/roi-test\/:cameraId/);
    expect(server).toMatch(/\/api\/internal\/traffic-vision\/roi-config\/:cameraId/);
    expect(server).toMatch(/\/internal\/roi-editor/);
  });
  it('the editor guard returns 404 when the flag is off and requires admin OR debug token', () => {
    expect(server).toMatch(/function roiEditorGuard/);
    expect(server).toMatch(/if \(!YOLO_ROI_EDITOR_ENABLED\) return res\.status\(404\)/);
    expect(server).toMatch(/timingSafeEqualStr\(provided, TRAFFIC_VISION_DEBUG_TOKEN\)/);
  });
  it('ROI features + multi-frame are wired into the camera source snapshot metadata + fusion', () => {
    expect(server).toMatch(/roiFeatures: analytics\.roiFeatures/);
    expect(server).toMatch(/multiFrame: analytics\.multiFrame/);
    expect(server).toMatch(/const roiFeatures = cameraSignal\?\.metadata\?\.roiFeatures/);
    expect(server).toMatch(/computeRoiCameraFeatures\(/);
    expect(server).toMatch(/trackStoppedMoving\(frames/);
  });
  it('ROI v2 stays fallback-safe: editor + config flags default safe', () => {
    expect(server).toMatch(/YOLO_ROI_EDITOR_ENABLED = process\.env\.YOLO_ROI_EDITOR_ENABLED === 'true'/);
    expect(server).toMatch(/YOLO_ROI_CONFIG_ENABLED = process\.env\.YOLO_ROI_CONFIG_ENABLED !== 'false'/);
  });
});

describe('production hardening wiring (DB ROI persistence, readiness, map zone)', () => {
  it('DB-backed ROI persistence is wired (table + load + save + fallback cache)', () => {
    expect(server).toMatch(/borderflow_camera_roi_configs/);
    expect(server).toMatch(/loadRoiConfigsFromDb/);
    expect(server).toMatch(/saveRoiConfigToDb/);
    expect(server).toMatch(/setDbRoiConfigs/);
  });
  it('readiness + cv-health endpoints exist and are debug-gated', () => {
    expect(server).toMatch(/\/api\/internal\/traffic-vision\/readiness/);
    expect(server).toMatch(/\/api\/internal\/traffic-vision\/cv-health/);
    expect(server).toMatch(/readyForPredictionV2Headline/);
  });
  it('the map display corridor/zone is emitted on the route + consumed by the UI', () => {
    expect(server).toMatch(/buildMeasurementZone\(/);
    expect(server).toMatch(/displayZone:/);
    expect(app).toMatch(/measurementZonePolygon/);
    expect(app).toMatch(/displayCorridorPolyline/);
  });
});

describe('live "Moja lokacija" signal wiring (subtle, anonymous, no raw trail)', () => {
  it('backend has the flag-gated endpoints + server-authoritative classify + aggregate', () => {
    expect(server).toMatch(/\/api\/location-wait\/session/);
    expect(server).toMatch(/\/api\/location-wait\/ping/);
    expect(server).toMatch(/\/api\/location-wait\/cancel/);
    expect(server).toMatch(/VERIFIED_LOCATION_ENABLED/);
    expect(server).toMatch(/classifyLocationPing\(/);
    expect(server).toMatch(/aggregateVerifiedLocation\(/);
    expect(server).toMatch(/borderflow_location_wait_sessions/);
  });
  it('the verifiedLocation aggregate feeds fusion + the breakdown', () => {
    expect(server).toMatch(/sourceBreakdown\.verifiedLocation =/);
    expect(server).toMatch(/verifiedForFusion/);
  });
  it('the UI has a Google-Maps-style location control + own blue dot ONLY (no other users)', () => {
    expect(app).toMatch(/map-location-button/);
    expect(app).toMatch(/Moja lokacija/);
    expect(app).toMatch(/user-location-dot|SymbolPath\.CIRCLE/);
    // Subtle copy — and NONE of the forbidden tracking words.
    expect(app).toMatch(/Ne spremamo tvoju rutu/);
    expect(app).not.toMatch(/Izmjeri moje čekanje|GPS trail|Pratimo te/);
  });
  it('the prediction UI shows the subtle "Potvrđeno live signalima" copy', () => {
    expect(app).toMatch(/Potvrđeno live signalima/);
  });
  it('the public state exposes the feature flag so the UI can subdue it when off', () => {
    expect(server).toMatch(/verifiedLocation: VERIFIED_LOCATION_ENABLED/);
  });
});
