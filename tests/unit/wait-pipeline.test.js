// Unit tests for the wait pipeline parsers and sanity caps.
//
// Covers the 2026-05-28 regression where Maljevac was showing ~45 min when
// Google was clear AND the camera reported no queue. Root causes:
//   a) "Pojačan ulaz/izlaz" from HAK/BIHAMK was parsed as a HARD 45-min signal,
//      which set hasHardPublic=true and bypassed most sanity caps.
//   b) When the stored Google snapshot was missing/stale, `clearGoogle` was
//      false, so the catch-all "Google clear → cap 25" cap could not fire.
// Fix: pojacan→soft upper bound + new caps for the "no Google snapshot but
// camera clear / soft public only" case.

import { describe, it, expect } from 'vitest';
import {
  parseDirectionalWaitsFromText,
  isSoftUpperBoundSource,
  applyTrafficSanityCaps,
} from '../../server/index.js';

function makeSoftPublicSignal(rawStatus = 'Zadržavanja nisu duža od 30 min', wait = 10) {
  return {
    sourceType: 'public-text-status',
    sourceName: 'BIHAMK',
    normalizedWaitMin: wait,
    rawStatus,
    rawText: rawStatus,
    confidence: 62,
    weight: 0.42,
    metadata: { softUpperBound: true, softMaxMinutes: 30, parser: 'under-not-longer-than' },
  };
}

function makeHardPublicSignal(rawStatus = 'Eksplicitno čekanje 35 min', wait = 35) {
  return {
    sourceType: 'public-text-status',
    sourceName: 'HAK',
    normalizedWaitMin: wait,
    rawStatus,
    rawText: rawStatus,
    confidence: 90,
    weight: 1.35,
    metadata: {},
  };
}

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

function makeCameraSignal({ wait = 8, queueVehicles = 2, flowVehicles15 = 14 } = {}) {
  return {
    sourceType: 'camera-snapshot-model',
    sourceName: 'Kamera',
    normalizedWaitMin: wait,
    rawStatus: '',
    rawText: '',
    confidence: 60,
    weight: 0.72,
    metadata: { queueVehicles, flowVehicles15, passed15: flowVehicles15 },
  };
}

describe('parseDirectionalWaitsFromText — "Pojačan ulaz/izlaz" is a soft upper bound', () => {
  it('HAK "Pojačan izlaz iz HR" produces a soft signal, not a hard 45 min', () => {
    const signals = parseDirectionalWaitsFromText('Pojačan je izlaz iz HR prema BiH; promet se zadržava.', { sourceSide: 'hr' });
    const toBih = signals.find((s) => s.direction === 'toBih');
    expect(toBih, 'expected an exit-side signal').toBeTruthy();
    // Soft signals carry softUpperBound metadata and a lower normalized wait (~15) rather
    // than the legacy literal 45.
    expect(toBih.metadata?.softUpperBound).toBe(true);
    expect(toBih.wait).toBeLessThanOrEqual(20);
    expect(isSoftUpperBoundSource({
      sourceType: 'public-text-status',
      rawStatus: toBih.rawStatus,
      rawText: 'Pojačan je izlaz iz HR prema BiH',
      metadata: toBih.metadata,
    })).toBe(true);
  });

  it('BIHAMK "Pojačan ulaz u BiH/RS" produces a soft signal', () => {
    const signals = parseDirectionalWaitsFromText('Pojačan je ulaz u BiH na ovom prijelazu.', { sourceSide: 'bih' });
    const toBih = signals.find((s) => s.direction === 'toBih');
    expect(toBih).toBeTruthy();
    expect(toBih.metadata?.softUpperBound).toBe(true);
    expect(toBih.wait).toBeLessThan(20);
  });

  it('"nije duže od 30 min" still parses as soft 6–14 estimate', () => {
    const signals = parseDirectionalWaitsFromText('Zadržavanja na ulazu nisu duža od 30 min.', { sourceSide: 'hr' });
    const signal = signals[0];
    expect(signal.metadata?.softUpperBound).toBe(true);
    expect(signal.wait).toBeLessThan(20);
  });
});

