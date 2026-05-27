import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp, ALL_CROSSING_IDS, DIRECTIONS, findIllegalJsonValue, expectFiniteNonNegative } from '../helpers/app-loader.js';

let app;

beforeAll(async () => {
  app = await getApp();
});

describe('GET /api/routes/:crossingId', () => {
  for (const crossingId of ALL_CROSSING_IDS) {
    for (const direction of DIRECTIONS) {
      it(`returns a valid payload for ${crossingId} / ${direction}`, async () => {
        const res = await request(app).get(`/api/routes/${crossingId}`).query({ direction });

        expect(res.status).toBe(200);
        const body = res.body;

        // Identity: response must reference the requested crossing and direction.
        expect(body.crossingId).toBe(crossingId);
        expect(body.direction).toBe(direction);

        // Either the route is live and we have a route, OR the response must
        // clearly mark itself as unavailable / pending / closed. It must never
        // silently return "ok" with no routes and no unavailable flag.
        const isLive = body.live === true && Array.isArray(body.routes) && body.routes.length > 0;
        const isUnavailable = body.routeHidden === true
          || body.routeStatus === 'pending_verification'
          || body.routeStatus === 'closed_or_blocked'
          || body.closed === true
          || body.routeUnavailable === true;

        expect(isLive || isUnavailable).toBe(true);

        // If live, route shape must be sane.
        if (isLive) {
          for (const route of body.routes) {
            expect(route.crossingId).toBe(crossingId);
            const dur = expectFiniteNonNegative(route.durationMinutes, `routes[].durationMinutes (${crossingId}/${direction})`);
            // Cross-border durations should never collapse to 0 minutes for a real Google route.
            expect(dur).toBeGreaterThan(0);
            if (route.distanceKm !== null && route.distanceKm !== undefined) {
              expectFiniteNonNegative(route.distanceKm, `routes[].distanceKm (${crossingId}/${direction})`);
            }
            expect(typeof route.path).toBe('object');
          }
        }

        // No NaN / Infinity / "undefined" string leaks anywhere.
        const leak = findIllegalJsonValue(body, '$');
        expect(leak, leak || undefined).toBeNull();
      });
    }
  }

  it('returns 404 for an invalid crossing (does NOT fall back to Maljevac)', async () => {
    const res = await request(app).get('/api/routes/does-not-exist').query({ direction: 'toBih' });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    // Crucially: the response must not contain a Maljevac payload masquerading
    // as the requested crossing.
    expect(res.body.crossingId).not.toBe('maljevac');
    expect(res.body.crossing).not.toBe('GP Maljevac');
  });

  it('does not swap directions: response.direction === query.direction', async () => {
    for (const direction of DIRECTIONS) {
      const res = await request(app).get('/api/routes/maljevac').query({ direction });
      expect(res.status).toBe(200);
      expect(res.body.direction).toBe(direction);
    }
  });

  it('zone labels reflect the requested direction (HR→BiH vs BiH→HR)', async () => {
    const toBih = await request(app).get('/api/routes/maljevac').query({ direction: 'toBih' });
    const toHr = await request(app).get('/api/routes/maljevac').query({ direction: 'toHr' });
    expect(toBih.body.zone?.label).toMatch(/HR\s*→\s*BiH/);
    expect(toHr.body.zone?.label).toMatch(/BiH\s*→\s*HR/);
  });
});
