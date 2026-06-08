// Gornji Varoš production audit/regression — same model as Maljevac. Verifies identity, that the
// camera VISUAL band reaches the Traffic Vision fusion, the false-low guard holds (medium/large
// band → elevated wait; Google clear can't overwrite), reports payload, and that the generic reset
// is scoped to Gornji Varoš only (Maljevac untouched).
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp } from '../helpers/app-loader.js';
import { effectiveBorderSignal, BORDER_CROSSINGS, CAMERA_FEEDS, initializeDatastore, inferCameraDirections } from '../../server/index.js';

let app;
let adminToken;
const CID = 'gornji-varos';

beforeAll(async () => {
  app = await getApp();
  await initializeDatastore();
  const mod = await import('../../server/index.js');
  adminToken = mod.signToken({ id: 'admin-access', email: 'admin@borderflow.app', role: 'admin', name: 'Admin' });
});
const auth = (req) => req.set('Authorization', `Bearer ${adminToken}`);

const cleanStore = () => ({ users: [], overrides: {}, statusOverrides: {}, reports: [], audit: [], routeSearches: [], historySnapshots: [], sourceSnapshots: [] });
const cameraVisual = (direction, band, occupancyPct = 62) => ({
  crossingId: CID, direction, sourceName: 'Kamera vizualna provjera', sourceType: 'camera-visual',
  rawWaitMin: null, normalizedWaitMin: null, confidence: 60, weight: 0,
  metadata: { queueBand: band, queueBandLabel: `${band} kolona`, occupancyPct, cameraIds: ['gv-hak-queue-9'] },
  fetchedAt: new Date().toISOString(),
});
const googleClear = (direction) => ({
  crossingId: CID, direction, sourceName: 'Google promet', sourceType: 'google-traffic-estimate',
  rawWaitMin: 0, normalizedWaitMin: 0, confidence: 70, weight: 1, metadata: { severity: 'clear', delayMin: 0 },
  fetchedAt: new Date().toISOString(),
});

describe('Gornji Varoš — identity + camera mapping', () => {
  it('crossing exists with the right id/name/directions', () => {
    const c = BORDER_CROSSINGS[CID];
    expect(c).toBeTruthy();
    expect(c.id).toBe(CID);
    expect(c.name).toMatch(/Gornji Varoš/);
    expect(c.anchors.toBih).toBeTruthy();
    expect(c.anchors.toHr).toBeTruthy();
  });
  it('has HAK cameras that are AMBIGUOUS (visual-only) — labels do not infer a direction', () => {
    const feeds = CAMERA_FEEDS[CID] || [];
    expect(feeds.map((c) => c.id)).toEqual(expect.arrayContaining(['gv-hak-queue-9', 'gv-hak-plaza-4']));
    for (const cam of feeds) {
      // No explicit/derivable direction → visual-only (cannot drive a hard wait, only the visual band).
      expect(inferCameraDirections(cam)).toBeNull();
    }
  });
});

describe('Gornji Varoš — camera signal reaches fusion + false-low guard', () => {
  it('srednja camera-visual band + Google clear → visualBand set, wait elevated (not 0/3/5)', async () => {
    for (const direction of ['toBih', 'toHr']) {
      const sig = await effectiveBorderSignal(BORDER_CROSSINGS[CID], direction, 'car', cleanStore(), [cameraVisual(direction, 'srednja'), googleClear(direction)]);
      expect(sig.visualBand).toBe('srednja');
      expect(sig.sourceType).toBe('camera-congestion-override');
      expect(sig.wait).toBeGreaterThanOrEqual(20); // Google clear CANNOT overwrite the camera floor
    }
  });
  it('velika band commits even higher', async () => {
    const sig = await effectiveBorderSignal(BORDER_CROSSINGS[CID], 'toBih', 'car', cleanStore(), [cameraVisual('toBih', 'velika'), googleClear('toBih')]);
    expect(sig.wait).toBeGreaterThanOrEqual(30);
  });
  it('mala band → no congestion override/label (no false-low fabrication of "Gužva")', async () => {
    const sig = await effectiveBorderSignal(BORDER_CROSSINGS[CID], 'toBih', 'car', cleanStore(), [cameraVisual('toBih', 'mala', 20), googleClear('toBih')]);
    expect(sig.cameraCongestionOverride).toBeFalsy();
    expect(sig.label).not.toBe('Gužva — prema kameri');
  });
});

describe('Gornji Varoš — admin debug', () => {
  it('traffic-vision debug works for both directions with sourceBreakdown + decision', async () => {
    for (const direction of ['toBih', 'toHr']) {
      const res = await auth(request(app).get(`/api/admin/traffic-vision/${CID}/${direction}`));
      expect(res.status).toBe(200);
      expect(res.body.crossingId).toBe(CID);
      expect(res.body).toHaveProperty('finalEstimateMin');
      for (const k of ['publicSource', 'googleTraffic', 'camera', 'userReports', 'verifiedLocation']) {
        expect(res.body.sourceBreakdown).toHaveProperty(k);
      }
      expect(typeof res.body.sourceBreakdown.camera.reason).toBe('string');
      // No explicit per-direction camera → expectedCameraId is null (audit caveat), surfaced honestly.
      expect(res.body.sourceBreakdown.camera).toHaveProperty('expectedCameraId');
      expect(res.body.decision).toHaveProperty('reason');
    }
  });
});

describe('Gornji Varoš — reports payload', () => {
  it('a report stores the right crossingId + direction + explicit waitMinutes', async () => {
    const res = await auth(request(app).post('/api/reports')).send({ crossingId: CID, direction: 'toHr', type: 'ok', waitMinutes: 40 });
    expect(res.status).toBe(201);
    expect(res.body.report.crossingId).toBe(CID);
    expect(res.body.report.direction).toBe('toHr');
    expect(res.body.report.wait).toBe(40);
  });
});

describe('Gornji Varoš — generic reset is scoped (Maljevac untouched)', () => {
  it('dry-run reports counts and deletes nothing', async () => {
    await auth(request(app).post('/api/reports')).send({ crossingId: CID, direction: 'toBih', type: 'slow', waitMinutes: 50 });
    const dry = await auth(request(app).post(`/api/admin/crossings/${CID}/reset-operational-data`));
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.runtime.before.reports).toBeGreaterThanOrEqual(1);
  });
  it('apply clears Gornji Varoš reports but NOT Maljevac', async () => {
    await auth(request(app).post('/api/reports')).send({ crossingId: 'maljevac', direction: 'toBih', type: 'slow', waitMinutes: 60 });
    const applied = await auth(request(app).post(`/api/admin/crossings/${CID}/reset-operational-data`)).send({ apply: true });
    expect(applied.body.applied).toBe(true);
    expect(applied.body.runtime.after.reports).toBe(0);
    // Maljevac report survives.
    const mal = await auth(request(app).get('/api/reports?crossingId=maljevac'));
    expect(mal.body.reports.length).toBeGreaterThanOrEqual(1);
    expect(applied.body.preserved).toEqual(expect.arrayContaining(['borderflow_users', 'borderflow_camera_roi_configs']));
  });
  it('404 for an unknown crossing', async () => {
    expect((await auth(request(app).post('/api/admin/crossings/nepostoji/reset-operational-data'))).status).toBe(404);
  });
});