describe('applyTrafficSanityCaps — Google snapshot fresh and clear (Google-Maps colour model)', () => {
  it('blue route → wait max 15 min (user mental model: blue = max 15)', () => {
    const sanity = applyTrafficSanityCaps(35, {
      googleSignal: makeGoogleSignal({ delayMinutes: 1, level: 'normal' }),
      cameraSignal: makeCameraSignal({ wait: 6, queueVehicles: 1, flowVehicles15: 14 }),
      publicSignals: [makeSoftPublicSignal('Zadržavanja nisu duža od 30 min', 10)],
    });
    expect(sanity.adjusted).toBe(true);
    expect(sanity.wait).toBeLessThanOrEqual(15);
  });

  it('blue route + clear camera + no hard public → also caps to 15', () => {
    const sanity = applyTrafficSanityCaps(45, {
      googleSignal: makeGoogleSignal({ delayMinutes: 1 }),
      cameraSignal: makeCameraSignal({ wait: 6 }),
      publicSignals: [],
    });
    expect(sanity.wait).toBeLessThanOrEqual(15);
  });

  it('blue route + hard public number (BIHAMK 45 min) → kept at 45 (official source wins)', () => {
    // New fusion policy: an official hard number is authoritative; a blue Google road does
    // not split-the-difference it down. The booth queue is real even when the approach flows.
    const sanity = applyTrafficSanityCaps(45, {
      googleSignal: makeGoogleSignal({ delayMinutes: 1 }),
      cameraSignal: null,
      publicSignals: [makeHardPublicSignal('Eksplicitno čekanje 45 min', 45)],
    });
    expect(sanity.wait).toBe(45);
    expect(sanity.googleVsOfficial).toBe(true);
  });
});

describe('applyTrafficSanityCaps — Google snapshot missing (the Maljevac case)', () => {
  it('no Google + clear camera + no hard public → caps to 20', () => {
    const sanity = applyTrafficSanityCaps(45, {
      googleSignal: null,
      cameraSignal: makeCameraSignal({ wait: 6, queueVehicles: 1, flowVehicles15: 14 }),
      publicSignals: [makeSoftPublicSignal()],
    });
    expect(sanity.adjusted).toBe(true);
    expect(sanity.wait).toBeLessThanOrEqual(20);
  });

  it('no Google + camera no queue (not strictly clear) + soft public → caps to 22', () => {
    const sanity = applyTrafficSanityCaps(45, {
      googleSignal: null,
      cameraSignal: makeCameraSignal({ wait: 15, queueVehicles: 6, flowVehicles15: 8 }),
      publicSignals: [makeSoftPublicSignal()],
    });
    expect(sanity.adjusted).toBe(true);
    expect(sanity.wait).toBeLessThanOrEqual(22);
  });

  it('no Google + soft public only (no camera) → caps to 24', () => {
    const sanity = applyTrafficSanityCaps(45, {
      googleSignal: null,
      cameraSignal: null,
      publicSignals: [makeSoftPublicSignal()],
    });
    expect(sanity.adjusted).toBe(true);
    expect(sanity.wait).toBeLessThanOrEqual(24);
  });

  it('no Google + hard public still allows higher waits (we trust explicit BIHAMK/HAK numbers)', () => {
    const sanity = applyTrafficSanityCaps(45, {
      googleSignal: null,
      cameraSignal: null,
      publicSignals: [makeHardPublicSignal('Eksplicitno čekanje 45 min', 45)],
    });
    // No cap fires when we have a hard explicit number and no contradicting signal.
    expect(sanity.adjusted).toBe(false);
    expect(sanity.wait).toBe(45);
  });
});

describe('applyTrafficSanityCaps — heavy Google or driver reports bypass caps', () => {
  it('heavy Google → no cap', () => {
    const sanity = applyTrafficSanityCaps(45, {
      googleSignal: makeGoogleSignal({ delayMinutes: 10, ratio: 1.4, level: 'heavy' }),
      cameraSignal: null,
      publicSignals: [makeSoftPublicSignal()],
    });
    expect(sanity.adjusted).toBe(false);
  });

  it('driver reports avg present → no cap', () => {
    const sanity = applyTrafficSanityCaps(45, {
      googleSignal: makeGoogleSignal({ delayMinutes: 1 }),
      cameraSignal: makeCameraSignal({ wait: 6 }),
      publicSignals: [],
      reportAvg: 40,
    });
    expect(sanity.adjusted).toBe(false);
  });
});
