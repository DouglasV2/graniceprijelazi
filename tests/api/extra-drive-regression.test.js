// Regression test for the `extraDriveFromMainRoute` bug:
// the fallback path used `crossing.extraDriveFromMainRoute` directly. When
// that property is missing on the server-side crossing object the value
// becomes `undefined`, addition turns into `NaN`, and the JSON response
// poisons the UI. We now guard the read with `?? 0`, but we keep a test
// that locks the contract in place.

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp, findIllegalJsonValue } from '../helpers/app-loader.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let app;

beforeAll(async () => {
  app = await getApp();
});

describe('extraDriveFromMainRoute regression', () => {
  it('/api/trip-options never returns NaN in numeric fields, even with sparse inputs', async () => {
    const cases = [
      { origin: 'Zagreb', destination: 'Cazin' },
      { origin: 'A', destination: 'B' }, // unknown places — exercises the fallback estimator
      { origin: 'Zagreb', destination: 'Sarajevo' },
    ];

    for (const { origin, destination } of cases) {
      const res = await request(app).get('/api/trip-options').query({ origin, destination });
      expect(res.status).toBe(200);

      for (const option of res.body.options || []) {
        expect(option.routeDurationMinutes, `route duration for ${origin}->${destination} via ${option.crossingId}`)
          .toEqual(expect.any(Number));
        expect(Number.isFinite(option.routeDurationMinutes)).toBe(true);
        expect(Number.isFinite(option.totalMinutes)).toBe(true);
      }

      const leak = findIllegalJsonValue(res.body, '$');
      expect(leak, leak || undefined).toBeNull();
    }
  });

  it('source code guards `extraDriveFromMainRoute` with `?? 0` (or equivalent)', async () => {
    // Lock the contract: anyone touching the fallback must not reintroduce the
    // unguarded read.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const serverPath = path.resolve(here, '..', '..', 'server', 'index.js');
    const src = await readFile(serverPath, 'utf8');

    const lines = src.split('\n');
    const offenders = [];
    lines.forEach((line, idx) => {
      // Match unguarded `crossing.extraDriveFromMainRoute` or `.extraDriveFromMainRoute +`
      // — anything that does NOT include `?? 0` immediately after the property.
      if (/\.extraDriveFromMainRoute\b/.test(line) && !/extraDriveFromMainRoute\s*\?\?/.test(line)) {
        offenders.push(`server/index.js:${idx + 1}: ${line.trim()}`);
      }
    });
    expect(offenders, `unguarded extraDriveFromMainRoute reads:\n${offenders.join('\n')}`).toEqual([]);
  });
});
