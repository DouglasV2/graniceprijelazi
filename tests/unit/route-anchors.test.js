// Structural checks for every crossing's route anchors, both directions (2026-05-29).
// Guards against the "control zone too short → straight-line fallback that misses the queue"
// defect that affected Vinjani Gornji/Donji: every direction must define approach/border/exit
// anchors and span a non-degenerate control zone.

import { describe, it, expect } from 'vitest';
import { BORDER_CROSSINGS, makeMapFriendlyControlZoneRoute, routeOriginAnchor } from '../../server/index.js';
import { buildMeasurementZone, pathCrossesBorder } from '../../server/map-display-geometry.js';
import { buildLocationWaitAnchors } from '../../server/location-wait-anchors.js';

function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const MIN_ZONE_METERS = 250; // shorter than this and Google can't return a road-following polyline

const crossingIds = Object.keys(BORDER_CROSSINGS);

describe('every crossing has valid anchors in both directions', () => {
  it('covers a non-trivial set of crossings', () => {
    expect(crossingIds.length).toBeGreaterThanOrEqual(14);
  });

  for (const id of crossingIds) {
    for (const direction of ['toBih', 'toHr']) {
      it(`${id} · ${direction} has approach/border/exit and a >=${MIN_ZONE_METERS}m zone`, () => {
        const anchor = BORDER_CROSSINGS[id].anchors[direction];
        expect(anchor, `${id}.${direction} missing`).toBeTruthy();
        for (const key of ['approachStart', 'borderPoint', 'exitPoint']) {
          expect(Number.isFinite(anchor[key]?.lat), `${id}.${direction}.${key}.lat`).toBe(true);
          expect(Number.isFinite(anchor[key]?.lng), `${id}.${direction}.${key}.lng`).toBe(true);
        }
        const zone = distanceMeters(anchor.approachStart, anchor.exitPoint);
        expect(zone, `${id}.${direction} zone ${Math.round(zone)}m too short`).toBeGreaterThanOrEqual(MIN_ZONE_METERS);
      });
    }
  }
});

describe('opposite directions are mirror images (border point shared)', () => {
  // Dual-carriageway crossings legitimately use per-direction border points (one per one-way
  // lane — a mid-bridge via point snaps to the WRONG carriageway and Google returns NO ROUTES).
  // They must still sit within a couple hundred metres on the same bridge.
  const PER_CARRIAGEWAY_BORDER = new Set(['gornji-varos']);
  for (const id of crossingIds) {
    it(`${id} shares the border point across directions`, () => {
      const a = BORDER_CROSSINGS[id].anchors.toBih.borderPoint;
      const b = BORDER_CROSSINGS[id].anchors.toHr.borderPoint;
      expect(distanceMeters(a, b)).toBeLessThan(PER_CARRIAGEWAY_BORDER.has(id) ? 250 : 50);
    });
  }
});

// The displayed "Provjerena zona" must straddle the border with real road on BOTH sides. We test the
// no-Google fallback (buildMeasurementZone with an empty path → clean calibrated corridor), which is
// also the worst case: if even the straight corridor crosses, the Google-followed road does too.
describe('display zone crosses the border (no-Google fallback corridor)', () => {
  for (const id of crossingIds) {
    for (const direction of ['toBih', 'toHr']) {
      it(`${id} · ${direction} fallback corridor includes BOTH sides of the border`, () => {
        const anchor = BORDER_CROSSINGS[id].anchors[direction];
        const zone = buildMeasurementZone({ path: [], anchor, direction });
        expect(zone.ok).toBe(true);
        expect(zone.crossesBorder).toBe(true);
        expect(zone.beforeBorderKm).toBeGreaterThan(0);
        expect(zone.afterBorderKm).toBeGreaterThan(0);
        expect(zone.zoneDistanceKm).toBeGreaterThan(0.25);
      });
    }
  }
});

