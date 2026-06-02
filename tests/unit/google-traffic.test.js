// Google traffic-aware route signal (root cause: speedReadingIntervals were dropped on
// control-zone slicing → the map was always blue). These cover parsing, the slicing remap,
// the summary, and that traffic survives the route guard.
import { describe, it, expect } from 'vitest';
import {
  buildTrafficSegments,
  buildTrafficSummary,
  remapSpeedReadingIntervals,
  makeMapFriendlyControlZoneRoute,
} from '../../server/index.js';

// A straight east-west path of 11 points (~ each ~100 m apart for the test).
const path = Array.from({ length: 11 }, (_, i) => ({ lat: 45.10, lng: 18.30 + i * 0.001 }));

describe('buildTrafficSegments (A. parsing)', () => {
  it('maps speedReadingIntervals into NORMAL/SLOW/TRAFFIC_JAM segments', () => {
    const intervals = [
      { startPolylinePointIndex: 0, endPolylinePointIndex: 3, speed: 'NORMAL' },
      { startPolylinePointIndex: 3, endPolylinePointIndex: 6, speed: 'SLOW' },
      { startPolylinePointIndex: 6, endPolylinePointIndex: 10, speed: 'TRAFFIC_JAM' },
    ];
    const segs = buildTrafficSegments(path, intervals);
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.level)).toEqual(['normal', 'slow', 'jam']);
    expect(segs[1].path.length).toBeGreaterThanOrEqual(2);
  });
  it('returns nothing without intervals (so the route stays plain blue)', () => {
    expect(buildTrafficSegments(path, [])).toEqual([]);
  });
});

describe('buildTrafficSummary (A. summary)', () => {
  it('counts slow/jam segments and picks the worst level', () => {
    const segs = buildTrafficSegments(path, [
      { startPolylinePointIndex: 0, endPolylinePointIndex: 4, speed: 'SLOW' },
      { startPolylinePointIndex: 4, endPolylinePointIndex: 9, speed: 'TRAFFIC_JAM' },
    ]);
    const summary = buildTrafficSummary(segs);
    expect(summary.hasTrafficIntervals).toBe(true);
    expect(summary.slowSegmentCount).toBe(1);
    expect(summary.trafficJamSegmentCount).toBe(1);
    expect(summary.worstTrafficLevel).toBe('TRAFFIC_JAM');
    expect(summary.affectedMeters).toBeGreaterThan(0);
  });
  it('empty → UNKNOWN worst level', () => {
    expect(buildTrafficSummary([]).worstTrafficLevel).toBe('UNKNOWN');
  });
});

describe('remapSpeedReadingIntervals (B. slicing remap)', () => {
  it('remaps a jam interval onto the sliced sub-path with local indices', () => {
    // Original 100-pt route, control-zone slice uses points 40–70.
    const intervals = [{ startPolylinePointIndex: 50, endPolylinePointIndex: 60, speed: 'TRAFFIC_JAM' }];
    const remapped = remapSpeedReadingIntervals(intervals, 40, 70);
    expect(remapped).toHaveLength(1);
    expect(remapped[0].startPolylinePointIndex).toBe(10);
    expect(remapped[0].endPolylinePointIndex).toBe(20);
    expect(remapped[0].speed).toBe('TRAFFIC_JAM');
  });
  it('drops intervals fully outside the slice and clips partial overlaps', () => {
    const intervals = [
      { startPolylinePointIndex: 0, endPolylinePointIndex: 30, speed: 'SLOW' }, // before slice → dropped
      { startPolylinePointIndex: 65, endPolylinePointIndex: 90, speed: 'SLOW' }, // clipped to 65–70
    ];
    const remapped = remapSpeedReadingIntervals(intervals, 40, 70);
    expect(remapped).toHaveLength(1);
    expect(remapped[0].startPolylinePointIndex).toBe(25);
    expect(remapped[0].endPolylinePointIndex).toBe(30);
  });
  it('no intervals → empty', () => {
    expect(remapSpeedReadingIntervals([], 40, 70)).toEqual([]);
  });
});

describe('makeMapFriendlyControlZoneRoute (B. traffic survives the route guard)', () => {
  const anchor = { borderPoint: { lat: 45.10, lng: 18.305 }, routeGuard: { displayBeforeMeters: 100000, displayAfterMeters: 100000 } };

  it('preserves traffic segments after slicing (was the bug: buildTrafficSegments(displayPath, []))', () => {
    const route = {
      path,
      distanceMeters: 1000,
      durationMinutes: 10,
      staticMinutes: 8,
      speedReadingIntervals: [{ startPolylinePointIndex: 2, endPolylinePointIndex: 8, speed: 'TRAFFIC_JAM' }],
    };
    const display = makeMapFriendlyControlZoneRoute(route, anchor);
    expect(display.trafficSegments.length).toBeGreaterThan(0);
    expect(display.trafficSummary.worstTrafficLevel).toBe('TRAFFIC_JAM');
    expect(display.trafficSummary.trafficSegmentsPreservedAfterRouteGuard).toBe(true);
  });

  it('a route with no traffic intervals stays blue (no fabricated segments)', () => {
    const route = { path, distanceMeters: 1000, durationMinutes: 10, staticMinutes: 10, speedReadingIntervals: [] };
    const display = makeMapFriendlyControlZoneRoute(route, anchor);
    expect(display.trafficSegments).toEqual([]);
    expect(display.trafficSummary.worstTrafficLevel).toBe('UNKNOWN');
  });
});
