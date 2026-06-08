// Maljevac flagship smoke test — proves the production surfaces respond end-to-end (companion to
// docs/MALJEVAC_SMOKE_TEST.md). Live Google/YOLO are not available in CI, so we assert the pipeline
// SHAPES + the local-only pieces, not live magnitudes.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp, findIllegalJsonValue } from '../helpers/app-loader.js';
import { rankCrossingsByLocation } from '../../src/utils/crossing-recommendation.js';

let app;
let adminToken;

beforeAll(async () => {
  app = await getApp();
  const mod = await import('../../server/index.js');
  adminToken = mod.signToken({ id: 'admin-access', email: 'admin@borderflow.app', role: 'admin', name: 'Admin' });
});
const auth = (req) => req.set('Authorization', `Bearer ${adminToken}`);

describe('Maljevac production smoke', () => {
  it('public state exposes Maljevac with cameras + a boolean locationWaitArmed', async () => {
    const res = await request(app).get('/api/public/state');
    expect(res.status).toBe(200);
    const mal = (res.body.crossings || []).find((c) => c.id === 'maljevac');
    expect(mal).toBeTruthy();
    expect(Array.isArray(mal.cameras)).toBe(true);
    expect(typeof mal.locationWaitArmed).toBe('boolean'); // false here (flag off in CI) — must not crash
    expect(findIllegalJsonValue(res.body, '$')).toBeNull();
  });

  it('the prediction signal resolves for BOTH directions with a decision + full sourceBreakdown', async () => {
    for (const direction of ['toBih', 'toHr']) {
      const res = await auth(request(app).get(`/api/admin/traffic-vision/maljevac/${direction}`));
      expect(res.status).toBe(200);
      expect(res.body.crossingId).toBe('maljevac');
      expect(res.body).toHaveProperty('finalEstimateMin');
      for (const k of ['publicSource', 'googleTraffic', 'camera', 'userReports', 'verifiedLocation']) {
        expect(res.body.sourceBreakdown).toHaveProperty(k);
      }
      expect(res.body.decision).toHaveProperty('reason');
      expect(findIllegalJsonValue(res.body, '$')).toBeNull();
    }
  });

  it('directional camera band provenance is available for Maljevac (visual signal path alive)', async () => {
    const res = await auth(request(app).get('/api/admin/camera/debug?crossingId=maljevac&direction=toBih'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('finalVisualBand');
    expect(Array.isArray(res.body.visualBandContributors)).toBe(true);
  });

  it('recommendation ranks Maljevac sensibly from a nearby location (pure)', () => {
    const near = { lat: 45.198, lng: 15.797 };
    const r = rankCrossingsByLocation(near, [
      { id: 'maljevac', name: 'Maljevac', lat: 45.196, lng: 15.796, waitMin: 30, confidence: 'srednja' },
      { id: 'far', name: 'Far', lat: 45.9, lng: 17.2, waitMin: 10, confidence: 'visoka' },
    ]);
    expect(r.best.id).toBe('maljevac'); // closest dominates total cost despite higher wait
    expect(r.best.badges).toContain('Najbrže ukupno');
  });
});
