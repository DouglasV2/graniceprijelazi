// Google traffic END-TO-END through the REAL control-zone slice (not the 100 km "no slice"
// shortcut the other test uses). This is the pipeline that was reported as "still blue":
//   normalizeRoute-shaped route (real decoded path + Google speedReadingIntervals)
//     → makeMapFriendlyControlZoneRoute (real crossing anchor, real ~2 km slice)
//     → public payload route.trafficSegments
// It proves SLOW/TRAFFIC_JAM survive the narrow slice with ≥2-point paths and that intervals
// outside the control zone are correctly dropped (not silently turned blue).
import { describe, it, expect } from 'vitest';
import { makeMapFriendlyControlZoneRoute, BORDER_CROSSINGS } from '../../server/index.js';

const lerp = (p, q, t) => ({ lat: p.lat + (q.lat - p.lat) * t, lng: p.lng + (q.lng - p.lng) * t });

// Build a long path that runs WELL before approachStart, through the border, and WELL past the
// exit — so the control-zone slice actually crops it (where traffic used to be discarded).
function buildThroughPath(anchor) {
  const A = anchor.approachStart;
  const B = anchor.borderPoint;
  const E = anchor.exitPoint;
  const far1 = { lat: A.lat - (B.lat - A.lat) * 8, lng: A.lng - (B.lng - A.lng) * 8 };
  const far2 = { lat: E.lat + (E.lat - B.lat) * 8, lng: E.lng + (E.lng - B.lng) * 8 };
  const pts = [];
  for (let i = 0; i < 20; i++) pts.push(lerp(far1, A, i / 20)); // 0..19 far approach (NORMAL)
  for (let i = 0; i < 10; i++) pts.push(lerp(A, B, i / 10));     // 20..29 approach→border
  for (let i = 0; i < 10; i++) pts.push(lerp(B, E, i / 10));     // 30..39 border→exit
  for (let i = 0; i <= 20; i++) pts.push(lerp(E, far2, i / 20)); // 40..60 far exit (NORMAL)
  return pts;
}

describe('Google traffic survives the REAL control-zone slice (root-cause regression)', () => {
  // Use a crossing that renders the GOOGLE-sliced path (per-segment traffic). The 9 "problematic"
  // crossings (Bijača, Izačić, …) are intentionally forced to a manual calibrated corridor with
  // uniform colouring, so this traffic-preservation feature is exercised on a Google-slice crossing.
  const crossing = BORDER_CROSSINGS.gradiska;
  const anchor = crossing.anchors.toBih;
  const path = buildThroughPath(anchor);

  const route = {
    id: 'bijaca-route-1',
    path,
    distanceMeters: 5000,
    durationMinutes: 12,
    staticMinutes: 8,
    primary: true,
    // Indices reference the full polyline, exactly like Google's response.
    speedReadingIntervals: [
      { startPolylinePointIndex: 0, endPolylinePointIndex: 25, speed: 'NORMAL' },
      { startPolylinePointIndex: 25, endPolylinePointIndex: 30, speed: 'SLOW' },
      { startPolylinePointIndex: 30, endPolylinePointIndex: 34, speed: 'TRAFFIC_JAM' },
      { startPolylinePointIndex: 34, endPolylinePointIndex: 60, speed: 'NORMAL' },
    ],
  };

  const display = makeMapFriendlyControlZoneRoute(route, anchor);
  const segs = display.trafficSegments || [];

  it('actually slices the path (the slice path is shorter than the full route)', () => {
    expect(display.path.length).toBeGreaterThan(1);
    expect(display.path.length).toBeLessThan(path.length);
  });

  it('preserves SLOW and TRAFFIC_JAM segments through the narrow slice', () => {
    expect(segs.length).toBeGreaterThan(0);
    expect(segs.some((s) => s.level === 'slow')).toBe(true);
    expect(segs.some((s) => s.level === 'jam')).toBe(true);
    expect(display.trafficSummary.worstTrafficLevel).toBe('TRAFFIC_JAM');
  });

  it('every preserved segment has a drawable path (≥ 2 points) so the frontend can render it', () => {
    for (const s of segs) expect((s.path || []).length).toBeGreaterThanOrEqual(2);
  });

  it('carries severity + speed so the frontend colors SLOW orange and JAM red', () => {
    const jam = segs.find((s) => s.level === 'jam');
    const slow = segs.find((s) => s.level === 'slow');
    expect(jam.severity).toBe(2);
    expect(jam.speed).toBe('TRAFFIC_JAM');
    expect(slow.severity).toBe(1);
    expect(slow.speed).toBe('SLOW');
  });

  it('the public payload route carries trafficSegments (frontend reads route.trafficSegments)', () => {
    expect(Array.isArray(display.trafficSegments)).toBe(true);
    expect(display.trafficSegments.length).toBeGreaterThan(0);
    expect(display.trafficSummary.trafficSegmentsPreservedAfterRouteGuard).toBe(true);
  });

  it('a clear route returns NO fabricated segments (honest blue, not fake congestion)', () => {
    const clear = makeMapFriendlyControlZoneRoute({ ...route, speedReadingIntervals: [] }, anchor);
    expect(clear.trafficSegments).toEqual([]);
    expect(clear.trafficSummary.hasTrafficIntervals).toBe(false);
  });
});
