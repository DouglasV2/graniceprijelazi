import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp, ALL_CROSSING_IDS, findIllegalJsonValue, expectFiniteNonNegative } from '../helpers/app-loader.js';

let app;

beforeAll(async () => {
  app = await getApp();
});

const TRIP_CASES = [
  { origin: 'Zagreb', destination: 'Cazin', direction: 'toBih' },
  { origin: 'Cazin', destination: 'Zagreb', direction: 'toHr' },
  { origin: 'Zagreb', destination: 'Banja Luka', direction: 'toBih' },
  { origin: 'Zagreb', destination: 'Mostar', direction: 'toBih' },
  { origin: 'Split', destination: 'Mostar', direction: 'toBih' },
  { origin: 'Osijek', destination: 'Tuzla', direction: 'toBih' },
  { origin: 'München', destination: 'Cazin', direction: 'toBih' },
];

function isOptionUnavailable(option) {
  if (option.waitUnknown === true) return true;
  if (option.borderDelayKnown === false) return true;
  if (option.source === 'route-unavailable') return true;
  return false;
}

describe('GET /api/trip-options', () => {
  for (const { origin, destination, direction } of TRIP_CASES) {
    it(`returns sane options for ${origin} → ${destination} (${direction})`, async () => {
      const res = await request(app).get('/api/trip-options').query({ origin, destination, direction });
      expect(res.status).toBe(200);

      const body = res.body;
      expect(body.origin).toBe(origin);
      expect(body.destination).toBe(destination);
      expect(body.direction).toBe(direction);
      expect(Array.isArray(body.options)).toBe(true);
      expect(body.options.length).toBeGreaterThan(0);

      const knownCrossingIds = new Set(ALL_CROSSING_IDS);

      for (const option of body.options) {
        // Every alternative must point at a real crossing.
        expect(typeof option.crossingId).toBe('string');
        expect(knownCrossingIds.has(option.crossingId)).toBe(true);
        expect(option.direction).toBe(direction);

        // routeDurationMinutes must always be finite (the extraDriveFromMainRoute
        // regression: when that property is missing it must fall back to 0,
        // not NaN).
        expectFiniteNonNegative(option.routeDurationMinutes, `option(${option.crossingId}).routeDurationMinutes`);
        expectFiniteNonNegative(option.totalMinutes, `option(${option.crossingId}).totalMinutes`);

        // border delay may be unknown (null + waitUnknown=true) OR a finite non-negative number.
        if (option.borderDelayMinutes !== null && option.borderDelayMinutes !== undefined) {
          expectFiniteNonNegative(option.borderDelayMinutes, `option(${option.crossingId}).borderDelayMinutes`);
        } else {
          // null is acceptable only when the option flags the wait as unknown.
          expect(isOptionUnavailable(option)).toBe(true);
        }

        // No double-counting: totalMinutes must equal driveDuration + (known)borderDelay,
        // or driveDuration alone when wait is unknown. Allow a 1-minute rounding tolerance.
        const drive = Number(option.routeDurationMinutes);
        const wait = Number(option.borderDelayMinutes ?? option.borderZastojMinutes ?? 0) || 0;
        const expectedTotal = drive + wait;
        expect(Math.abs(option.totalMinutes - expectedTotal)).toBeLessThanOrEqual(1);

        // totalMinutes must be at least the drive time (border wait can't subtract).
        expect(option.totalMinutes).toBeGreaterThanOrEqual(drive - 0.5);
      }

      // Recommended option is the first one — must not be visibly worse than the second.
      if (body.best && body.options.length >= 2) {
        const recommended = body.best;
        const next = body.options[1];
        // Only check when both have known totals (sorted already, so this should hold).
        expect(Number(recommended.totalMinutes)).toBeLessThanOrEqual(Number(next.totalMinutes));
      }

      // No NaN / "undefined" string anywhere.
      const leak = findIllegalJsonValue(body, '$');
      expect(leak, leak || undefined).toBeNull();
    });
  }

  it('rejects requests missing origin/destination', async () => {
    const res = await request(app).get('/api/trip-options').query({ origin: '', destination: '' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});
