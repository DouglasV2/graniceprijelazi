// Production CV scaling safety: bounded concurrency, no overlapping refresh, bounded caches, the
// per-crossing CV readiness endpoint, and detector-failure semantics (failure ≠ "0 vehicles").
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { getApp } from '../helpers/app-loader.js';

const root = join(process.cwd());
const server = readFileSync(join(root, 'server', 'index.js'), 'utf8');
const cvPy = readFileSync(join(root, 'cv-detector', 'app.py'), 'utf8');

let app;
let adminToken;
beforeAll(async () => {
  app = await getApp();
  const mod = await import('../../server/index.js');
  adminToken = mod.signToken({ id: 'admin-access', email: 'admin@borderflow.app', role: 'admin', name: 'Admin' });
});
const auth = (req) => req.set('Authorization', `Bearer ${adminToken}`);

describe('main app — bounded CV/refresh concurrency + no overlap', () => {
  it('a global CV inference semaphore gates every YOLO call', () => {
    expect(server).toMatch(/const cvInferenceSemaphore = new AsyncSemaphore\(CAMERA_CV_CONCURRENCY\)/);
    expect(server).toMatch(/return cvInferenceSemaphore\.run\(async \(\) => \{/);
  });
  it('the refresh fan-out is bounded (mapWithConcurrency, not Promise.all of every camera)', () => {
    expect(server).toMatch(/mapWithConcurrency\(jobs, CAMERA_REFRESH_CONCURRENCY/);
  });
  it('a full refresh cannot overlap another (in-flight guard applies to forced refresh too)', () => {
    expect(server).toMatch(/if \(sourceRefreshState\.running\) return sourceRefreshState\.running;/);
  });
  it('the resolved-image cache is bounded (no unbounded growth as cameras are added)', () => {
    expect(server).toMatch(/resolvedCameraImageCache\.size >= 500/);
  });
});

describe('cv-detector — failure semantics + safety knobs', () => {
  it('image-load failure returns 502 (NOT a 200 fake-empty)', () => {
    expect(cvPy).toMatch(/raise HTTPException\(status_code=502/);
  });
  it('inference error returns 503 (recoverable OOM ≠ 0 vehicles)', () => {
    expect(cvPy).toMatch(/raise HTTPException\(status_code=503, detail="inference-failed"\)/);
  });
  it('bounded inference concurrency + imgsz cap are env-controlled', () => {
    expect(cvPy).toMatch(/CV_MAX_CONCURRENCY/);
    expect(cvPy).toMatch(/CV_IMGSZ/);
    expect(cvPy).toMatch(/_infer_sema = threading\.BoundedSemaphore/);
  });
  it('the model is loaded once (singleton under a lock), and /health exposes ops stats', () => {
    expect(cvPy).toMatch(/with _model_lock:/);
    expect(cvPy).toMatch(/"failedRequests"/);
    expect(cvPy).toMatch(/"memoryMb"/);
    expect(cvPy).toMatch(/"lastInferenceMs"/);
  });
});

describe('GET /api/admin/cv-readiness — per-crossing rollout view', () => {
  it('rejects anonymous', async () => {
    expect([401, 403]).toContain((await request(app).get('/api/admin/cv-readiness')).status);
  });
  it('returns cv-detector health + concurrency + per-direction camera signal for the batch', async () => {
    const res = await auth(request(app).get('/api/admin/cv-readiness'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cvDetector');
    expect(res.body).toHaveProperty('refreshConcurrency');
    expect(res.body).toHaveProperty('cvConcurrency');
    const ids = (res.body.crossings || []).map((c) => c.crossingId);
    expect(ids).toEqual(expect.arrayContaining(['maljevac', 'gornji-varos']));
    const mal = res.body.crossings.find((c) => c.crossingId === 'maljevac');
    expect(Array.isArray(mal.cameras)).toBe(true);
    expect(mal.cameras[0]).toHaveProperty('roiExists');
    for (const direction of ['toBih', 'toHr']) {
      const d = mal.directions[direction];
      expect(d).toHaveProperty('finalEstimateMin');
      expect(d).toHaveProperty('visualBand');
      expect(d).toHaveProperty('usedInFusion');
      expect(d).toHaveProperty('cvStatus');
      expect(d).toHaveProperty('reason');
    }
  });
  it('scopes to one crossing when ?crossingId= is given, 404 for unknown', async () => {
    const one = await auth(request(app).get('/api/admin/cv-readiness?crossingId=gornji-varos'));
    expect(one.body.crossings.length).toBe(1);
    expect((await auth(request(app).get('/api/admin/cv-readiness?crossingId=nepostoji'))).status).toBe(404);
  });
});
