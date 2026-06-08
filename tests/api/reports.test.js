// /api/reports must persist the EXPLICIT waitMinutes the driver reported (not silently replace it
// with the category default), while staying backward-compatible when no minutes are sent.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp } from '../helpers/app-loader.js';

let app;
let userToken;

beforeAll(async () => {
  app = await getApp();
  const mod = await import('../../server/index.js');
  // verifyToken requires the subject to exist in the store → use the seeded account. The reports
  // endpoint only needs authRequired (not admin), so this identity is sufficient to exercise it.
  userToken = mod.signToken({ id: 'admin-access', email: 'admin@borderflow.app', role: 'admin', name: 'Admin' });
});
const auth = (req) => req.set('Authorization', `Bearer ${userToken}`);

describe('POST /api/reports — explicit waitMinutes', () => {
  it('rejects anonymous callers', async () => {
    const res = await request(app).post('/api/reports').send({ crossingId: 'maljevac', direction: 'toBih', waitMinutes: 30 });
    expect([401, 403]).toContain(res.status);
  });

  it('stores the explicit waitMinutes (30) even when the category default differs (ok=12)', async () => {
    const res = await auth(request(app).post('/api/reports')).send({ crossingId: 'maljevac', direction: 'toBih', type: 'ok', waitMinutes: 30 });
    expect(res.status).toBe(201);
    expect(res.body.report.wait).toBe(30);
    expect(res.body.report.crossingId).toBe('maljevac');
    expect(res.body.report.direction).toBe('toBih');
  });

  it('falls back to the category default when no waitMinutes is sent (slow=65)', async () => {
    const res = await auth(request(app).post('/api/reports')).send({ crossingId: 'maljevac', direction: 'toHr', type: 'slow' });
    expect(res.status).toBe(201);
    expect(res.body.report.wait).toBe(65);
    expect(res.body.report.direction).toBe('toHr');
  });

  it('clamps an absurd waitMinutes into range (0–360)', async () => {
    const res = await auth(request(app).post('/api/reports')).send({ crossingId: 'maljevac', direction: 'toBih', type: 'ok', waitMinutes: 99999 });
    expect(res.body.report.wait).toBe(360);
  });

  it('rejects an unknown crossing', async () => {
    const res = await auth(request(app).post('/api/reports')).send({ crossingId: 'nepostoji', direction: 'toBih', waitMinutes: 30 });
    expect(res.status).toBe(400);
  });
});
