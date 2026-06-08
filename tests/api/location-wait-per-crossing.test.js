// Per-crossing verified-location allow-list: VERIFIED_LOCATION_CROSSINGS=maljevac must arm ONLY
// Maljevac and leave every other crossing disarmed (no session, no pings) without breaking the UI.
process.env.VERIFIED_LOCATION_ENABLED = 'true';
process.env.VERIFIED_LOCATION_CROSSINGS = 'maljevac';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

let app;

beforeAll(async () => {
  const mod = await import('../../server/index.js');
  await mod.initializeDatastore();
  app = mod.app;
});

afterAll(() => {
  delete process.env.VERIFIED_LOCATION_ENABLED;
  delete process.env.VERIFIED_LOCATION_CROSSINGS;
});

describe('verified location — per-crossing allow-list', () => {
  it('arms the flagship (Maljevac) — both directions have calibrated anchors', async () => {
    const res = await request(app).post('/api/location-wait/session').send({ crossingId: 'maljevac', direction: 'toBih' });
    expect(res.status).toBe(201);
    expect(res.body.armed).toBe(true);
    expect(res.body.status).toBe('pending');

    const back = await request(app).post('/api/location-wait/session').send({ crossingId: 'maljevac', direction: 'toHr' });
    expect(back.body.armed).toBe(true);
  });

  it('does NOT arm a crossing outside the allow-list (UI still gets a non-crashing response)', async () => {
    const fences = (await request(app).get('/api/measured/geofences')).body.geofences || [];
    const other = fences.find((f) => f.crossingId && f.crossingId !== 'maljevac' && f.approach && f.exit);
    if (!other) return; // no other calibrated crossing to assert against
    const res = await request(app).post('/api/location-wait/session').send({ crossingId: other.crossingId, direction: other.direction });
    expect(res.status).toBe(200);
    expect(res.body.armed).toBe(false);
    expect(res.body.status).toBe('disarmed');
  });

  it('the public state marks Maljevac armed and a non-listed crossing not armed', async () => {
    const state = await request(app).get('/api/public/state');
    const crossings = state.body?.crossings || [];
    if (!crossings.length) return;
    const mal = crossings.find((c) => c.id === 'maljevac');
    const other = crossings.find((c) => c.id !== 'maljevac');
    expect(mal?.locationWaitArmed).toBe(true);
    if (other) expect(other.locationWaitArmed).toBe(false);
  });
});
