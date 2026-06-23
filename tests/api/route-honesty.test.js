// T2 — route honesty rules:
//  * without a verifiable geometry the API must NOT claim the crossing is closed ("nije prohodna")
//  * the "closed" claim is reserved for a real admin status override
//  * unverified routes ship routes:[] (nothing to draw) while the wait stays available elsewhere
// The frontend additionally refuses to draw non-road-shaped geometry (route-geometry.test.js) and
// shows the "Rutu trenutno ne možemo potvrditi" warning copy (checked below at source level).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import request from 'supertest';
import { getApp } from '../helpers/app-loader.js';

let app;
let mod;
let adminToken;

beforeAll(async () => {
  app = await getApp();
  mod = await import('../../server/index.js');
  adminToken = mod.signToken({ id: 'admin-access', email: 'admin@borderflow.app', role: 'admin', name: 'Admin' });
});
const auth = (req) => req.set('Authorization', `Bearer ${adminToken}`);

afterAll(async () => {
  // Clean up the override so other suites see maljevac as open. (Gradiška is intentionally force-closed
  // in code — FORCED_STATUS_OVERRIDES — so it is NOT used as the "open crossing" fixture here.)
  await auth(request(app).post('/api/admin/status-overrides')).send({ crossingId: 'maljevac', direction: 'toBih', status: 'open' });
});

describe('routes API never fakes a confirmed or closed route', () => {
  // maljevac is the "open crossing" fixture (gradiska is intentionally force-closed — tested separately).
  it('without a Google key the route is hidden (routes: []) and NOT marked closed', async () => {
    const res = await request(app).get('/api/routes/maljevac').query({ direction: 'toBih' });
    expect(res.status).toBe(200);
    expect(res.body.routes).toEqual([]);
    expect(res.body.closed).not.toBe(true);
    expect(res.body.routeStatus).not.toBe('closed_or_blocked');
    // The payload must be explicit that the line is hidden pending verification.
    expect(res.body.routeHidden === true || res.body.live === false).toBe(true);
  });

  it('"nije prohodna" (closed) appears via a real admin status override (and clears when removed)', async () => {
    const set = await auth(request(app).post('/api/admin/status-overrides')).send({ crossingId: 'maljevac', direction: 'toBih', status: 'closed', note: 'Test zatvaranja' });
    expect(set.status).toBe(200);
    const res = await request(app).get('/api/routes/maljevac').query({ direction: 'toBih' });
    expect(res.body.closed).toBe(true);
    expect(res.body.routeStatus).toBe('closed_or_blocked');
    expect(res.body.source).toBe('Admin status override');
    // Clearing the override restores the non-closed behaviour.
    await auth(request(app).post('/api/admin/status-overrides')).send({ crossingId: 'maljevac', direction: 'toBih', status: 'open' });
    const after = await request(app).get('/api/routes/maljevac').query({ direction: 'toBih' });
    expect(after.body.closed).not.toBe(true);
  });

  it('Gradiška is closed via a code-managed forced status (route not passable), pointing at Gornji Varoš', async () => {
    // A deliberate, code-managed closure (FORCED_STATUS_OVERRIDES) — distinct source from an admin action,
    // and it still routes through the same honest "closed" payload with the replacement crossing.
    const res = await request(app).get('/api/routes/gradiska').query({ direction: 'toBih' });
    expect(res.body.closed).toBe(true);
    expect(res.body.routeStatus).toBe('closed_or_blocked');
    expect(res.body.source).toBe('Operativni status prijelaza');
    expect(res.body.suggestedCrossing?.crossingId).toBe('gornji-varos');
  });
});

describe('frontend honesty guards (source-level regression tripwires)', () => {
  const appSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/App.jsx'), 'utf8');

  it('the map refuses to draw a non-road-shaped (straight fallback) polyline', () => {
    expect(appSource).toContain('if (!routeGeometryValidated(path)) return;');
  });

  it('the unverified-route warning copy is present and user-friendly', () => {
    expect(appSource).toContain('Rutu trenutno ne možemo potvrditi');
    expect(appSource).toContain('Prikazujemo samo čekanje na granici');
  });

  it('route metrics are gated behind validated geometry (showZoneMetrics)', () => {
    expect(appSource).toMatch(/showZoneMetrics && routeDetailsOpen/);
    expect(appSource).toMatch(/const showZoneMetrics = primaryRoute && \(!isControlZoneDisplay \|\| routeValidated\)/);
  });
});
