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
