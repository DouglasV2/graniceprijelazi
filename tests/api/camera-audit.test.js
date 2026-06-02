// Full camera sanity audit (every crossing / camera / direction). Treats the
// Maljevac/Svilaj false-wait as a CLASS of problem, not a per-crossing hardcode.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp, findIllegalJsonValue } from '../helpers/app-loader.js';

let app;
let adminToken;
let CAMERA_FEEDS;

beforeAll(async () => {
  app = await getApp();
  const mod = await import('../../server/index.js');
  adminToken = mod.signToken({ id: 'admin-access', email: 'admin@borderflow.app', role: 'admin', name: 'Admin' });
  CAMERA_FEEDS = mod.CAMERA_FEEDS;
});

const auth = (req) => req.set('Authorization', `Bearer ${adminToken}`);

describe('GET /api/admin/camera/audit', () => {
  it('rejects anonymous callers', async () => {
    expect([401, 403]).toContain((await request(app).get('/api/admin/camera/audit')).status);
  });

  it('returns every configured camera × direction with a known status', async () => {
    const res = await auth(request(app).get('/api/admin/camera/audit'));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const totalFeeds = Object.values(CAMERA_FEEDS).reduce((sum, list) => sum + list.length, 0);
    // Each camera appears for both directions.
    expect(res.body.cameras.length).toBe(totalFeeds * 2);
    for (const c of res.body.cameras) {
      expect(['wait-capable', 'visual-only', 'stale/unavailable', 'missing-config']).toContain(c.mode);
      expect(c).toHaveProperty('warnings');
      expect(c).toHaveProperty('recommendation');
    }
    expect(findIllegalJsonValue(res.body, '$')).toBeNull();
  });

  it('provides a global health summary', async () => {
    const res = await auth(request(app).get('/api/admin/camera/audit'));
    const s = res.body.summary;
    expect(s).toHaveProperty('totalEntries');
    expect(s).toHaveProperty('waitCapable');
    expect(s).toHaveProperty('visualOnly');
    expect(s).toHaveProperty('safeForFusion');
    expect(s).toHaveProperty('excludedFromFusion');
    expect(Array.isArray(s.topRisky)).toBe(true);
  });

  it('a camera without a declared direction is visual-only (never wait-capable)', async () => {
    const res = await auth(request(app).get('/api/admin/camera/audit').query({ crossingId: 'maljevac' }));
    const wide = res.body.cameras.find((c) => c.cameraId === 'mal-bihamk-kladusa');
    expect(wide).toBeTruthy();
    expect(wide.visualOnly).toBe(true);
    expect(wide.waitCapable).toBe(false);
    expect(wide.warnings).toContain('direction_not_verified');
  });

  it('in test mode (no live snapshots) no camera is wait-capable and none drive the wait', async () => {
    const res = await auth(request(app).get('/api/admin/camera/audit'));
    // No camera may be marked reliable / wait-driving without a fresh real snapshot.
    expect(res.body.cameras.every((c) => c.cameraEstimateReliable === false)).toBe(true);
    expect(res.body.cameras.every((c) => c.waitIsCameraDriven === false)).toBe(true);
    expect(res.body.cameras.some((c) => c.warnings.includes('no_recent_snapshot'))).toBe(true);
  });

  it('onlyProblems=true returns only cameras that have warnings', async () => {
    const res = await auth(request(app).get('/api/admin/camera/audit').query({ onlyProblems: 'true' }));
    expect(res.body.cameras.every((c) => c.warnings.length > 0)).toBe(true);
  });

  it('can filter by crossing and direction', async () => {
    const res = await auth(request(app).get('/api/admin/camera/audit').query({ crossingId: 'gradiska', direction: 'toBih' }));
    expect(res.body.cameras.every((c) => c.crossingId === 'gradiska' && c.direction === 'toBih')).toBe(true);
  });
});
