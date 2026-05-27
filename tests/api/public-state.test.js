import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp, ALL_CROSSING_IDS, findIllegalJsonValue } from '../helpers/app-loader.js';

let app;

beforeAll(async () => {
  app = await getApp();
});

describe('GET /api/public/state', () => {
  it('returns ok=true and includes every known crossing', async () => {
    const res = await request(app).get('/api/public/state');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.crossings)).toBe(true);
    const ids = res.body.crossings.map((c) => c.id);
    for (const id of ALL_CROSSING_IDS) {
      expect(ids).toContain(id);
    }
  });

  it('effectiveWaits values are either null or finite non-negative numbers', async () => {
    const res = await request(app).get('/api/public/state');
    const waits = res.body.effectiveWaits || {};
    for (const [key, value] of Object.entries(waits)) {
      if (value === null) continue;
      expect(typeof value, `effectiveWaits[${key}] is wrong type (${typeof value})`).toBe('number');
      expect(Number.isFinite(value), `effectiveWaits[${key}] not finite (${value})`).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('payload contains no NaN / "undefined" / "null" string leaks in numeric positions', async () => {
    const res = await request(app).get('/api/public/state');
    const leak = findIllegalJsonValue(res.body, '$');
    expect(leak, leak || undefined).toBeNull();
  });
});