describe('Maljevac display route follows the road (Google), no off-road spur, crosses', () => {
  const lerp = (p, q, t) => ({ lat: p.lat + (q.lat - p.lat) * t, lng: p.lng + (q.lng - p.lng) * t });
  // A dense, road-following-ish Google path that runs beyond approach, through the border, beyond exit.
  function goodPath(anchor) {
    const A = anchor.approachStart; const B = anchor.borderPoint; const E = anchor.exitPoint;
    const far1 = lerp(B, A, 1.8); const far2 = lerp(B, E, 1.8);
    const pts = [];
    for (let i = 0; i < 14; i += 1) pts.push(lerp(far1, B, i / 14));
    for (let i = 0; i <= 14; i += 1) pts.push(lerp(B, far2, i / 14));
    return pts;
  }

  it('the off-road display anchors are removed (root cause of the HR-side spur)', () => {
    for (const direction of ['toBih', 'toHr']) {
      const a = BORDER_CROSSINGS.maljevac.anchors[direction];
      expect(a.displayApproachStart).toBeUndefined();
      expect(a.displayExitPoint).toBeUndefined();
      expect(a.routeGuard.displayCorridor).toBeTruthy();
    }
  });

  for (const direction of ['toBih', 'toHr']) {
    it(`maljevac · ${direction}: a good Google path is KEPT (road-like, not a 3-point straight line) + crosses`, () => {
      const anchor = BORDER_CROSSINGS.maljevac.anchors[direction];
      const route = { path: goodPath(anchor), direction, distanceMeters: 4000, durationMinutes: 6, staticMinutes: 5, delayMinutes: 1, primary: true, speedReadingIntervals: [] };
      const out = makeMapFriendlyControlZoneRoute(route, anchor);
      expect(out.displayGeometrySource).toBe('google-sliced-control-zone');
      expect(out.displayZone.crossesBorder).toBe(true);
      expect(out.path.length).toBeGreaterThan(3); // road-like, NOT a straight 3-point corridor
    });
  }

  it('the Google REQUEST extends beyond the precise anchor but NOT to the old off-road 1.25km point', () => {
    const a = BORDER_CROSSINGS.maljevac.anchors.toBih;
    const origin = routeOriginAnchor(a);
    const dFromBorder = distanceMeters(a.borderPoint, origin);
    const dPrecise = distanceMeters(a.borderPoint, a.approachStart);
    expect(dFromBorder).toBeGreaterThanOrEqual(dPrecise - 1); // at least as far as the precise anchor
    expect(dFromBorder).toBeLessThan(1150);                   // modest — not the off-road 1.25km overshoot
  });

  it('a one-sided / spur Google path falls back to a corridor that still crosses (emergency only)', () => {
    const anchor = BORDER_CROSSINGS.maljevac.anchors.toHr;
    const stub = [anchor.approachStart, lerp(anchor.approachStart, anchor.borderPoint, 0.3)]; // never crosses
    const route = { path: stub, direction: 'toHr', distanceMeters: 400, durationMinutes: 2, staticMinutes: 2, delayMinutes: 0, primary: true, speedReadingIntervals: [] };
    const out = makeMapFriendlyControlZoneRoute(route, anchor);
    expect(out.displayGeometrySource).toBe('clean-anchor-corridor');
    expect(out.displayZone.crossesBorder).toBe(true);
  });
});

describe('live-location anchors stay precise + finite (unchanged by the Maljevac route fix)', () => {
  for (const direction of ['toBih', 'toHr']) {
    it(`maljevac · ${direction} location-wait anchors finite + equal the precise control anchors`, () => {
      const anchor = BORDER_CROSSINGS.maljevac.anchors[direction];
      const la = buildLocationWaitAnchors(BORDER_CROSSINGS.maljevac, direction);
      expect(la).toBeTruthy();
      for (const a of [la.startAnchor, la.endAnchor, la.borderAnchor]) {
        expect(Number.isFinite(a.lat)).toBe(true);
        expect(Number.isFinite(a.lng)).toBe(true);
      }
      expect(distanceMeters(la.startAnchor, anchor.approachStart)).toBeLessThan(5);
      expect(distanceMeters(la.endAnchor, anchor.exitPoint)).toBeLessThan(5);
    });
  }

  it('the precise Maljevac control zone stays SHORT (route-guard + live measurement tight)', () => {
    for (const direction of ['toBih', 'toHr']) {
      const a = BORDER_CROSSINGS.maljevac.anchors[direction];
      expect(distanceMeters(a.approachStart, a.exitPoint)).toBeLessThan(1500);
    }
  });
});
