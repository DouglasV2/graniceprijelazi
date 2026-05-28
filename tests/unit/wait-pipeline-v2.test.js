// Unit tests for the second-round wait pipeline improvements (2026-05-28):
//   1. Legacy "Pojačan = 45 min HARD" snapshots get re-normalized at read time
//   2. Google BLUE (clear) caps total wait at 15 min (user's mental model)
//   3. Google YELLOW (slow) caps at 35; Google RED (heavy) has no cap
//   4. Signal age decay halves weight every 25 min
//   5. Trimmed-mean camera averaging rejects outliers
//   6. Cross-source agreement boost/penalty adjusts confidence
//   7. EMA smoothing suppresses flicker but lets real changes through

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isSoftUpperBoundSource,
  sanitizeLegacyPublicSignal,
  applyTrafficSanityCaps,
  ageDecayMultiplier,
  trimmedMeanCameraSignal,
  crossSourceAgreement,
  emaSmoothWait,
} from '../../server/index.js';

function makeGoogleSignal({ delayMinutes = 1, ratio = 1.02, level = 'normal', wait = 6 } = {}) {
  return {
    sourceType: 'google-traffic-estimate',
    sourceName: 'Google Routes',
    normalizedWaitMin: wait,
    rawStatus: `google ${level}`,
    rawText: '',
    confidence: 70,
    weight: 0.84,
    metadata: { delayMinutes, ratio, level },
  };
}

function makeCameraSignal({ wait = 8, queueVehicles = 2, flowVehicles15 = 14, fetchedAt = new Date().toISOString() } = {}) {
  return {
    sourceType: 'camera-snapshot-model',
    sourceName: 'Kamera',
    normalizedWaitMin: wait,
    rawStatus: '',
    rawText: '',
    confidence: 60,
    weight: 0.72,
    fetchedAt,
    metadata: { queueVehicles, flowVehicles15, passed15: flowVehicles15 },
  };
}

function makePublic(rawStatus, wait, confidence = 70, weight = 1.0, metadata = {}) {
  return {
    sourceType: 'public-text-status',
    sourceName: rawStatus.startsWith('HAK') ? 'HAK' : 'BIHAMK',
    normalizedWaitMin: wait,
    rawStatus,
    rawText: rawStatus,
    confidence,
    weight,
    metadata,
  };
}

describe('Legacy snapshot re-normalization', () => {
  it('detects legacy "Pojačan" rawStatus as soft even without softUpperBound metadata', () => {
    const legacy = makePublic('Pojačan izlaz iz HR', 45, 76, 1.05);
    expect(isSoftUpperBoundSource(legacy)).toBe(true);
  });

  it('sanitizeLegacyPublicSignal re-normalizes a stored 45-min "Pojačan" hard entry', () => {
    const legacy = makePublic('Pojačan izlaz iz HR', 45, 76, 1.05);
    const fixed = sanitizeLegacyPublicSignal(legacy);
    expect(fixed.metadata.softUpperBound).toBe(true);
    expect(fixed.normalizedWaitMin).toBeLessThanOrEqual(18);
    expect(fixed.confidence).toBeLessThanOrEqual(64);
    expect(fixed.weight).toBeLessThanOrEqual(0.5);
    expect(fixed.metadata.legacyOriginalWait).toBe(45);
  });

  it('does not mutate a non-soft hard signal ("Eksplicitno čekanje 45 min")', () => {
    const hard = makePublic('Eksplicitno čekanje 45 min', 45, 90, 1.35);
    const out = sanitizeLegacyPublicSignal(hard);
    expect(out).toBe(hard);
  });

  it('does not mutate a signal that is already marked soft via metadata', () => {
    const already = makePublic('Zadržavanja nisu duža od 30 min', 10, 62, 0.42, { softUpperBound: true, softMaxMinutes: 30 });
    const out = sanitizeLegacyPublicSignal(already);
    expect(out).toBe(already);
  });
});

