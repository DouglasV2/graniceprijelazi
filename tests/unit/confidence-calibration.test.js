import { describe, it, expect } from 'vitest';
import {
  bucketMetrics,
  sourceMixClass,
  computeCalibrationModel,
  applyConfidenceDowngrades,
  computeConfidenceCalibrationStats,
  computeErrorHistogram,
  computeReliabilityReport,
} from '../../server/confidence-calibration.js';

// Build N resolved records for a crossing/direction with a target abs error.
function records({ crossingId = 'gradiska', direction = 'toBih', confidenceLevel = 'visoka', sourceMix = { hasHardPublic: true }, n = 30, error = 5, sign = 1 } = {}) {
  return Array.from({ length: n }, () => ({ crossingId, direction, confidenceLevel, sourceMix, predictedWait: 40, actualWait: 40 - sign * error }));
}

describe('bucketMetrics', () => {
  it('computes within15/within30/under/over correctly', () => {
    const m = bucketMetrics([
      { predictedWait: 30, actualWait: 35 }, // under by 5
      { predictedWait: 60, actualWait: 50 }, // over by 10
      { predictedWait: 20, actualWait: 60 }, // under by 40
    ]);
    expect(m.n).toBe(3);
    expect(m.within15).toBeCloseTo(2 / 3, 1);
    expect(m.within30).toBeCloseTo(2 / 3, 1);
    expect(m.underestimateRate).toBeCloseTo(2 / 3, 1);
  });
});

describe('sourceMixClass', () => {
  it('ranks measured > official > camera > google', () => {
    expect(sourceMixClass({ hasMeasured: true, hasHardPublic: true })).toBe('measured');
    expect(sourceMixClass({ hasHardPublic: true })).toBe('official');
    expect(sourceMixClass({ hasCamera: true })).toBe('camera');
    expect(sourceMixClass({ hasGoogle: true })).toBe('google');
  });
});

describe('calibration model: HIGH must be earned empirically', () => {
  it('grants HIGH only with enough accurate samples', () => {
    const model = computeCalibrationModel(records({ n: 35, error: 4 }));
    const out = model.calibratedConfidence('visoka', { crossingId: 'gradiska', direction: 'toBih', sourceMix: { hasHardPublic: true } });
    expect(out.level).toBe('visoka');
    expect(out.hasData).toBe(true);
  });

  it('downgrades HIGH→MEDIUM when there is insufficient measured data', () => {
    const model = computeCalibrationModel(records({ n: 4, error: 4 }));
    const out = model.calibratedConfidence('visoka', { crossingId: 'gradiska', direction: 'toBih', sourceMix: { hasHardPublic: true } });
    expect(out.level).toBe('srednja');
    expect(out.reasons.join(' ')).toContain('nedovoljno');
  });

  it('downgrades HIGH when the bucket is large but inaccurate (never stays visoka)', () => {
    const model = computeCalibrationModel(records({ n: 40, error: 50 })); // big errors
    const out = model.calibratedConfidence('visoka', { crossingId: 'gradiska', direction: 'toBih', sourceMix: { hasHardPublic: true } });
    expect(out.level).not.toBe('visoka'); // an inaccurate history cascades visoka→srednja→niska
  });

  it('empty model cannot fabricate HIGH', () => {
    const model = computeCalibrationModel([]);
    const out = model.calibratedConfidence('visoka', { crossingId: 'x', direction: 'toBih', sourceMix: {} });
    expect(out.level).toBe('srednja');
    expect(out.hasData).toBe(false);
  });
});

describe('downgrade rules (§7 D)', () => {
  it('conflict spread > 45 → max niska', () => {
    expect(applyConfidenceDowngrades('visoka', { conflictSpread: 50 }).level).toBe('niska');
  });
  it('conflict spread > 25 → max srednja', () => {
    expect(applyConfidenceDowngrades('visoka', { conflictSpread: 30 }).level).toBe('srednja');
  });
  it('camera heuristic only → max srednja; with no/low queue → max niska', () => {
    expect(applyConfidenceDowngrades('visoka', { cameraHeuristicOnly: true, queueBand: 'srednja' }).level).toBe('srednja');
    expect(applyConfidenceDowngrades('visoka', { cameraHeuristicOnly: true, queueBand: 'nema' }).level).toBe('niska');
  });
  it('google-only never HIGH', () => {
    expect(applyConfidenceDowngrades('visoka', { googleOnly: true }).level).not.toBe('visoka');
  });
  it('single source (no measured) never HIGH', () => {
    expect(applyConfidenceDowngrades('visoka', { singleSource: true }).level).not.toBe('visoka');
    expect(applyConfidenceDowngrades('visoka', { singleSource: true, hasRecentMeasured: true }).level).toBe('visoka');
  });
});

describe('calibration stats + reliability', () => {
  it('flags miscalibration when HIGH is not actually better than LOW', () => {
    const recs = [
      ...records({ confidenceLevel: 'visoka', n: 10, error: 50 }), // "high" but terrible
      ...records({ confidenceLevel: 'niska', n: 10, error: 3 }),   // "low" but great
    ];
    const stats = computeConfidenceCalibrationStats(recs);
    expect(stats.miscalibrated).toBe(true);
  });

  it('histogram bins abs errors by bucket', () => {
    const hist = computeErrorHistogram([
      { confidenceLevel: 'visoka', predictedWait: 30, actualWait: 32 }, // 2 → 0-5
      { confidenceLevel: 'niska', predictedWait: 30, actualWait: 80 },  // 50 → 45-60
    ]);
    expect(hist.visoka['0-5']).toBe(1);
    expect(hist.niska['45-60']).toBe(1);
  });

  it('reliability report yields recommendations', () => {
    const recs = records({ confidenceLevel: 'srednja', n: 8, error: 40, sign: 1 });
    const report = computeReliabilityReport(recs);
    expect(Array.isArray(report.recommendations)).toBe(true);
  });
});
