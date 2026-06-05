// Production liveness/readiness probes must be public, never 5xx while the process is up, and must
// NOT leak secrets (only boolean "configured" flags + state).
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp, findIllegalJsonValue } from '../helpers/app-loader.js';

let app;
beforeAll(async () => { app = await getApp(); });

describe('GET /health (liveness)', () => {
  it('is public and 200 with a simple alive payload', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('alive');
    expect(Number.isFinite(res.body.uptimeSeconds)).toBe(true);
  });
});

describe('GET /readiness (state, no secrets)', () => {
  it('is public, 200, and reports config STATE as booleans only', async () => {
    const res = await request(app).get('/readiness');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.ready).toBe('boolean');
    expect(['file', 'postgres']).toContain(res.body.datastore);
    const c = res.body.checks;
    expect(c).toBeTruthy();
    for (const key of ['googleMapsConfigured', 'cameraCvConfigured', 'publicSourcesEnabled', 'predictionV2Enabled', 'verifiedLocationEnabled']) {
      expect(typeof c[key], `${key} must be boolean`).toBe('boolean');
    }
    expect(findIllegalJsonValue(res.body, '$')).toBeNull();
  });

  it('never leaks a secret value (keys/tokens/connection strings)', async () => {
    const res = await request(app).get('/readiness');
    const raw = JSON.stringify(res.body);
    // No env-style secrets, tokens, postgres URLs or API keys in the payload.
    expect(raw).not.toMatch(/postgres:\/\/|AIza|SESSION_SECRET|Bearer\s|password|api[_-]?key["']?\s*[:=]/i);
  });

  it('in the test env (file datastore) readiness is ready=true', async () => {
    const res = await request(app).get('/readiness');
    expect(res.body.ready).toBe(true);
    expect(res.body.datastore).toBe('file');
  });
});
