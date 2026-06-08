// Production release-gate endpoints: cv-health + readiness. Both are internal (TRAFFIC_VISION_DEBUG
// flag + admin/token). In the test env there is no CV endpoint, so cv-health is "missing-endpoint"
// and readiness must be FALSE with explicit reasons — proving we never flip PREDICTION_V2 on vibes.
process.env.TRAFFIC_VISION_DEBUG = 'true';
process.env.TRAFFIC_VISION_DEBUG_TOKEN = 'tv-readiness-test-token';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

let app;
const TOKEN = 'tv-readiness-test-token';

beforeAll(async () => {
  const mod = await import('../../server/index.js');
  await mod.initializeDatastore();
  app = mod.app;
});

afterAll(() => {
  delete process.env.TRAFFIC_VISION_DEBUG;
  delete process.env.TRAFFIC_VISION_DEBUG_TOKEN;
});

describe('GET /api/internal/traffic-vision/cv-health', () => {
  it('is invisible without the token (401), not a user-readable 200', async () => {
    expect((await request(app).get('/api/internal/traffic-vision/cv-health')).status).toBe(401);
  });
  it('reports missing-endpoint honestly when no CV endpoint is configured', async () => {
    const res = await request(app).get('/api/internal/traffic-vision/cv-health').set('x-debug-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(false);
    expect(res.body.status).toBe('missing-endpoint');
    expect(res.body.endpointConfigured).toBe(false);
  });
});

describe('GET /api/internal/traffic-vision/readiness', () => {
  it('is gated', async () => {
    expect((await request(app).get('/api/internal/traffic-vision/readiness')).status).toBe(401);
  });
  it('returns readyForPredictionV2Headline=false with concrete reasons + thresholds', async () => {
    const res = await request(app).get('/api/internal/traffic-vision/readiness').set('x-debug-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.readyForPredictionV2Headline).toBe(false);
    expect(Array.isArray(res.body.reasons)).toBe(true);
    expect(res.body.reasons.length).toBeGreaterThan(0);
    // CV endpoint missing must be one of the blockers in the test env.
    expect(res.body.reasons.join(' ')).toMatch(/CV\/YOLO|endpoint/i);
    expect(res.body.checks).toHaveProperty('keyCamerasWithRoiPercent');
    expect(res.body.thresholds).toHaveProperty('minRoiCoveragePercent');
    // The gate and the live flag agree that v2 is not driving the headline yet.
    expect(res.body.predictionV2Enabled).toBe(false);
  });
});

describe('Maljevac calibration / ground-truth (the way we KNOW the estimate is good)', () => {
  it('ground-truth + calibration endpoints are gated', async () => {
    expect((await request(app).post('/api/internal/traffic-vision/ground-truth').send({ crossingId: 'maljevac', direction: 'toBih', observedWaitMin: 60 })).status).toBe(401);
    expect((await request(app).get('/api/internal/traffic-vision/calibration?crossingId=maljevac')).status).toBe(401);
  });
  it('records a manual ground-truth wait for Maljevac', async () => {
    const res = await request(app).post('/api/internal/traffic-vision/ground-truth')
      .set('x-debug-token', TOKEN)
      .send({ crossingId: 'maljevac', direction: 'toBih', observedWaitMin: 65, source: 'test-drive', note: 'queue past the booth' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.observedWaitMin).toBe(65);
    expect(typeof res.body.matched).toBe('boolean');
  });
  it('rejects an out-of-range observed wait', async () => {
    const res = await request(app).post('/api/internal/traffic-vision/ground-truth')
      .set('x-debug-token', TOKEN)
      .send({ crossingId: 'maljevac', direction: 'toBih', observedWaitMin: 999 });
    expect(res.status).toBe(400);
  });
  it('calibration returns metrics + the recorded ground-truth shows up resolved', async () => {
    const res = await request(app).get('/api/internal/traffic-vision/calibration?crossingId=maljevac&hours=72').set('x-debug-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.crossingId).toBe('maljevac');
    expect(res.body.resolvedSize).toBeGreaterThanOrEqual(1); // the ground-truth we just recorded
    expect(res.body.stats).toHaveProperty('overall');
    expect(res.body.qualityTargets.p50MaxMin).toBe(10);
    expect(Array.isArray(res.body.recentSnapshots)).toBe(true);
  });
});
