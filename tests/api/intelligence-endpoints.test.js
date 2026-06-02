// Integration tests for the V4 intelligence endpoints: measured-wait sessions,
// best-crossing engine, accuracy tracking, telemetry, and alerts.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp, findIllegalJsonValue } from '../helpers/app-loader.js';

let app;
let adminToken;

beforeAll(async () => {
  app = await getApp();
  const mod = await import('../../server/index.js');
  // Mint an admin token against the seeded admin user (admin-access / admin@borderflow.app).
  adminToken = mod.signToken({ id: 'admin-access', email: 'admin@borderflow.app', role: 'admin', name: 'Admin' });
});

describe('measured wait sessions (spec §5)', () => {
  it('starts a session anonymously and returns a sessionId', async () => {
    const res = await request(app).post('/api/measured/start').send({ crossingId: 'maljevac', direction: 'toBih' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.sessionId).toBe('string');
  });

  it('rejects an unknown crossing', async () => {
    const res = await request(app).post('/api/measured/start').send({ crossingId: 'nope', direction: 'toBih' });
    expect(res.status).toBe(400);
  });

  it('finishes a session and produces a numeric measured wait, then drives the public estimate', async () => {
    const start = await request(app).post('/api/measured/start').send({ crossingId: 'gradiska', direction: 'toHr' });
    const sessionId = start.body.sessionId;
    const finish = await request(app).post('/api/measured/finish').send({ sessionId, gps: { lat: 45.14, lng: 16.05 } });
    expect(finish.status).toBe(200);
    expect(finish.body.ok).toBe(true);
    expect(Number.isFinite(finish.body.wait)).toBe(true);

    // The measured report must now drive a live, camera/official-independent estimate.
    const state = await request(app).get('/api/public/state');
    const meta = state.body.waitSources?.['gradiska:toHr'];
    expect(meta).toBeTruthy();
    expect(meta.displayReady).toBe(true);
    expect(meta.hasMeasuredSession).toBe(true);
    expect(meta.confidenceLevel).toBeTruthy();
  });

  it('returns 404 for an unknown session and 409 when finishing twice', async () => {
    const start = await request(app).post('/api/measured/start').send({ crossingId: 'maljevac', direction: 'toHr' });
    const sessionId = start.body.sessionId;
    await request(app).post('/api/measured/finish').send({ sessionId });
    const twice = await request(app).post('/api/measured/finish').send({ sessionId });
    expect(twice.status).toBe(409);
    const missing = await request(app).post('/api/measured/finish').send({ sessionId: 'does-not-exist' });
    expect(missing.status).toBe(404);
  });
});

describe('geofence + auto start/stop (V5 §1)', () => {
  it('exposes geofence definitions for every crossing/direction', async () => {
    const res = await request(app).get('/api/measured/geofences');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.geofences.length).toBeGreaterThan(0);
    const f = res.body.geofences[0];
    expect(f.approach).toHaveProperty('lat');
    expect(f.border).toHaveProperty('lat');
  });

  it('auto-starts on approach and auto-finishes at the booth from GPS pings', async () => {
    const fences = (await request(app).get('/api/measured/geofences')).body.geofences;
    const fence = fences.find((g) => g.crossingId === 'gradiska' && g.direction === 'toBih') || fences[0];
    const deviceId = `test-device-${Date.now()}`;

    const started = await request(app).post('/api/measured/ping').send({ deviceId, gps: fence.approach });
    expect(started.status).toBe(201);
    expect(started.body.state).toBe('started');

    const finished = await request(app).post('/api/measured/ping').send({ deviceId, gps: fence.border });
    expect(finished.status).toBe(200);
    expect(finished.body.state).toBe('finished');
    expect(Number.isFinite(finished.body.wait)).toBe(true);
    expect(finished.body.gpsVerified).toBe(true);
  });

  it('reports idle when far from any crossing', async () => {
    const res = await request(app).post('/api/measured/ping').send({ deviceId: `far-${Date.now()}`, gps: { lat: 48.2, lng: 16.4 } });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('idle');
  });
});

describe('camera debug + no-false-wait (V5 P0)', () => {
  it('rejects anonymous and returns per-camera evidence for admin', async () => {
    expect([401, 403]).toContain((await request(app).get('/api/admin/camera/debug').query({ crossingId: 'maljevac', direction: 'toBih' })).status);
    const res = await request(app).get('/api/admin/camera/debug').query({ crossingId: 'maljevac', direction: 'toBih' }).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('waitIsCameraDriven');
    expect(res.body).toHaveProperty('cameraEstimateReliable');
    expect(Array.isArray(res.body.cameras)).toBe(true);
    expect(findIllegalJsonValue(res.body, '$')).toBeNull();
  });

  it('a baseline/fallback (no live snapshot) is NOT a reliable camera estimate', async () => {
    // With camera counting disabled in tests there is no live snapshot, so the camera
    // estimate must report itself as not reliable rather than masquerading as a live wait.
    const res = await request(app).get('/api/admin/camera/debug').query({ crossingId: 'svilaj', direction: 'toBih' }).set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.cameraEstimateReliable).toBe(false);
    expect(res.body.waitIsCameraDriven).toBe(false);
  });
});

