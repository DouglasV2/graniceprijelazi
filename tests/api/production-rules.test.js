// Regression tests for the 11 production rules audited on 2026-05-28:
//   1. No fake/static wait leaks into public effective wait
//   2. Guest mode works without login (no token required for public endpoints)
//   3. Invalid crossing IDs return 4xx, never a Maljevac fallback
//   4. Public payload contains no internal jargon strings
//   5. Numeric wait values are sane (no NaN / negative / "0–15 min")
//   6. Trip-options respects explicit `direction` query param
//   7. Self-registration is locked by default (ALLOW_PUBLIC_REGISTRATION)
//   8. Auth-protected endpoints reject anonymous callers
//   9. History endpoint never invents days for an unknown crossing

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp, ALL_CROSSING_IDS, DIRECTIONS, findIllegalJsonValue } from '../helpers/app-loader.js';

let app;

beforeAll(async () => {
  app = await getApp();
});

const INVALID_CROSSING_IDS = [
  'does-not-exist',
  '../maljevac',
  '   ',
  '%2e%2e',
  'maljevac-fake',
];

const PER_CROSSING_DETAIL_ENDPOINTS = [
  '/api/routes',
  '/api/history',
  '/api/camera-snapshots',
  '/api/camera-analytics',
  '/api/camera-history',
];

describe('Production rule: invalid crossingId must not fall back to Maljevac', () => {
  for (const base of PER_CROSSING_DETAIL_ENDPOINTS) {
    for (const id of INVALID_CROSSING_IDS) {
      it(`${base}/<invalid> (${JSON.stringify(id)}) returns 4xx and is not Maljevac`, async () => {
        const res = await request(app).get(`${base}/${encodeURIComponent(id)}`).query({ direction: 'toBih' });
        expect(res.status, `expected 4xx for ${base}/${id}`).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(res.body?.ok).not.toBe(true);
        // No payload masquerading as Maljevac.
        expect(res.body?.crossingId).not.toBe('maljevac');
        expect(res.body?.crossing).not.toBe('GP Maljevac');
      });
    }
  }
});