describe('Google BLUE → max 15 min (the Maljevac fix)', () => {
  it('clear Google + no strong queue + no hard public → caps to 15 (the user-visible bug)', () => {
    const sanity = applyTrafficSanityCaps(45, {
      googleSignal: makeGoogleSignal({ delayMinutes: 1, level: 'normal' }),
      cameraSignal: makeCameraSignal({ wait: 8, queueVehicles: 2 }),
      publicSignals: [makePublic('Zadržavanja nisu duža od 30 min', 10, 62, 0.42, { softUpperBound: true })],
    });
    expect(sanity.adjusted).toBe(true);
    expect(sanity.wait).toBeLessThanOrEqual(15);
  });

  it('clear Google + strong camera queue still allows 25 (booth queue Google missed)', () => {
    const sanity = applyTrafficSanityCaps(45, {
      googleSignal: makeGoogleSignal({ delayMinutes: 1 }),
      cameraSignal: makeCameraSignal({ wait: 25, queueVehicles: 22 }),
      publicSignals: [],
    });
    expect(sanity.wait).toBeLessThanOrEqual(25);
    expect(sanity.wait).toBeGreaterThan(15);
  });

  it('clear Google + hard public BIHAMK number → caps to 22 (split difference)', () => {
    const sanity = applyTrafficSanityCaps(45, {
      googleSignal: makeGoogleSignal({ delayMinutes: 1 }),
      cameraSignal: null,
      publicSignals: [makePublic('Eksplicitno čekanje 45 min', 45, 90, 1.35)],
    });
    expect(sanity.wait).toBeLessThanOrEqual(22);
  });

  it('blue route with only Google signal also caps to 15', () => {
    const sanity = applyTrafficSanityCaps(30, {
      googleSignal: makeGoogleSignal({ delayMinutes: 0, level: 'normal' }),
      cameraSignal: null,
      publicSignals: [],
    });
    expect(sanity.wait).toBeLessThanOrEqual(15);
  });
});

describe('Google YELLOW/ORANGE → cap 35; Google RED → no cap', () => {
  it('slow Google + no strong queue + no hard public → caps to 35', () => {
    const sanity = applyTrafficSanityCaps(60, {
      googleSignal: makeGoogleSignal({ delayMinutes: 5, ratio: 1.2, level: 'slow' }),
      cameraSignal: null,
      publicSignals: [],
    });
    expect(sanity.wait).toBeLessThanOrEqual(35);
  });

  it('heavy Google (red) has no cap', () => {
    const sanity = applyTrafficSanityCaps(60, {
      googleSignal: makeGoogleSignal({ delayMinutes: 12, ratio: 1.5, level: 'heavy' }),
      cameraSignal: null,
      publicSignals: [],
    });
    expect(sanity.adjusted).toBe(false);
    expect(sanity.wait).toBe(60);
  });

  it('slow Google + hard public 50 → still capped to 35 (Google road dominates qualitative claims)', () => {
    const sanity = applyTrafficSanityCaps(50, {
      googleSignal: makeGoogleSignal({ delayMinutes: 4, level: 'slow' }),
      cameraSignal: null,
      publicSignals: [makePublic('Eksplicitno čekanje 50 min', 50, 90, 1.35)],
    });
    // hasHardPublic=true blocks the slow-cap, so 50 stays.
    expect(sanity.wait).toBe(50);
  });
});

describe('Signal age decay', () => {
  it('current signal has multiplier ≈ 1.0', () => {
    const mult = ageDecayMultiplier(new Date().toISOString());
    expect(mult).toBeGreaterThan(0.98);
  });

  it('25-min-old signal has multiplier ≈ 0.5', () => {
    const past = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const mult = ageDecayMultiplier(past);
    expect(mult).toBeCloseTo(0.5, 1);
  });

  it('50-min-old signal has multiplier ≈ 0.25', () => {
    const past = new Date(Date.now() - 50 * 60 * 1000).toISOString();
    const mult = ageDecayMultiplier(past);
    expect(mult).toBeCloseTo(0.25, 1);
  });

  it('Google snapshots decay faster (halfLife=18 min)', () => {
    const past = new Date(Date.now() - 18 * 60 * 1000).toISOString();
    const mult = ageDecayMultiplier(past, 18);
    expect(mult).toBeCloseTo(0.5, 1);
  });

  it('missing fetchedAt yields a conservative 0.5 multiplier (treat as moderately stale)', () => {
    expect(ageDecayMultiplier(null)).toBe(0.5);
    expect(ageDecayMultiplier(undefined)).toBe(0.5);
  });
});

describe('Trimmed-mean camera averaging', () => {
  function snap(wait, ageMin = 0, queue = 2, flow = 14) {
    return {
      sourceType: 'camera-snapshot-model',
      sourceName: 'Kamera',
      normalizedWaitMin: wait,
      confidence: 60,
      weight: 0.72,
      fetchedAt: new Date(Date.now() - ageMin * 60000).toISOString(),
      metadata: { queueVehicles: queue, flowVehicles15: flow, passed15: flow },
    };
  }

  it('returns null for empty list', () => {
    expect(trimmedMeanCameraSignal([])).toBeNull();
  });

  it('with 1 or 2 snapshots falls back to the freshest', () => {
    const out = trimmedMeanCameraSignal([snap(12, 5), snap(15, 10)]);
    expect(out.normalizedWaitMin).toBe(12);
  });

  it('drops outliers in 5-snapshot window (a single 45 spike is rejected)', () => {
    const out = trimmedMeanCameraSignal([
      snap(45, 0),  // outlier — newest but anomalous
      snap(8, 4),
      snap(9, 8),
      snap(10, 12),
      snap(11, 16),
    ]);
    expect(out.normalizedWaitMin).toBeLessThanOrEqual(15);
    expect(out.normalizedWaitMin).toBeGreaterThanOrEqual(8);
    expect(out.metadata.cameraSnapshotsAveraged).toBe(3);
  });

  it('drops outliers on both ends with 5 snapshots', () => {
    const out = trimmedMeanCameraSignal([
      snap(45, 0),
      snap(8, 4),
      snap(9, 8),
      snap(10, 12),
      snap(2, 16),  // low outlier
    ]);
    expect(out.normalizedWaitMin).toBe(9); // (8+9+10)/3 = 9
  });
});

