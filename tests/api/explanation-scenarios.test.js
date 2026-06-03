// The five trust/explanation scenarios the product owner requires (V5 §3/§4).
// Driven end-to-end through effectiveBorderSignal (the real fusion) with injected
// source snapshots, plus one API test for the suspicious-measured exclusion.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp } from '../helpers/app-loader.js';

let app;
let mod;
let crossing;
const now = () => new Date().toISOString();
const store = { reports: [], overrides: {} };

beforeAll(async () => {
  app = await getApp();
  mod = await import('../../server/index.js');
  crossing = mod.BORDER_CROSSINGS.maljevac;
});

function hardPublic(wait) {
  return { sourceType: 'public-text-status', sourceName: 'HAK', normalizedWaitMin: wait, rawStatus: `Eksplicitno čekanje ${wait} min`, rawText: '', confidence: 90, weight: 1.35, fetchedAt: now(), metadata: {} };
}
function googleClear(wait = 8) {
  return { sourceType: 'google-traffic-estimate', sourceName: 'Google Routes', normalizedWaitMin: wait, confidence: 70, weight: 0.84, fetchedAt: now(), metadata: { delayMinutes: 1, ratio: 1.02, level: 'normal' } };
}
function camera(wait, queueVehicles, { stale = false } = {}) {
  return { sourceType: 'camera-snapshot-model', sourceName: 'Kamera', normalizedWaitMin: wait, confidence: 65, weight: 0.72, fetchedAt: now(), metadata: { queueVehicles, flowVehicles15: 5, passed15: 5, stale } };
}
function cameraVisual(band) {
  return { sourceType: 'camera-visual', sourceName: 'Kamera vizualna provjera', normalizedWaitMin: null, confidence: 60, weight: 0, fetchedAt: now(), metadata: { queueBand: band } };
}
function googleJam(wait = 8) {
  // Low computed wait (short control zone) but Google shows a jam near the border.
  return { sourceType: 'google-traffic-estimate', sourceName: 'Google Routes', normalizedWaitMin: wait, confidence: 70, weight: 0.84, fetchedAt: now(), metadata: { delayMinutes: 1, ratio: 1.04, level: 'normal', googleTrafficSeverity: 'jam', worstTrafficLevel: 'TRAFFIC_JAM', jamMeters: 420, affectedRatio: 0.6 } };
}
function googleClearTraffic(wait = 8) {
  return { sourceType: 'google-traffic-estimate', sourceName: 'Google Routes', normalizedWaitMin: wait, confidence: 70, weight: 0.84, fetchedAt: now(), metadata: { delayMinutes: 1, ratio: 1.02, level: 'normal', googleTrafficSeverity: 'clear', worstTrafficLevel: 'NORMAL', jamMeters: 0, affectedRatio: 0 } };
}

describe('Scenario 1: Google 15 vs official 90 → estimate must NOT drop', () => {
  it('keeps the official wait and marks Google as a non-authority helper', async () => {
    const sig = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [hardPublic(90), googleClear(15)]);
    expect(sig.wait).toBeGreaterThanOrEqual(85);
    expect(sig.explanationPayload.googleAsAuthority).toBe(false);
    expect(sig.explanationPayload.authorityTier).toBe('official');
    const google = sig.explanationPayload.sources.find((s) => s.kind === 'google');
    expect(google.role).toBe('helper');
    expect(google.flags.join(' ')).toContain('prilazni');
  });
});

describe('Scenario 2: stale camera must NOT raise confidence', () => {
  it('a stale camera scores lower confidence than a fresh one and is flagged', async () => {
    const fresh = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [camera(40, 24, { stale: false })]);
    const stale = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [camera(40, 24, { stale: true })]);
    expect(stale.confidenceScore).toBeLessThan(fresh.confidenceScore);
    expect(stale.confidenceLevel).not.toBe('visoka');
    const cam = stale.explanationPayload.sources.find((s) => s.kind === 'camera');
    expect(cam.flags.join(' ')).toContain('zastarjela');
  });
});

