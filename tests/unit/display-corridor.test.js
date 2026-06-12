// Map display geometry for the problematic crossings. The displayed zone must FOLLOW THE REAL ROAD
// (Google's road-following polyline), extended on both sides and crossing the border. A clean
// straight calibrated corridor is the EMERGENCY fallback only — used when Google's geometry is
// genuinely broken (loop / one-sided / stub), never as the default.
import { describe, it, expect } from 'vitest';
import {
  BORDER_CROSSINGS,
  makeMapFriendlyControlZoneRoute,
  routeOriginAnchor,
  routeDestinationAnchor,
} from '../../server/index.js';
import {
  buildCalibratedCorridor,
  buildMeasurementZone,
  validateDisplayPathQuality,
  distanceMetersLL,
} from '../../server/map-display-geometry.js';
import { buildLocationWaitAnchors } from '../../server/location-wait-anchors.js';

const PROBLEMATIC_DISPLAY_CROSSINGS = [
  'izacic', 'vinjani-gornji', 'svilaj', 'gornji-varos', 'bijaca', 'orasje', 'brod', 'samac', 'prisika',
];

const lerp = (p, q, t) => ({ lat: p.lat + (q.lat - p.lat) * t, lng: p.lng + (q.lng - p.lng) * t });

// A realistic, road-following-ish Google path that runs well before approachStart, through the
// border, and well past the exit (dense points → survives slicing, crosses, low wiggle).
function goodThroughPath(anchor) {
  const A = anchor.approachStart; const B = anchor.borderPoint; const E = anchor.exitPoint;
  const far1 = lerp(B, A, 2.0); // 2× beyond approach
  const far2 = lerp(B, E, 2.0); // 2× beyond exit
  const pts = [];
  for (let i = 0; i < 16; i += 1) pts.push(lerp(far1, B, i / 16));
  for (let i = 0; i <= 16; i += 1) pts.push(lerp(B, far2, i / 16));
  return pts;
}

function dcOf(id, direction) {
  return BORDER_CROSSINGS[id].anchors[direction].routeGuard.displayCorridor;
}
// Per-side overrides (T1: Gornji Varoš stretches the HR side independently) fall back to the
// symmetric values — the same resolution the server uses. A side may also have NO extension at
// all (GV's BiH motorway side — extending there hits the one-way carriageway snap trap), so the
// meaningful invariant is the EFFECTIVE request reach from the border, not the raw config key.
const sliceBefore = (dc) => dc.sliceBeforeMeters ?? dc.sliceMeters;
const sliceAfter = (dc) => dc.sliceAfterMeters ?? dc.sliceMeters;
function requestReach(anchor) {
  return {
    origin: distanceMetersLL(anchor.borderPoint, routeOriginAnchor(anchor)),
    destination: distanceMetersLL(anchor.borderPoint, routeDestinationAnchor(anchor)),
  };
}
function fallbackCorridor(id, direction) {
  const anchor = BORDER_CROSSINGS[id].anchors[direction];
  const dc = dcOf(id, direction);
  return { anchor, corridor: buildCalibratedCorridor(anchor, { minPerSideMeters: dc.fallbackPerSideMeters, maxPerSideMeters: dc.fallbackMaxPerSideMeters }) };
}

describe('every problematic crossing has display-corridor config (extend + slice + fallback)', () => {
  for (const id of PROBLEMATIC_DISPLAY_CROSSINGS) {
    for (const direction of ['toBih', 'toHr']) {
      it(`${id} · ${direction} has request reach + sliceMeters + fallback sizes`, () => {
        const dc = dcOf(id, direction);
        expect(dc).toBeTruthy();
        const reach = requestReach(BORDER_CROSSINGS[id].anchors[direction]);
        expect(Math.min(reach.origin, reach.destination)).toBeGreaterThanOrEqual(1200);
        expect(Math.min(sliceBefore(dc), sliceAfter(dc))).toBeGreaterThanOrEqual(1400);
        expect(dc.fallbackPerSideMeters).toBeGreaterThanOrEqual(1000);
      });
    }
  }
});

describe('the Google request reaches FURTHER along the road than the precise anchor (extends the zone)', () => {
  for (const id of PROBLEMATIC_DISPLAY_CROSSINGS) {
    for (const direction of ['toBih', 'toHr']) {
      it(`${id} · ${direction}: origin/destination are pushed out from the border`, () => {
        const anchor = BORDER_CROSSINGS[id].anchors[direction];
        const origin = routeOriginAnchor(anchor);
        const dest = routeDestinationAnchor(anchor);
        // Each request endpoint must be at least as far from the border as the precise anchor
        // (so Google draws at least the full calibrated road per side).
        expect(distanceMetersLL(anchor.borderPoint, origin)).toBeGreaterThanOrEqual(distanceMetersLL(anchor.borderPoint, anchor.approachStart) - 1);
        expect(distanceMetersLL(anchor.borderPoint, origin)).toBeGreaterThan(900);
        expect(distanceMetersLL(anchor.borderPoint, dest)).toBeGreaterThan(900);
      });
    }
  }
});

