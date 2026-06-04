// Internal ROI editor / camera-debug endpoints. These must be INVISIBLE to normal users (flag off
// → 404) and, when enabled, gated by an admin session OR a matching debug token. We enable the flag
// at module-eval time (this file gets its own module graph under vitest forks+isolate) so we can
// exercise the gated behaviour. Only network-free paths are tested (no live camera fetch / YOLO).
process.env.YOLO_ROI_EDITOR_ENABLED = 'true';
process.env.TRAFFIC_VISION_DEBUG_TOKEN = 'roi-editor-test-token';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let app;
let adminToken;
const TOKEN = 'roi-editor-test-token';
const OVERRIDES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'camera-roi-overrides.json');
let overridesBackup = null;

beforeAll(async () => {
  const mod = await import('../../server/index.js');
  await mod.initializeDatastore();
  app = mod.app;
  adminToken = mod.signToken({ id: 'admin-access', email: 'admin@borderflow.app', role: 'admin', name: 'Admin' });
  overridesBackup = existsSync(OVERRIDES) ? readFileSync(OVERRIDES, 'utf8') : null;
});

afterAll(() => {
  // Restore the overrides file to its pre-test state (the PUT test writes a runtime override).
  try {
    if (overridesBackup === null) { if (existsSync(OVERRIDES)) unlinkSync(OVERRIDES); }
    else writeFileSync(OVERRIDES, overridesBackup);
  } catch { /* best effort */ }
  delete process.env.YOLO_ROI_EDITOR_ENABLED;
  delete process.env.TRAFFIC_VISION_DEBUG_TOKEN;
});

const sq = [{ x: 0.1, y: 0.4 }, { x: 0.8, y: 0.4 }, { x: 0.8, y: 0.95 }, { x: 0.1, y: 0.95 }];

describe('ROI editor shell (/internal/roi-editor)', () => {
  it('serves the standalone editor HTML when the flag is on, marked noindex', async () => {
    const res = await request(app).get('/internal/roi-editor');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/ROI editor/);
    expect(res.text).toMatch(/noindex/);
  });
});

describe('ROI editor data endpoints are token/admin gated', () => {
  it('rejects anonymous callers (no token, no admin) with 401 — NOT a user-visible 200', async () => {
    expect((await request(app).get('/api/internal/traffic-vision/roi-audit')).status).toBe(401);
  });
  it('rejects a wrong debug token', async () => {
    expect((await request(app).get('/api/internal/traffic-vision/roi-audit').set('x-debug-token', 'nope')).status).toBe(401);
  });
  it('allows a correct debug token and lists cameras with ROI status', async () => {
    const res = await request(app).get('/api/internal/traffic-vision/roi-audit').set('x-debug-token', TOKEN);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.cameras)).toBe(true);
    expect(res.body.cameras.length).toBeGreaterThan(0);
    const c = res.body.cameras[0];
    expect(c).toHaveProperty('cameraId');
    expect(c).toHaveProperty('roiSource');
    expect(res.body).toHaveProperty('roiV2Enabled');
  });
  it('allows an admin session (no debug token header)', async () => {
    const res = await request(app).get('/api/internal/traffic-vision/roi-audit').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
  it('404s a roi-debug request for an unknown camera (network-free)', async () => {
    const res = await request(app).get('/api/internal/traffic-vision/roi-debug/does-not-exist').set('x-debug-token', TOKEN);
    expect(res.status).toBe(404);
  });
});

describe('PUT roi-config validation + persistence', () => {
  it('rejects an invalid polygon with 400 (no write)', async () => {
    const res = await request(app).put('/api/internal/traffic-vision/roi-config/mal-hak-hr-exit')
      .set('x-debug-token', TOKEN)
      .send({ queuePolygon: [{ x: 0.1, y: 0.1 }], direction: 'toBih' });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.errors)).toBe(true);
  });
  it('saves a valid override and returns a STATIC_ROI_CONFIGS snippet to commit', async () => {
    const res = await request(app).put('/api/internal/traffic-vision/roi-config/mal-hak-hr-exit')
      .set('x-debug-token', TOKEN)
      .send({ queuePolygon: sq, ignorePolygons: [], direction: 'toBih', cameraReliability: 0.7 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.persistence).toBe('runtime-override');
    expect(res.body.staticSnippet).toHaveProperty('mal-hak-hr-exit');
    expect(res.body.config.queuePolygon.length).toBe(4);
  });
});

describe('roi-test previews a candidate config against provided detections (network-free)', () => {
  it('counts only in-queue vehicles for the candidate polygon', async () => {
    const detections = [
      { type: 'car', x: 50, y: 70, w: 6, h: 6 },   // in queue
      { type: 'car', x: 92, y: 12, w: 6, h: 6 },    // outside
    ];
    const res = await request(app).post('/api/internal/traffic-vision/roi-test/mal-hak-hr-exit')
      .set('x-debug-token', TOKEN)
      .send({ direction: 'toBih', roiConfig: { queuePolygon: sq, ignorePolygons: [] }, detections, imageMeta: { width: 1280, height: 720, coordSpace: 'percent' } });
    expect(res.status).toBe(200);
    expect(res.body.usedProvidedDetections).toBe(true);
    expect(res.body.roiFeatures.visibleVehicleCount).toBe(2);
    expect(res.body.roiFeatures.vehiclesInQueueRoi).toBe(1);
  });
});