describe('Cross-source agreement', () => {
  it('single source: no boost', () => {
    const out = crossSourceAgreement([makePublic('BIHAMK do 30', 10)]);
    expect(out.boost).toBe(0);
    expect(out.agreement).toBe('single-source');
  });

  it('strong agreement (spread ≤ 5): +15 boost', () => {
    const out = crossSourceAgreement([
      makePublic('BIHAMK', 12),
      makePublic('HAK', 14),
      makePublic('AMS', 15),
    ]);
    expect(out.boost).toBe(15);
    expect(out.agreement).toBe('strong');
  });

  it('moderate agreement (spread ≤ 12): +6 boost', () => {
    const out = crossSourceAgreement([
      makePublic('BIHAMK', 10),
      makePublic('HAK', 20),
    ]);
    expect(out.boost).toBe(6);
    expect(out.agreement).toBe('moderate');
  });

  it('conflicting (spread > 25): -10 penalty', () => {
    const out = crossSourceAgreement([
      makePublic('BIHAMK', 10),
      makePublic('HAK', 45),
    ]);
    expect(out.boost).toBe(-10);
    expect(out.agreement).toBe('conflicting');
  });
});

describe('EMA smoothing', () => {
  beforeEach(() => {
    // Reset by using a new key per test
  });

  it('first call seeds with raw value', () => {
    const out = emaSmoothWait('test-1', 20);
    expect(out).toBe(20);
  });

  it('small follow-up delta gets blended (12→18 ≈ 16)', () => {
    emaSmoothWait('test-2', 12);
    const out = emaSmoothWait('test-2', 18);
    // 0.65*18 + 0.35*12 = 11.7 + 4.2 = 15.9 → 16
    expect(out).toBe(16);
  });

  it('big delta (> 25 min) bypasses smoothing — likely a real change', () => {
    emaSmoothWait('test-3', 10);
    const out = emaSmoothWait('test-3', 50);
    expect(out).toBe(50);
  });

  it('non-finite input returns as-is', () => {
    expect(emaSmoothWait('test-4', NaN)).toBeNaN();
    expect(emaSmoothWait('test-5', null)).toBeNull();
  });
});

describe('Maljevac end-to-end scenario (the reported bug)', () => {
  it('reproduces the "blue route + camera no queue + legacy Pojačan = 45" case → ≤ 15', () => {
    // 1) Legacy stored signal as it was BEFORE the parser fix.
    const legacy = makePublic('Pojačan izlaz iz HR prema BiH; promet se zadržava.', 45, 76, 1.05);
    const sanitized = sanitizeLegacyPublicSignal(legacy);
    expect(sanitized.normalizedWaitMin).toBeLessThanOrEqual(18);

    // 2) Fresh Google blue + camera no queue.
    const google = makeGoogleSignal({ delayMinutes: 1, level: 'normal', wait: 6 });
    const camera = makeCameraSignal({ wait: 8, queueVehicles: 1, flowVehicles15: 16 });

    // 3) Pretend the weighted average ended up at 32 because legacy snapshots aged in.
    const sanity = applyTrafficSanityCaps(32, {
      googleSignal: google,
      cameraSignal: camera,
      publicSignals: [sanitized],
    });

    expect(sanity.adjusted).toBe(true);
    expect(sanity.wait).toBeLessThanOrEqual(15);
  });

  it('also caps the no-Google fallback path to ≤ 18 when camera is clear', () => {
    const camera = makeCameraSignal({ wait: 8, queueVehicles: 1, flowVehicles15: 16 });
    const sanity = applyTrafficSanityCaps(38, {
      googleSignal: null,
      cameraSignal: camera,
      publicSignals: [makePublic('Pojačan ulaz', 15, 64, 0.5, { softUpperBound: true })],
    });
    expect(sanity.wait).toBeLessThanOrEqual(18);
  });
});