describe('makeMapFriendly PREFERS the road-following Google route', () => {
  for (const id of PROBLEMATIC_DISPLAY_CROSSINGS) {
    it(`${id}: a good road-following Google path is KEPT (not replaced by a straight corridor)`, () => {
      const direction = 'toBih';
      const anchor = BORDER_CROSSINGS[id].anchors[direction];
      const route = { path: goodThroughPath(anchor), direction, distanceMeters: 5000, durationMinutes: 6, staticMinutes: 5, delayMinutes: 1, primary: true, speedReadingIntervals: [] };
      const out = makeMapFriendlyControlZoneRoute(route, anchor);
      expect(out.displayGeometrySource).toBe('google-sliced-control-zone');
      expect(out.displayZone.crossesBorder).toBe(true);
      // It kept the real (multi-point) road geometry, not a 3-point straight line.
      expect(out.path.length).toBeGreaterThan(3);
    });
  }
});

describe('makeMapFriendly falls back to a clean corridor ONLY when Google is broken', () => {
  function oneSidedStub(anchor) {
    const a = anchor.approachStart; const b = anchor.borderPoint;
    return [a, lerp(a, b, 0.4), lerp(a, b, 0.2)]; // never reaches the border, turns back
  }
  function uTurnLoop(anchor) {
    const a = anchor.approachStart; const b = anchor.borderPoint;
    return [a, lerp(a, b, 0.6), b, lerp(a, b, 0.6), a]; // out-and-back over the border = loop
  }
  for (const id of PROBLEMATIC_DISPLAY_CROSSINGS) {
    it(`${id}: a one-sided stub → clean corridor that crosses`, () => {
      const direction = 'toHr';
      const anchor = BORDER_CROSSINGS[id].anchors[direction];
      const route = { path: oneSidedStub(anchor), direction, distanceMeters: 500, durationMinutes: 2, staticMinutes: 2, delayMinutes: 0, primary: true, speedReadingIntervals: [] };
      const out = makeMapFriendlyControlZoneRoute(route, anchor);
      expect(out.displayGeometrySource).toBe('clean-anchor-corridor');
      expect(out.displayZone.crossesBorder).toBe(true);
      expect(out.distanceMeters).toBeGreaterThan(1800);
    });
  }
  it('a looping Google path is rejected (validateDisplayPathQuality catches the U-turn/wiggle)', () => {
    const anchor = BORDER_CROSSINGS.izacic.anchors.toBih;
    const q = validateDisplayPathQuality(uTurnLoop(anchor), anchor, { maxWiggleRatio: 1.8 });
    expect(q.ok).toBe(false);
  });
});

describe('the emergency fallback corridor itself crosses + is long enough + has no loop', () => {
  for (const id of PROBLEMATIC_DISPLAY_CROSSINGS) {
    for (const direction of ['toBih', 'toHr']) {
      it(`${id} · ${direction}: fallback corridor crosses, >1800m, >500m/side, no U-loop`, () => {
        const { anchor, corridor } = fallbackCorridor(id, direction);
        const zone = buildMeasurementZone({ path: corridor, anchor, direction });
        expect(zone.crossesBorder).toBe(true);
        expect(zone.zoneDistanceKm * 1000).toBeGreaterThan(1800);
        expect(zone.beforeBorderKm * 1000).toBeGreaterThan(500);
        expect(zone.afterBorderKm * 1000).toBeGreaterThan(500);
        const q = validateDisplayPathQuality(corridor, anchor, { maxTurnDeg: 60 });
        expect(q.metrics.maxTurnDeg).toBeLessThan(60);
      });
    }
  }
});

describe('live-location anchors are NOT changed by the display geometry', () => {
  for (const id of PROBLEMATIC_DISPLAY_CROSSINGS) {
    for (const direction of ['toBih', 'toHr']) {
      it(`${id} · ${direction}: live anchors finite + equal the precise approach/exit`, () => {
        const anchor = BORDER_CROSSINGS[id].anchors[direction];
        const la = buildLocationWaitAnchors(BORDER_CROSSINGS[id], direction);
        expect(la).toBeTruthy();
        for (const p of [la.startAnchor, la.endAnchor, la.borderAnchor]) {
          expect(Number.isFinite(p.lat)).toBe(true);
          expect(Number.isFinite(p.lng)).toBe(true);
        }
        expect(distanceMetersLL(la.startAnchor, anchor.approachStart)).toBeLessThan(5);
        expect(distanceMetersLL(la.endAnchor, anchor.exitPoint)).toBeLessThan(5);
      });
    }
  }
});
