// Client ping throttling — keeps 1000+ users from flooding the backend (pure logic).
import { describe, it, expect } from 'vitest';
import { shouldSendPing, pingIntervalFor, LOCATION_WAIT_CLIENT_DEFAULTS } from '../../src/utils/location-wait-client.js';

const P = { lat: 45.0, lng: 16.0 };

describe('pingIntervalFor', () => {
  it('near a zone → fast cadence, far → slow cadence', () => {
    expect(pingIntervalFor(500)).toBe(LOCATION_WAIT_CLIENT_DEFAULTS.nearZonePingMs);
    expect(pingIntervalFor(50000)).toBe(LOCATION_WAIT_CLIENT_DEFAULTS.farZonePingMs);
  });
});

describe('shouldSendPing', () => {
  it('sends when the cadence interval has elapsed', () => {
    expect(shouldSendPing({ now: 100000, lastSentAt: 0, point: P, status: 'active', distanceToZoneM: 500 }).send).toBe(true);
  });
  it('throttles a too-soon ping that has not moved much', () => {
    const r = shouldSendPing({ now: 5000, lastSentAt: 0, lastPoint: P, point: { lat: 45.00001, lng: 16.0 }, status: 'active', distanceToZoneM: 500 });
    expect(r.send).toBe(false);
    expect(r.reason).toBe('throttled');
  });
  it('a significant move can trigger an earlier ping than the (far) cadence', () => {
    const moved = { lat: 45.01, lng: 16.0 }; // ~1.1km away
    // Far from any zone → 60s cadence; only 16s elapsed, but a big move forces an early ping.
    const r = shouldSendPing({ now: 16000, lastSentAt: 0, lastPoint: P, point: moved, status: 'active', distanceToZoneM: 50000 });
    expect(r.send).toBe(true);
    expect(r.reason).toBe('moved');
  });
  it('never sends once the session is terminal (completed/cancelled/expired/disarmed)', () => {
    for (const status of ['completed', 'cancelled', 'expired', 'disarmed']) {
      expect(shouldSendPing({ now: 1e9, lastSentAt: 0, point: P, status, distanceToZoneM: 100 }).send).toBe(false);
    }
  });
  it('does not send without a valid point', () => {
    expect(shouldSendPing({ now: 1e9, point: null, status: 'active' }).send).toBe(false);
  });
});