describe('Production rule: public/guest mode works without login', () => {
  it('GET /api/public/state without Authorization header returns ok', async () => {
    const res = await request(app).get('/api/public/state');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.crossings.length).toBeGreaterThan(0);
  });

  it('GET /api/sources/latest without Authorization header returns ok', async () => {
    const res = await request(app).get('/api/sources/latest').query({ crossingId: 'maljevac', direction: 'toBih' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /api/routes without Authorization header returns ok for every crossing', async () => {
    for (const id of ALL_CROSSING_IDS) {
      const res = await request(app).get(`/api/routes/${id}`).query({ direction: 'toBih' });
      expect(res.status, `routes for ${id} requires no auth`).toBe(200);
    }
  });

  it('GET /api/trip-options without Authorization header returns ok', async () => {
    const res = await request(app).get('/api/trip-options').query({ origin: 'Zagreb', destination: 'Cazin' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /api/history without Authorization header returns ok', async () => {
    const res = await request(app).get('/api/history/maljevac').query({ direction: 'toBih', days: 7 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Production rule: no fake/static planner wait in public effective state', () => {
  it('waitSources never expose static-fallback / planner-estimate / google-traffic-estimate-pending as displayReady', async () => {
    const res = await request(app).get('/api/public/state');
    expect(res.status).toBe(200);
    const waitSources = res.body.waitSources || {};
    const effectiveWaits = res.body.effectiveWaits || {};
    for (const [key, src] of Object.entries(waitSources)) {
      // If displayReady is true, the source must be a real live source — never the static
      // fallback. Static / planner values may stay in the meta for internal reasons but the
      // public UI must not surface them as live.
      if (src?.displayReady === true) {
        expect(src.sourceType, `${key} has displayReady=true with a fake sourceType (${src.sourceType})`)
          .not.toMatch(/^(static-fallback|planner-estimate|google-traffic-estimate-pending|no-live-source)$/);
      }
      // When displayReady is explicitly false, no effective wait should be exposed.
      if (src?.displayReady === false) {
        expect(effectiveWaits[key] === undefined || effectiveWaits[key] === null,
          `${key} has displayReady=false but effectiveWaits exposes ${effectiveWaits[key]}`).toBe(true);
      }
    }
  });

  it('effectiveWaits never contains negative / NaN values', async () => {
    const res = await request(app).get('/api/public/state');
    for (const [key, value] of Object.entries(res.body.effectiveWaits || {})) {
      if (value === null) continue;
      expect(typeof value, `${key} value is wrong type`).toBe('number');
      expect(Number.isFinite(value), `${key} value not finite`).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('no NaN / undefined / null string leaks in /api/public/state payload', async () => {
    const res = await request(app).get('/api/public/state');
    const leak = findIllegalJsonValue(res.body, '$');
    expect(leak, leak || undefined).toBeNull();
  });
});

describe('Production rule: public copy stays human (no internal jargon in payloads)', () => {
  const JARGON_SUBSTRINGS = [
    'BIHAMK + Kamera',
    'queue/flow',
    'route guard',
    'gornja granica',
    'planner-estimate',
    'google-traffic-estimate-pending',
    'displayReady',
    'NaN',
    'undefined',
  ];

  function scanForJargon(body) {
    const json = JSON.stringify(body).toLowerCase();
    return JARGON_SUBSTRINGS.filter((needle) => json.includes(needle.toLowerCase()));
  }

  it('/api/public/state payload contains no jargon in user-facing strings', async () => {
    const res = await request(app).get('/api/public/state');
    // waitSources.note + label must stay human. We allow internal `sourceType` codes
    // (combined-estimate, public-text-status, etc) because they are classification IDs
    // and not displayed. The blocklist above covers ONLY values that the audit forbids
    // from EVER appearing in the payload.
    const sources = res.body.waitSources || {};
    for (const [key, src] of Object.entries(sources)) {
      for (const field of ['label', 'note']) {
        const value = String(src?.[field] || '');
        for (const needle of JARGON_SUBSTRINGS) {
          expect(value.toLowerCase().includes(needle.toLowerCase()),
            `${key}.${field} contains forbidden phrase "${needle}": ${JSON.stringify(value)}`).toBe(false);
        }
      }
    }
    // Top-level payload too — warnings etc.
    const hits = scanForJargon({ warnings: res.body.warnings, sourceRefresh: res.body.sourceRefresh });
    expect(hits, `top-level payload contains forbidden phrases: ${hits.join(', ')}`).toEqual([]);
  });

  it('/api/routes payloads contain no NaN / undefined / null string leaks for any crossing', async () => {
    for (const id of ALL_CROSSING_IDS) {
      for (const direction of DIRECTIONS) {
        const res = await request(app).get(`/api/routes/${id}`).query({ direction });
        const leak = findIllegalJsonValue(res.body, `$ (${id}/${direction})`);
        expect(leak, leak || undefined).toBeNull();
      }
    }
  });
});

describe('Production rule: trip-options respects explicit direction', () => {
  // The /api/trip-options handler used to call `inferJourneyDirection(origin, destination)
  // || requestedDirection || 'toBih'` which silently overrode the caller's explicit choice.
  // For an Osijek→Tuzla style trip we want the caller's `direction` param to win.
  it('explicit direction=toBih wins for cross-region trip', async () => {
    const res = await request(app).get('/api/trip-options').query({
      origin: 'Osijek',
      destination: 'Tuzla',
      direction: 'toBih',
    });
    expect(res.status).toBe(200);
    expect(res.body.direction).toBe('toBih');
    for (const option of res.body.options || []) {
      expect(option.direction, `option ${option.crossingId} direction must echo request`).toBe('toBih');
    }
  });

  it('explicit direction=toHr wins for Cazin → Zagreb', async () => {
    const res = await request(app).get('/api/trip-options').query({
      origin: 'Cazin',
      destination: 'Zagreb',
      direction: 'toHr',
    });
    expect(res.status).toBe(200);
    expect(res.body.direction).toBe('toHr');
  });

  it('unknown wait must report borderDelayKnown=false instead of inventing minutes', async () => {
    // No live signals are seeded in tests (SOURCE_FETCH_ENABLED=false), so border delay
    // for every option should be `null` + `borderDelayKnown=false`. The total minutes
    // must then equal driveDurationMinutes, never driveDuration + a synthetic wait.
    const res = await request(app).get('/api/trip-options').query({
      origin: 'Zagreb', destination: 'Cazin', direction: 'toBih',
    });
    expect(res.status).toBe(200);
    for (const option of res.body.options || []) {
      expect(option.borderDelayKnown === false || typeof option.borderDelayMinutes === 'number')
        .toBe(true);
      if (option.borderDelayKnown === false) {
        expect(option.borderDelayMinutes, `option ${option.crossingId} borderDelayMinutes must be null when unknown`).toBeNull();
        expect(option.totalMinutes).toBe(option.routeDurationMinutes);
      }
    }
  });
});

describe('Production rule: registration is locked by default', () => {
  it('POST /api/auth/register returns 403 when ALLOW_PUBLIC_REGISTRATION is not enabled', async () => {
    // setup-env.js does not set ALLOW_PUBLIC_REGISTRATION; default is false.
    const res = await request(app).post('/api/auth/register').send({
      name: 'Should Not Register',
      email: `nope-${Date.now()}@example.com`,
      password: 'pilot-password-1234',
    });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });
});

describe('Production rule: admin endpoints require admin auth', () => {
  const ADMIN_ENDPOINTS = [
    { method: 'get', path: '/api/admin/audit' },
    { method: 'get', path: '/api/admin/health' },
    { method: 'get', path: '/api/admin/daily-report' },
    { method: 'get', path: '/api/debug/wait' },
    { method: 'get', path: '/api/debug/wait-scenarios' },
    { method: 'post', path: '/api/admin/sources/refresh' },
    { method: 'post', path: '/api/admin/overrides' },
    { method: 'post', path: '/api/admin/status-overrides' },
  ];

  for (const { method, path: route } of ADMIN_ENDPOINTS) {
    it(`${method.toUpperCase()} ${route} rejects anonymous callers (401/403)`, async () => {
      const res = await request(app)[method](route).send({});
      expect([401, 403], `${method} ${route} expected 401/403, got ${res.status}`).toContain(res.status);
    });
  }
});

describe('Production rule: invalid history days clamp does not crash', () => {
  it('/api/history rejects unknown crossing with 404', async () => {
    const res = await request(app).get('/api/history/fake-crossing').query({ direction: 'toBih', days: 7 });
    expect(res.status).toBe(404);
  });
});