describe('bias correction model (V5 §2)', () => {
  it('rejects anonymous and returns the model (disabled by default) for admin', async () => {
    expect([401, 403]).toContain((await request(app).get('/api/admin/bias')).status);
    const res = await request(app).get('/api/admin/bias').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body).toHaveProperty('perCrossing');
    expect(findIllegalJsonValue(res.body, '$')).toBeNull();
  });
});

describe('confidence calibration admin endpoints (V5 §7 G)', () => {
  const routes = [
    '/api/admin/confidence/calibration/status',
    '/api/admin/confidence/accuracy',
    '/api/admin/confidence/histogram',
    '/api/admin/confidence/reliability',
  ];
  it('reject anonymous callers', async () => {
    for (const r of routes) expect([401, 403]).toContain((await request(app).get(r)).status);
  });
  it('return calibration status for admin (no fabricated HIGH thresholds)', async () => {
    const res = await request(app).get('/api/admin/confidence/calibration/status').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.minSamplesHigh).toBeGreaterThanOrEqual(30);
    expect(res.body).toHaveProperty('totalResolvedSamples');
    expect(res.body).toHaveProperty('bucketsAvailable');
    expect(findIllegalJsonValue(res.body, '$')).toBeNull();
  });
  it('return per-bucket accuracy, histogram and reliability for admin', async () => {
    for (const r of routes.slice(1)) {
      const res = await request(app).get(r).set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(findIllegalJsonValue(res.body, '$')).toBeNull();
    }
  });
});

describe('confidence calibration: HIGH is impossible without measured proof (V5 §7 A)', () => {
  it('three agreeing booth sources are still capped to srednja with no calibration data', async () => {
    const mod = await import('../../server/index.js');
    const crossing = mod.BORDER_CROSSINGS.maljevac;
    const now = new Date().toISOString();
    const sig = await mod.effectiveBorderSignal(crossing, 'toBih', 'car', { reports: [], overrides: {} }, [
      { sourceType: 'public-text-status', sourceName: 'HAK', normalizedWaitMin: 50, rawStatus: 'Eksplicitno čekanje 50 min', confidence: 90, weight: 1.35, fetchedAt: now, metadata: {} },
      { sourceType: 'public-text-status', sourceName: 'BIHAMK', normalizedWaitMin: 52, rawStatus: 'Eksplicitno čekanje 52 min', confidence: 88, weight: 1.3, fetchedAt: now, metadata: {} },
      { sourceType: 'camera-snapshot-model', sourceName: 'Kamera', normalizedWaitMin: 48, confidence: 70, weight: 0.72, fetchedAt: now, metadata: { queueVehicles: 24, flowVehicles15: 5 } },
    ]);
    // The heuristic may consider this high agreement, but calibration must not grant visoka.
    expect(sig.confidenceLevel).not.toBe('visoka');
    expect(sig.calibration.hasData).toBe(false);
  });
});

describe('best crossing engine (spec §10)', () => {
  it('returns a ranked list and a (possibly null) recommendation', async () => {
    const res = await request(app).get('/api/best-crossing').query({ direction: 'toBih' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.ranked)).toBe(true);
    expect(findIllegalJsonValue(res.body, '$')).toBeNull();
  });
});

describe('alerts (spec §9)', () => {
  it('accepts a subscription', async () => {
    const res = await request(app).post('/api/alerts/subscribe').send({ crossingId: 'maljevac', direction: 'toBih', dropBelow: 30, riseAbove: 60 });
    expect(res.status).toBe(201);
    expect(res.body.subscription.crossingId).toBe('maljevac');
  });
});

describe('admin accuracy + telemetry (spec §7, §11)', () => {
  it('rejects anonymous callers', async () => {
    for (const route of ['/api/admin/accuracy', '/api/admin/telemetry']) {
      const res = await request(app).get(route);
      expect([401, 403]).toContain(res.status);
    }
  });

  it('returns accuracy stats for an admin', async () => {
    const res = await request(app).get('/api/admin/accuracy').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty('overall');
    expect(res.body).toHaveProperty('perCrossing');
    expect(findIllegalJsonValue(res.body, '$')).toBeNull();
  });

  it('returns telemetry for an admin with a confidence distribution', async () => {
    const res = await request(app).get('/api/admin/telemetry').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.confidenceDistribution).toBeTruthy();
    expect(Array.isArray(res.body.crossings)).toBe(true);
    expect(Array.isArray(res.body.cameraHealth)).toBe(true);
    expect(findIllegalJsonValue(res.body, '$')).toBeNull();
  });
});
