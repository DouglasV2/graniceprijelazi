// ROI calibration → trusted: saving a reviewed polygon via the editor must make the ROI TRUSTED
// (so the YOLO vehicle COUNT drives the wait), and the save response must confirm it. A whole-frame
// polygon still saves but is flagged with a warning (it's not a real queue-ROI).
process.env.YOLO_ROI_EDITOR_ENABLED = 'true';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { getApp } from '../helpers/app-loader.js';

let app;
let adminToken;
// This test saves real ROI overrides (file mode → data/camera-roi-overrides.json). Capture the
// pre-test state and restore it in afterAll so the test never leaves a (whole-frame) "trusted" ROI
// on disk that the running app would pick up.
const OVERRIDES_PATH = join(process.cwd(), 'data', 'camera-roi-overrides.json');
let overridesExisted = false;
let overridesBackup = null;

beforeAll(async () => {
  overridesExisted = existsSync(OVERRIDES_PATH);
  overridesBackup = overridesExisted ? readFileSync(OVERRIDES_PATH, 'utf8') : null;
  app = await getApp();
  const mod = await import('../../server/index.js');
  adminToken = mod.signToken({ id: 'admin-access', email: 'admin@borderflow.app', role: 'admin', name: 'Admin' });
});
afterAll(() => {
  delete process.env.YOLO_ROI_EDITOR_ENABLED;
  // Restore the override file to its pre-test state (don't leave test polygons on disk).
  if (overridesExisted) writeFileSync(OVERRIDES_PATH, overridesBackup);
  else rmSync(OVERRIDES_PATH, { force: true });
});
const auth = (req) => req.set('Authorization', `Bearer ${adminToken}`);

const TIGHT_POLY = [{ x: 0.12, y: 0.30 }, { x: 0.52, y: 0.30 }, { x: 0.52, y: 0.82 }, { x: 0.12, y: 0.82 }];
const WHOLE_FRAME = [{ x: 0.01, y: 0.01 }, { x: 0.99, y: 0.01 }, { x: 0.99, y: 0.99 }, { x: 0.01, y: 0.99 }];

describe('ROI editor — reviewed save becomes trusted', () => {
  it('is gated (404 when disabled is covered elsewhere; here 401 without admin/token)', async () => {
    const res = await request(app).put('/api/internal/traffic-vision/roi-config/gv-hak-queue-9').send({ queuePolygon: TIGHT_POLY });
    expect([401, 403]).toContain(res.status);
  });

  it('saving a tight reviewed polygon → roiTrusted:true + confirming note', async () => {
    const res = await auth(request(app).put('/api/internal/traffic-vision/roi-config/gv-hak-queue-9'))
      .send({ crossingId: 'gornji-varos', direction: 'toHr', queuePolygon: TIGHT_POLY });
    expect(res.status).toBe(200);
    expect(res.body.roiTrusted).toBe(true);
    expect(res.body.warning == null).toBe(true);
    expect(String(res.body.note)).toMatch(/TRUSTED/);
  });

  it('a whole-frame polygon still saves but is flagged (not a real queue-ROI)', async () => {
    const res = await auth(request(app).put('/api/internal/traffic-vision/roi-config/gv-hak-plaza-4'))
      .send({ crossingId: 'gornji-varos', direction: 'toHr', queuePolygon: WHOLE_FRAME });
    expect(res.status).toBe(200);
    expect(res.body.roiTrusted).toBe(true);
    expect(String(res.body.warning)).toMatch(/>85%|uska kolona/i);
  });

  it('rejects an invalid polygon (<3 points)', async () => {
    const res = await auth(request(app).put('/api/internal/traffic-vision/roi-config/gv-hak-queue-9'))
      .send({ queuePolygon: [{ x: 0.1, y: 0.1 }] });
    expect(res.status).toBe(400);
  });

  it('roi-audit lists the Gornji Varoš cameras for the editor picker', async () => {
    const res = await auth(request(app).get('/api/internal/traffic-vision/roi-audit'));
    expect(res.status).toBe(200);
    const ids = (res.body.cameras || []).map((c) => c.cameraId);
    expect(ids).toEqual(expect.arrayContaining(['gv-hak-queue-9', 'gv-hak-plaza-4']));
  });
});
