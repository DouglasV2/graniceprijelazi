import { describe, it, expect } from 'vitest';
import { learnCountToWaitModel, applyCalibratedWait, buildCalibrationModels, calibrationKey } from '../../server/camera-calibration.js';

describe('learnCountToWaitModel', () => {
  it('stays UNcalibrated below the minimum sample count (→ heuristic fallback)', () => {
    const m = learnCountToWaitModel([{ count: 5, wait: 15 }, { count: 10, wait: 30 }], { minSamples: 6 });
    expect(m.calibrated).toBe(false);
    expect(m.reason).toBe('insufficient-samples');
  });

  it('learns ~3 min/vehicle from consistent samples (median ratio) with low MAE', () => {
    const samples = Array.from({ length: 8 }, (_, i) => ({ count: i + 2, wait: (i + 2) * 3 }));
    const m = learnCountToWaitModel(samples, { minSamples: 6 });
    expect(m.calibrated).toBe(true);
    expect(m.minutesPerVehicle).toBe(3);
    expect(m.mae).toBeLessThanOrEqual(2);
  });

  it('refuses to calibrate when the fit is too noisy (high MAE)', () => {
    const samples = [
      { count: 4, wait: 60 }, { count: 4, wait: 5 }, { count: 5, wait: 90 }, { count: 5, wait: 8 },
      { count: 6, wait: 70 }, { count: 6, wait: 6 }, { count: 7, wait: 80 }, { count: 7, wait: 7 },
    ];
    const m = learnCountToWaitModel(samples, { minSamples: 6, maxMae: 18 });
    expect(m.calibrated).toBe(false);
    expect(m.reason).toBe('mae-too-high');
  });

  it('a single outlier pair does not skew the median rate', () => {
    const samples = [
      { count: 5, wait: 15 }, { count: 6, wait: 18 }, { count: 7, wait: 21 }, { count: 8, wait: 24 },
      { count: 9, wait: 27 }, { count: 10, wait: 30 }, { count: 5, wait: 300 }, // outlier
    ];
    const m = learnCountToWaitModel(samples, { minSamples: 6, maxMae: 60 });
    expect(m.minutesPerVehicle).toBe(3); // median ratio ignores the 300-min outlier
  });
});

describe('applyCalibratedWait', () => {
  const model = { calibrated: true, minutesPerVehicle: 4 };
  it('uses the learned rate when calibrated', () => {
    expect(applyCalibratedWait(10, model)).toBe(40);
    expect(applyCalibratedWait(0, model)).toBe(0);
  });
  it('returns null when not calibrated (caller falls back to heuristic)', () => {
    expect(applyCalibratedWait(10, { calibrated: false, minutesPerVehicle: 4 })).toBeNull();
    expect(applyCalibratedWait(10, null)).toBeNull();
  });
  it('clamps to a sane maximum', () => {
    expect(applyCalibratedWait(1000, { calibrated: true, minutesPerVehicle: 5 })).toBe(360);
  });
});

describe('buildCalibrationModels — per crossing+direction', () => {
  it('learns each key independently and ignores invalid pairs', () => {
    const records = [
      ...Array.from({ length: 7 }, (_, i) => ({ crossingId: 'maljevac', direction: 'toBih', cameraCount: i + 2, actualWait: (i + 2) * 3 })),
      ...Array.from({ length: 7 }, (_, i) => ({ crossingId: 'maljevac', direction: 'toHr', cameraCount: i + 2, actualWait: (i + 2) * 5 })),
      { crossingId: 'gornji-varos', direction: 'toBih', cameraCount: 0, actualWait: 10 }, // count 0 → ignored
      { crossingId: 'gornji-varos', direction: 'toBih', cameraCount: 5, actualWait: null }, // no wait → ignored
    ];
    const models = buildCalibrationModels(records, { minSamples: 6 });
    expect(models[calibrationKey('maljevac', 'toBih')].minutesPerVehicle).toBe(3);
    expect(models[calibrationKey('maljevac', 'toHr')].minutesPerVehicle).toBe(5);
    expect(models[calibrationKey('maljevac', 'toBih')].calibrated).toBe(true);
    expect(models['gornji-varos:toBih']).toBeUndefined(); // no usable samples
  });
});
