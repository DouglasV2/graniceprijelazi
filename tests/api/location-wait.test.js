// Full live-location lifecycle over the real HTTP API: session → pending → active → completed, with
// the SERVER deciding state from anchor geofences. No raw GPS trail is persisted. We disable the
// per-session throttle (interval 0) so the lifecycle is exercisable in one fast test.
process.env.VERIFIED_LOCATION_ENABLED = 'true';
process.env.LOCATION_WAIT_PING_MIN_INTERVAL_SECONDS = '0';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

let app;
let fence; // { crossingId, direction, approach, border, exit }

beforeAll(async () => {
  const mod = await import('../../server/index.js');
  await mod.initializeDatastore();
  app = mod.app;
  const res = await request(app).get('/api/measured/geofences');
  fence = (res.body.geofences || []).find((f) => f.approach && f.exit && f.crossingId);
});

afterAll(() => {
  delete process.env.VERIFIED_LOCATION_ENABLED;
  delete process.env.LOCATION_WAIT_PING_MIN_INTERVAL_SECONDS;
});

describe('live-location session lifecycle', () => {
  it('there is at least one crossing with calibrated anchors to arm against', () => {
    expect(fence).toBeTruthy();
  });

  it('drives pending → active → completed and measures the wait server-side', async () => {
    if (!fence) return;
    const sessionRes = await request(app).post('/api/location-wait/session').send({ crossingId: fence.crossingId, direction: fence.direction });
    expect(sessionRes.status).toBe(201);
    expect(sessionRes.body.armed).toBe(true);
    expect(sessionRes.body.status).toBe('pending');
    const sessionId = sessionRes.body.sessionId;

    // A ping far from the start zone keeps it pending.
    const far = await request(app).post('/api/location-wait/ping').send({ sessionId, lat: 0.5, lng: 0.5, accuracyM: 20 });
    expect(far.body.status).toBe('pending');

    // Entering the start (queue-join) zone activates it.
    const activate = await request(app).post('/api/location-wait/ping').send({ sessionId, lat: fence.approach.lat, lng: fence.approach.lng, accuracyM: 25 });
    expect(activate.body.status).toBe('active');
    expect(activate.body.message).toBe('Live signal aktivan');

    // Reaching the end (past-the-booth) zone completes it with a measured wait.
    const complete = await request(app).post('/api/location-wait/ping').send({ sessionId, lat: fence.exit.lat, lng: fence.exit.lng, accuracyM: 25 });
    expect(complete.body.status).toBe('completed');
    expect(complete.body.message).toMatch(/Hvala/);
    expect(Number.isFinite(complete.body.measuredWaitMin)).toBe(true);
    expect(complete.body.measuredWaitMin).toBeGreaterThanOrEqual(0);

    // Status endpoint reflects completion + a non-zero ping count (and NO raw GPS in the payload).
    const status = await request(app).get(`/api/location-wait/status/${sessionId}`);
    expect(status.body.status).toBe('completed');
    expect(status.body.pingCount).toBeGreaterThan(0);
    expect(JSON.stringify(status.body)).not.toMatch(/"lat"|"lng"|trail/);
  });

  it('direction:"auto" resolves the crossing direction from the first fix', async () => {
    if (!fence) return;
    const sessionRes = await request(app).post('/api/location-wait/session').send({ crossingId: fence.crossingId, direction: 'auto' });
    expect(sessionRes.status).toBe(201);
    expect(sessionRes.body.armed).toBe(true);
    const sessionId = sessionRes.body.sessionId;
    // The first usable fix at the approach (queue-join) zone resolves the direction (nearest
    // approachStart side) AND activates — the client never had to know which way it was crossing.
    const activate = await request(app).post('/api/location-wait/ping').send({ sessionId, lat: fence.approach.lat, lng: fence.approach.lng, accuracyM: 25 });
    expect(activate.body.status).toBe('active');
    const complete = await request(app).post('/api/location-wait/ping').send({ sessionId, lat: fence.exit.lat, lng: fence.exit.lng, accuracyM: 25 });
    expect(complete.body.status).toBe('completed');
    expect(Number.isFinite(complete.body.measuredWaitMin)).toBe(true);
  });

  it('rejects a low-accuracy fix (stays pending)', async () => {
    if (!fence) return;
    // Use the opposite direction for a fresh session hash bucket.
    const dir = fence.direction === 'toBih' ? 'toHr' : 'toBih';
    const other = (await request(app).get('/api/measured/geofences')).body.geofences.find((f) => f.crossingId === fence.crossingId && f.direction === dir) || fence;
    const s = await request(app).post('/api/location-wait/session').send({ crossingId: other.crossingId, direction: other.direction });
    if (!s.body.armed) return; // that direction may not be calibrated
    const res = await request(app).post('/api/location-wait/ping').send({ sessionId: s.body.sessionId, lat: other.approach.lat, lng: other.approach.lng, accuracyM: 500 });
    expect(res.body.status).toBe('pending');
  });

  it('cancel stops the session', async () => {
    if (!fence) return;
    const s = await request(app).post('/api/location-wait/session').send({ crossingId: fence.crossingId, direction: fence.direction });
    const res = await request(app).post('/api/location-wait/cancel').send({ sessionId: s.body.sessionId });
    expect(res.body.ok).toBe(true);
    expect(['cancelled', 'completed']).toContain(res.body.status);
  });
});
