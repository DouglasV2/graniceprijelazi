// Web honesty / data-contract tests (V5 §8): the contract the UI relies on to never lie —
// no false camera estimate, no false HIGH, range below high confidence, "nedovoljno podataka"
// when there is no signal, honest stale labels, and an admin debug surface.
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

describe('GET /api/public/state honesty contract', () => {
  it('every wait source is honest: range below high confidence, never visoka without calibration, nedovoljno when no signal', async () => {
    const res = await request(app).get('/api/public/state');
    expect(res.status).toBe(200);
    const sources = res.body.waitSources || {};
    for (const [key, meta] of Object.entries(sources)) {
      if (meta.displayReady === false) {
        // No live signal → must say "Nedovoljno podataka", never a confident number.
        expect(meta.confidenceLevel === 'nedovoljno' || /nedovoljno/i.test(meta.label || '') || meta.sourceType === 'no-live-source', `${key} should be insufficient`).toBeTruthy();
      } else {
        // Live → must carry a calibrated level + precision, and CANNOT be HIGH without
        // measured calibration data (none in tests).
        expect(meta.confidenceLevel, `${key} missing confidenceLevel`).toBeTruthy();
        expect(meta.precision, `${key} missing precision`).toBeTruthy();
        expect(meta.confidenceLevel, `${key} must not be visoka without calibration`).not.toBe('visoka');
        if (meta.confidenceLevel !== 'visoka') expect(meta.precision).toBe('range');
      }
      // Freshness contract for the stale label.
      expect(meta).toHaveProperty('ageSeconds');
      expect(meta).toHaveProperty('stale');
    }
    expect(findIllegalJsonValue(res.body, '$')).toBeNull();
  });
});

describe('GET /api/admin/overview (debug surface)', () => {
  it('rejects anonymous callers', async () => {
    expect([401, 403]).toContain((await request(app).get('/api/admin/overview')).status);
  });

  it('returns ROI readiness, calibration, conflicts and stale sources for admin', async () => {
    const res = await request(app).get('/api/admin/overview').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.yolo.enabled).toBe(false); // YOLO stays OFF in fusion
    expect(res.body).toHaveProperty('confidenceDistribution');
    expect(res.body).toHaveProperty('calibration');
    expect(res.body.roiReadiness).toHaveProperty('needsManualConfigBeforeYolo');
    expect(Array.isArray(res.body.conflicts)).toBe(true);
    expect(Array.isArray(res.body.staleSources)).toBe(true);
    // ROI readiness must flag the known un-configured cameras (Maljevac/Bijača HAK lack ROI).
    expect(res.body.roiReadiness.missingQueueRoi).toContain('maljevac/mal-hak-hr-entry');
    expect(findIllegalJsonValue(res.body, '$')).toBeNull();
  });

  it('confidence distribution has no fabricated HIGH bucket without calibration data', async () => {
    const res = await request(app).get('/api/admin/overview').set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.confidenceDistribution.visoka).toBe(0);
  });
});
