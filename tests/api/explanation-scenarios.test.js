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
