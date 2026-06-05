// When VERIFIED_LOCATION_ENABLED is off (the default), every location-wait endpoint must be a no-op
// 404 {disabled:true} so the feature is invisible/inert and the app never depends on it.
process.env.VERIFIED_LOCATION_ENABLED = 'false';

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp } from '../helpers/app-loader.js';

let app;
beforeAll(async () => { app = await getApp(); });

describe('location-wait endpoints are disabled by default', () => {
  it('POST /api/location-wait/session → 404 disabled', async () => {
    const res = await request(app).post('/api/location-wait/session').send({ crossingId: 'maljevac', direction: 'toBih' });
    expect(res.status).toBe(404);
    expect(res.body.disabled).toBe(true);
  });
  it('POST /api/location-wait/ping → 404 disabled', async () => {
    const res = await request(app).post('/api/location-wait/ping').send({ sessionId: 'x', lat: 45, lng: 16, accuracyM: 20 });
    expect(res.status).toBe(404);
  });
});
