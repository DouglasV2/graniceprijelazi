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
