// Maljevac-only operational reset must clear Maljevac's stale data WITHOUT touching other crossings,
// users, or ROI configs — and the EMA smoothing must not pin a stale-low value after a real jump.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getApp } from '../helpers/app-loader.js';
import { emaSmoothWait } from '../../server/index.js';

let app;
let adminToken;
let otherCrossingId;

beforeAll(async () => {
  app = await getApp();
  const mod = await import('../../server/index.js');
  adminToken = mod.signToken({ id: 'admin-access', email: 'admin@borderflow.app', role: 'admin', name: 'Admin' });
  const state = await request(app).get('/api/public/state');
  otherCrossingId = (state.body.crossings || []).map((c) => c.id).find((id) => id && id !== 'maljevac');
});
const auth = (req) => req.set('Authorization', `Bearer ${adminToken}`);

// Admin overrides are authoritative + persist in the shared JSON store; clear everything this
// suite seeded so it never lingers into other suites (e.g. the public-state honesty contract).
afterAll(async () => {
  const keys = ['maljevac:toBih', 'maljevac:toHr', otherCrossingId ? `${otherCrossingId}:toBih` : null].filter(Boolean);
  for (const key of keys) await auth(request(app).post('/api/admin/overrides')).send({ key, value: '' });
});

describe('POST /api/admin/maljevac/reset-operational-data', () => {
  it('rejects anonymous callers', async () => {
    expect([401, 403]).toContain((await request(app).post('/api/admin/maljevac/reset-operational-data')).status);
  });

  it('DRY-RUN counts operational data and deletes nothing', async () => {
    await auth(request(app).post('/api/admin/overrides')).send({ key: 'maljevac:toHr', value: 30 });
    const dry = await auth(request(app).post('/api/admin/maljevac/reset-operational-data'));
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.applied).toBe(false);
    expect(dry.body.runtime.before.adminOverrides).toBeGreaterThanOrEqual(1);
    // Nothing deleted yet — a second dry-run still sees it.
    const again = await auth(request(app).post('/api/admin/maljevac/reset-operational-data'));
    expect(again.body.runtime.before.adminOverrides).toBeGreaterThanOrEqual(1);
  });

  it('APPLY clears Maljevac operational data but preserves other crossings + users/ROI', async () => {
    await auth(request(app).post('/api/admin/overrides')).send({ key: 'maljevac:toBih', value: 25 });
    // Seed an override for ANOTHER crossing that must survive.
    if (otherCrossingId) {
      await auth(request(app).post('/api/admin/overrides')).send({ key: `${otherCrossingId}:toBih`, value: 70 });
    }
    const applied = await auth(request(app).post('/api/admin/maljevac/reset-operational-data')).send({ apply: true });
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(true);
    expect(applied.body.runtime.after.adminOverrides).toBe(0);
    // …other crossing untouched (its own dry-run still counts its override).
    if (otherCrossingId) {
      const other = await auth(request(app).post(`/api/admin/crossings/${otherCrossingId}/reset-operational-data`));
      expect(other.body.runtime.before.adminOverrides).toBeGreaterThanOrEqual(1);
    }
    // Explicitly documents what it never deletes.
    expect(applied.body.preserved).toEqual(expect.arrayContaining(['borderflow_users', 'borderflow_camera_roi_configs']));
  });
});

describe('EMA smoothing cannot retain a stale-low value (acceptance #9)', () => {
  it('a fresh high reading jumps straight through instead of being blended down by an old low', () => {
    const key = 'ema-test:reset';
    expect(emaSmoothWait(key, 5)).toBe(5);          // seed a low value
    expect(emaSmoothWait(key, 120)).toBe(120);      // big jump (>25) bypasses smoothing → no stale drag
    // a NEW key (as after a reset clears the cache) always returns the raw value
    expect(emaSmoothWait('ema-test:fresh-after-reset', 95)).toBe(95);
  });
});
