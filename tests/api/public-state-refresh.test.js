// Refresh-pipeline contract for /api/public/state (the "no stale data" requirement).
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp } from '../helpers/app-loader.js';

let app;
beforeAll(async () => { app = await getApp(); });

describe('GET /api/public/state refresh metadata + cache headers', () => {
  it('always sends Cache-Control: no-store (no cached border estimate)', async () => {
    const res = await request(app).get('/api/public/state');
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('exposes refresh metadata the UI needs to detect stale data', async () => {
    const res = await request(app).get('/api/public/state');
    const sr = res.body.sourceRefresh || {};
    expect(sr).toHaveProperty('running');
    expect(sr).toHaveProperty('refreshedInThisRequest');
    expect(sr).toHaveProperty('ageSeconds');
    expect(sr).toHaveProperty('lastFinishedAt');
    expect(typeof sr.refreshedInThisRequest).toBe('boolean');
  });

  it('?refresh=sync awaits the refresh and still returns effectiveWaits (no error, fresh build)', async () => {
    const res = await request(app).get('/api/public/state?refresh=sync&t=123');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.effectiveWaits).toBeTruthy();
    // refreshedInThisRequest is a boolean decided AFTER awaiting the refresh (not left pending).
    expect(typeof res.body.sourceRefresh.refreshedInThisRequest).toBe('boolean');
    // After a sync await, no refresh should still be flagged as running mid-response.
    expect(res.body.sourceRefresh.running).toBe(false);
  });
});