describe('Scenario 4: disagreeing sources → conflict + medium/low confidence', () => {
  it('official 90 vs camera 30 → conflict detected, not high confidence', async () => {
    const sig = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [hardPublic(90), camera(30, 24)]);
    expect(sig.explanationPayload.conflict.detected).toBe(true);
    expect(sig.explanationPayload.conflict.spreadMinutes).toBeGreaterThanOrEqual(40);
    expect(sig.confidenceLevel).not.toBe('visoka');
  });
});

describe('Scenario 5: low confidence → range, not a single number', () => {
  it('google-only → niska confidence and a displayed range', async () => {
    const sig = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [googleClear(8)]);
    expect(sig.confidenceLevel).toBe('niska');
    expect(sig.precision).toBe('range');
    expect(sig.rangeMax).toBeGreaterThan(sig.rangeMin);
  });
});

describe('Scenario 6 (V5 §6): camera cannot override official, and YOLO cannot bypass calibration', () => {
  it('official 90 vs camera 10 → fused stays high (official priority)', async () => {
    const sig = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [hardPublic(90), camera(10, 1)]);
    expect(sig.wait).toBeGreaterThanOrEqual(85);
    expect(sig.explanationPayload.authorityTier).toBe('official');
  });

  it('a camera-led estimate cannot be HIGH confidence without measured calibration data', async () => {
    const sig = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [camera(35, 24)]);
    // Even a strong camera queue is camera-heuristic only → calibration caps it below visoka.
    expect(sig.confidenceLevel).not.toBe('visoka');
  });
});

describe('Scenario 7 (core fix): visual congestion conflict — camera shows a big queue but wait is low', () => {
  it('Maljevac: visual-only camera shows ekstremna kolona + low Google → camera LEADS, commits to a higher number (no "provjeri")', async () => {
    const sig = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [googleClear(8), cameraVisual('ekstremna')]);
    expect(sig.visualCongestionConflict).toBe(true);
    expect(sig.visualBand).toBe('ekstremna');
    expect(sig.cameraCongestionOverride).toBe(true);
    expect(sig.conflictKind).toBe('camera-congestion');
    // The number is RAISED toward the camera read, not left at Google's low 8.
    expect(sig.wait).toBeGreaterThanOrEqual(25);
    expect(sig.precision).toBe('range');
    expect(sig.label).toMatch(/gužva|kamer/i);
    expect(sig.label).not.toMatch(/provjeri/i);
    expect(sig.note).toMatch(/kolon/i);
    expect(sig.note).not.toMatch(/provjeri/i);
  });

  it('no conflict when the wait already reflects congestion (official high)', async () => {
    const sig = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [hardPublic(80), cameraVisual('ekstremna')]);
    expect(sig.visualCongestionConflict).toBe(false);
    expect(sig.wait).toBeGreaterThanOrEqual(75);
  });

  it('Šamac: official wait with no camera congestion is NOT flagged as a camera estimate', async () => {
    const sig = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [hardPublic(120)]);
    expect(sig.explanationPayload.authorityTier).toBe('official');
    expect(sig.explanationPayload.sources.some((s) => s.kind === 'camera')).toBe(false);
  });

  it('Šamac inverse conflict: high wait but camera shows only a small queue → conflict, niska, verify', async () => {
    // 6h-style absurd wait with the camera visually showing nema/mala kolona.
    const sig = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [hardPublic(360), cameraVisual('mala')]);
    expect(sig.conflictKind).toBe('clear-high');
    expect(sig.visualConflict).toBe(true);
    // Official (hard) outranks the camera, so the high number stays — but we commit to it and say
    // the camera doesn't show that queue, WITHOUT sending the user to official sources.
    expect(sig.label).not.toMatch(/provjeri/i);
    expect(sig.label).toMatch(/kamer/i);
    expect(sig.note).toMatch(/kamera trenutno ne pokazuje/i);
    expect(sig.note).not.toMatch(/provjeri/i);
  });
});

