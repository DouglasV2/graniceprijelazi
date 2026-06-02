// History honesty audit (V5 §7 H): the "Prošlost" view must never present fabricated
// precise vehicle counts as fact. Public text sources report a wait, not counted vehicles,
// so vehicle breakdowns are only real when they come from camera observation.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp, findIllegalJsonValue } from '../helpers/app-loader.js';

let app;
beforeAll(async () => { app = await getApp(); });

describe('GET /api/history honesty', () => {
  it('exposes coverage and never fabricates vehicle totals without real camera counts', async () => {
    const res = await request(app).get('/api/history/maljevac').query({ direction: 'toBih', days: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('coverage');
    expect(res.body).toHaveProperty('vehicleCountsAreReal');
    // With no stored camera observations, totals must be null (not invented numbers) and the
    // counts must be flagged as not-real.
    if (!res.body.vehicleCountsAreReal) {
      expect(res.body.totals).toBeNull();
    }
    expect(findIllegalJsonValue(res.body, '$')).toBeNull();
  });

  it('returns an honest note when there is not enough real history', async () => {
    const res = await request(app).get('/api/history/svilaj').query({ direction: 'toHr', days: 7 });
    expect(res.status).toBe(200);
    expect(typeof res.body.note).toBe('string');
    // The note must not claim precise factual data when coverage is thin.
    if (!res.body.coverage.enoughForPatterns) {
      expect(res.body.note.toLowerCase()).toMatch(/nema|nemamo|nije stvarno|ne prikazuje/);
    }
  });

  it('model backfill stays OFF by default (no synthetic history unless explicitly enabled)', async () => {
    const res = await request(app).get('/api/history/gradiska').query({ direction: 'toBih', days: 7 });
    expect(res.body.coverage.modelBackfillEnabled).toBe(false);
    expect(res.body.coverage.modelSlots).toBe(0);
  });
});
