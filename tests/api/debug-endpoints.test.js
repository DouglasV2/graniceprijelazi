// Proof that the new debug surfaces are wired into the REAL handlers (not dangling helpers):
//  - GET /api/debug/route-traffic/:crossingId  (Google traffic pipeline, stage by stage)
//  - GET /api/admin/camera/debug               (directional visual-band provenance)
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp, findIllegalJsonValue } from '../helpers/app-loader.js';

let app;
let adminToken;

beforeAll(async () => {
  app = await getApp();
  const mod = await import('../../server/index.js');
  adminToken = mod.signToken({ id: 'admin-access', email: 'admin@borderflow.app', role: 'admin', name: 'Admin' });
});

const auth = (req) => req.set('Authorization', `Bearer ${adminToken}`);

describe('GET /api/debug/route-traffic/:crossingId', () => {
  it('rejects anonymous callers', async () => {
    expect([401, 403]).toContain((await request(app).get('/api/debug/route-traffic/bijaca')).status);
  });

  it('reports honestly when there is no server key (no fake "all clear")', async () => {
    // The test harness runs without GOOGLE_MAPS_SERVER_KEY, so the endpoint must say so
    // explicitly instead of pretending the route is traffic-free.
    const res = await auth(request(app).get('/api/debug/route-traffic/bijaca?direction=toBih'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('googleRequestUsesTraffic');
    expect(res.body).toHaveProperty('usedFallbackRoute', true);
    expect(String(res.body.note)).toMatch(/traffic|Google|nedostup/i);
    expect(findIllegalJsonValue(res.body, '$')).toBeNull();
  });

  it('404s for an unknown crossing', async () => {
    expect((await auth(request(app).get('/api/debug/route-traffic/nepostoji'))).status).toBe(404);
  });
});

describe('GET /api/admin/camera/debug — directional visual-band provenance', () => {
  it('lists every configured camera with usedForDirectionalBand + reason and a finalVisualBand', async () => {
    const res = await auth(request(app).get('/api/admin/camera/debug?crossingId=maljevac&direction=toBih'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('finalVisualBand');
    expect(Array.isArray(res.body.visualBandContributors)).toBe(true);
    expect(res.body.visualBandContributors.length).toBeGreaterThan(0);
    for (const c of res.body.visualBandContributors) {
      expect(c).toHaveProperty('cameraId');
      expect(c).toHaveProperty('usedForDirectionalBand');
      expect(c).toHaveProperty('reason');
      expect(typeof c.usedForDirectionalBand).toBe('boolean');
    }
    // selectedCameraIdsForDirection must equal the contributors actually used for the band.
    const used = res.body.visualBandContributors.filter((c) => c.usedForDirectionalBand).map((c) => c.cameraId).sort();
    expect([...res.body.selectedCameraIdsForDirection].sort()).toEqual(used);
    expect(findIllegalJsonValue(res.body, '$')).toBeNull();
  });

  it('a camera explicit for the OPPOSITE direction is reported as excluded from this direction', async () => {
    // Maljevac has explicit entry/exit cameras; for toBih, the toHr-only camera must be excluded.
    const res = await auth(request(app).get('/api/admin/camera/debug?crossingId=maljevac&direction=toBih'));
    const opposite = res.body.visualBandContributors.filter(
      (c) => Array.isArray(c.validForDirections) && c.validForDirections.length === 1 && c.validForDirections[0] === 'toHr'
    );
    for (const c of opposite) {
      expect(c.usedForDirectionalBand).toBe(false);
      expect(c.reason).toBe('explicit-opposite-direction-excluded');
    }
  });
});

describe('GET /api/admin/traffic-vision/:crossingId/:direction — decision + sourceBreakdown (WHY)', () => {
  it('rejects anonymous callers', async () => {
    expect([401, 403]).toContain((await request(app).get('/api/admin/traffic-vision/maljevac/toBih')).status);
  });

  it('exposes finalEstimate, a per-source breakdown (incl. userReports + verifiedLocation) and a decision reason', async () => {
    const res = await auth(request(app).get('/api/admin/traffic-vision/maljevac/toBih'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('finalEstimateMin');
    expect(res.body).toHaveProperty('finalLabel');
    const sb = res.body.sourceBreakdown;
    expect(sb).toBeTruthy();
    for (const key of ['publicSource', 'googleTraffic', 'camera', 'userReports', 'verifiedLocation']) {
      expect(sb).toHaveProperty(key);
    }
    expect(sb.userReports).toHaveProperty('sampleCount');
    expect(sb.verifiedLocation).toHaveProperty('sampleCount');
    expect(sb.verifiedLocation).toHaveProperty('enabled'); // per-crossing flag visibility
    expect(sb.camera).toHaveProperty('visualBand');
    // Camera signal-path transparency: WHY the camera signal is used or ignored, the canonical
    // camera for this direction, and the analytics wait the fusion saw (no silent visualBand:null).
    expect(typeof sb.camera.reason).toBe('string');
    expect(sb.camera.reason.length).toBeGreaterThan(0);
    expect(sb.camera).toHaveProperty('cameraAnalyticsWait');
    expect(sb.camera).toHaveProperty('visualSnapshotAgeSeconds');
    expect(sb.camera.expectedCameraId).toBe('mal-hak-hr-exit'); // toBih → exit camera
    // The "why": which signal led, what floor, and the readable reason.
    expect(res.body.decision).toHaveProperty('selectedPrimarySignal');
    expect(res.body.decision).toHaveProperty('conflictKind');
    expect(res.body).toHaveProperty('sourceStrength');
    expect(findIllegalJsonValue(res.body, '$')).toBeNull();
  });
});