describe('Scenario 8 (Google traffic): helper signal, never authority', () => {
  it('low wait + Google TRAFFIC_JAM near border → conflict / "od X", not a confident low number', async () => {
    const sig = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [googleJam(8)]);
    expect(sig.conflictKind).toBe('google-jam');
    expect(sig.googleTrafficConflict).toBe(true);
    expect(sig.confidenceLevel).toBe('niska');
    expect(sig.explanationPayload.googleTraffic.usedAsFusionSignal).toBe(true);
    expect(sig.explanationPayload.googleTraffic.usedAsAuthority).toBe(false);
    expect(sig.note).toMatch(/Google promet pokazuje gužvu/i);
    // A genuine near-border jam (fixture jamMeters 420) floors the headline above the tiny base 8
    // so it does not read "od 6/8 min" next to a visible column.
    expect(sig.wait).toBeGreaterThanOrEqual(12);
  });

  it('a longer jam floors the wait higher than a short one (proportional to jam metres)', async () => {
    const big = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [{ ...googleJam(8), metadata: { ...googleJam(8).metadata, jamMeters: 900 } }]);
    const small = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [{ ...googleJam(8), metadata: { ...googleJam(8).metadata, jamMeters: 150 } }]);
    expect(big.wait).toBeGreaterThanOrEqual(20);
    expect(big.wait).toBeGreaterThan(small.wait);
  });

  it('a hard official wait is NOT raised by the Google jam floor (official > google)', async () => {
    // 18 min hard official + Google jam: the jam floor (22) must NOT apply (official governs).
    const sig = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [hardPublic(18), googleJam(8)]);
    expect(sig.wait).toBeLessThan(22); // not floored up to the Google-jam value
    expect(sig.wait).toBeGreaterThanOrEqual(10); // governed by the official, not Google's tiny 8
  });

  it('Google clear must NOT lower an official high wait (official stays primary)', async () => {
    const sig = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [hardPublic(80), googleClearTraffic(8)]);
    expect(sig.wait).toBeGreaterThanOrEqual(75);
    expect(sig.googleTrafficConflict).toBe(false);
    expect(sig.explanationPayload.googleTraffic.note).toMatch(/prilaznu cestu/i);
  });

  it('camera congestion + Google jam → supporting explanation (camera conflict still leads)', async () => {
    const sig = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [googleJam(8), cameraVisual('ekstremna')]);
    expect(sig.visualCongestionConflict).toBe(true); // camera congestion takes precedence
    expect(sig.explanationPayload.googleTraffic.note).toMatch(/zajedno upućuju|gužvu/i);
  });

  it('Google traffic unavailable does not change the wait', async () => {
    const withGoogle = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [hardPublic(40), googleClearTraffic(8)]);
    const withoutGoogle = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', store, [hardPublic(40)]);
    expect(withoutGoogle.wait).toBe(withGoogle.wait);
    expect(withoutGoogle.explanationPayload.googleTraffic.available).toBe(false);
  });
});

describe('Scenario 3: suspicious measured wait must NOT enter the fusion', () => {
  it('a measured session with GPS far from the crossing is discarded (no report, no signal)', async () => {
    // Start + finish with coordinates nowhere near izacic → gpsSuspicious → discarded.
    const start = await request(app).post('/api/measured/start').send({ crossingId: 'izacic', direction: 'toBih', gps: { lat: 48.0, lng: 16.4 } });
    const finish = await request(app).post('/api/measured/finish').send({ sessionId: start.body.sessionId, gps: { lat: 48.05, lng: 16.45 } });
    expect(finish.body.gpsSuspicious).toBe(true);
    // The fusion must not have gained a measured session for izacic.
    const state = await request(app).get('/api/public/state');
    const meta = state.body.waitSources?.['izacic:toBih'];
    expect(meta?.hasMeasuredSession).not.toBe(true);
  });
});
