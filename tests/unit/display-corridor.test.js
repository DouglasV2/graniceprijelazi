// Regression tests for the problematic crossings whose map zone was wrong: too short on the HR side,
// Izačić loop, Vinjani Gornji not crossing. Every problematic crossing must have a clean calibrated
// display corridor that crosses the border with real length on BOTH sides and no U-loop — and the
// live-location anchors must stay precise (not replaced by the longer display geometry).
import { describe, it, expect } from 'vitest';
import { BORDER_CROSSINGS, makeMapFriendlyControlZoneRoute } from '../../server/index.js';
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

// Is point `p` on the same side of the border as the calibrated `anchorPoint` (dot product > 0)?
function sameSide(border, p, anchorPoint) {
  const v1x = p.lng - border.lng; const v1y = p.lat - border.lat;
  const v2x = anchorPoint.lng - border.lng; const v2y = anchorPoint.lat - border.lat;
  return (v1x * v2x + v1y * v2y) > 0;
}

function corridorFor(id, direction) {
  const anchor = BORDER_CROSSINGS[id].anchors[direction];
  const dc = anchor.routeGuard.displayCorridor;
  return { anchor, dc, corridor: buildCalibratedCorridor(anchor, { minPerSideMeters: dc.minPerSideMeters, maxPerSideMeters: dc.maxPerSideMeters }) };
}

describe('every problematic crossing has a calibrated display corridor config', () => {
  for (const id of PROBLEMATIC_DISPLAY_CROSSINGS) {
    for (const direction of ['toBih', 'toHr']) {
      it(`${id} · ${direction} has displayCorridor config`, () => {
        const dc = BORDER_CROSSINGS[id]?.anchors?.[direction]?.routeGuard?.displayCorridor;
        expect(dc, `${id}.${direction} missing displayCorridor`).toBeTruthy();
        expect(['manual', 'auto']).toContain(dc.mode);
      });
    }
  }
});

describe('calibrated display corridor crosses the border, is long enough, has no loop', () => {
  for (const id of PROBLEMATIC_DISPLAY_CROSSINGS) {
    for (const direction of ['toBih', 'toHr']) {
      it(`${id} · ${direction}: crosses + >1800m total + >500m each side + correct order + no U-loop`, () => {
        const { anchor, corridor } = corridorFor(id, direction);
        expect(corridor.length).toBeGreaterThanOrEqual(3);

        const zone = buildMeasurementZone({ path: corridor, anchor, direction });
        expect(zone.crossesBorder, `${id}.${direction} does not cross`).toBe(true);
        expect(zone.zoneDistanceKm * 1000, `${id}.${direction} too short`).toBeGreaterThan(1800);
        expect(zone.beforeBorderKm * 1000).toBeGreaterThan(500);
        expect(zone.afterBorderKm * 1000).toBeGreaterThan(500);

        // No U-loop / wrong-road artefact: turn angle small (corridor is essentially a clean line).
        const q = validateDisplayPathQuality(corridor, anchor, { minSideMeters: 500, minTotalMeters: 1800, maxWiggleRatio: 3, maxTurnDeg: 60 });
        expect(q.metrics.maxTurnDeg, `${id}.${direction} has a sharp turn/loop`).toBeLessThan(60);

        // Correct order: first point on the approach side, last point on the exit side of the border.
        expect(sameSide(anchor.borderPoint, corridor[0], anchor.approachStart)).toBe(true);
        expect(sameSide(anchor.borderPoint, corridor[corridor.length - 1], anchor.exitPoint)).toBe(true);
      });
    }
  }
});

describe('Izačić follows the main road (no loop) and Vinjani Gornji crosses the border', () => {
  it('izacic both directions: manual corridor, no U-turn, crosses', () => {
    for (const direction of ['toBih', 'toHr']) {
      const { dc, corridor, anchor } = corridorFor('izacic', direction);
      expect(dc.mode).toBe('manual');
      const q = validateDisplayPathQuality(corridor, anchor, { maxTurnDeg: 45 });
      expect(q.metrics.maxTurnDeg).toBeLessThan(45);
      expect(buildMeasurementZone({ path: corridor, anchor, direction }).crossesBorder).toBe(true);
    }
  });
  it('vinjani-gornji both directions: manual corridor crosses the border with both sides', () => {
    for (const direction of ['toBih', 'toHr']) {
      const { dc, corridor, anchor } = corridorFor('vinjani-gornji', direction);
      expect(dc.mode).toBe('manual');
      const zone = buildMeasurementZone({ path: corridor, anchor, direction });
      expect(zone.crossesBorder).toBe(true);
      expect(zone.beforeBorderKm).toBeGreaterThan(0.5);
      expect(zone.afterBorderKm).toBeGreaterThan(0.5);
    }
  });
});

describe('makeMapFriendlyControlZoneRoute end-to-end: manual fallback beats a bad Google route', () => {
  // A deliberately BAD Google path: a one-sided stub that never crosses the border.
  function oneSidedStub(anchor) {
    const b = anchor.borderPoint; const a = anchor.approachStart;
    return [
      { lat: a.lat, lng: a.lng },
      { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 },
      { lat: a.lat + (a.lat - b.lat) * 0.2, lng: a.lng + (a.lng - b.lng) * 0.2 }, // turns BACK away from border
    ];
  }

  for (const id of PROBLEMATIC_DISPLAY_CROSSINGS) {
    it(`${id}: a bad one-sided Google path is replaced by the calibrated corridor that crosses`, () => {
      const direction = 'toHr';
      const anchor = BORDER_CROSSINGS[id].anchors[direction];
      const badRoute = { path: oneSidedStub(anchor), direction, distanceMeters: 600, durationMinutes: 3, staticMinutes: 3, delayMinutes: 0, primary: true, speedReadingIntervals: [] };
      const out = makeMapFriendlyControlZoneRoute(badRoute, anchor);
      expect(out.displayGeometrySource).toBe('calibrated-display-corridor');
      expect(out.displayZone.crossesBorder).toBe(true);
      expect(out.distanceMeters).toBeGreaterThan(1800);
    });
  }

  it('manual crossings ALWAYS use the calibrated corridor, even given a long clean Google path', () => {
    const direction = 'toHr';
    const anchor = BORDER_CROSSINGS.izacic.anchors[direction];
    // a perfectly fine long crossing path — manual mode must still override it
    const good = buildCalibratedCorridor(anchor, { minPerSideMeters: 1000, maxPerSideMeters: 1500 });
    const route = { path: good, direction, distanceMeters: 2000, durationMinutes: 4, staticMinutes: 4, delayMinutes: 0, primary: true, speedReadingIntervals: [] };
    const out = makeMapFriendlyControlZoneRoute(route, anchor);
    expect(out.displayGeometrySource).toBe('calibrated-display-corridor');
  });

  it('the auto-mode quality gate still works (validateDisplayPathQuality): good crossing passes, one-sided fails', () => {
    // The 'auto' code path is retained for future crossings; verify its gate directly. (All current
    // problematic crossings are forced to mode 'manual' so the map never depends on Google there.)
    const anchor = BORDER_CROSSINGS.svilaj.anchors.toBih;
    const a = anchor.approachStart; const b = anchor.borderPoint; const e = anchor.exitPoint;
    const dense = [];
    for (let i = 0; i <= 12; i += 1) dense.push({ lat: a.lat + (b.lat - a.lat) * (i / 12), lng: a.lng + (b.lng - a.lng) * (i / 12) });
    for (let i = 1; i <= 12; i += 1) dense.push({ lat: b.lat + (e.lat - b.lat) * (i / 12), lng: b.lng + (e.lng - b.lng) * (i / 12) });
    expect(validateDisplayPathQuality(dense, anchor, { minSideMeters: 500, minTotalMeters: 1800, maxWiggleRatio: 1.9 }).ok).toBe(true);
    const oneSided = [a, { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }];
    expect(validateDisplayPathQuality(oneSided, anchor, { minSideMeters: 500, minTotalMeters: 1800 }).ok).toBe(false);
  });

  it('svilaj (now manual) renders the calibrated corridor regardless of the Google route', () => {
    const direction = 'toBih';
    const anchor = BORDER_CROSSINGS.svilaj.anchors[direction];
    const good = buildCalibratedCorridor(anchor, { minPerSideMeters: 1300, maxPerSideMeters: 1800 });
    const route = { path: good, direction, distanceMeters: 4400, durationMinutes: 6, staticMinutes: 5, delayMinutes: 1, primary: true, speedReadingIntervals: [] };
    const out = makeMapFriendlyControlZoneRoute(route, anchor);
    expect(out.displayGeometrySource).toBe('calibrated-display-corridor');
    expect(out.displayZone.crossesBorder).toBe(true);
  });
});

describe('live-location anchors are NOT replaced by the longer display geometry', () => {
  for (const id of PROBLEMATIC_DISPLAY_CROSSINGS) {
    for (const direction of ['toBih', 'toHr']) {
      it(`${id} · ${direction}: live anchors finite + equal the precise approach/exit (not the corridor)`, () => {
        const anchor = BORDER_CROSSINGS[id].anchors[direction];
        const la = buildLocationWaitAnchors(BORDER_CROSSINGS[id], direction);
        expect(la, `${id}.${direction} location anchors missing`).toBeTruthy();
        for (const p of [la.startAnchor, la.endAnchor, la.borderAnchor]) {
          expect(Number.isFinite(p.lat)).toBe(true);
          expect(Number.isFinite(p.lng)).toBe(true);
        }
        // start/end follow the PRECISE control anchors, not the extended display corridor ends.
        expect(distanceMetersLL(la.startAnchor, anchor.approachStart)).toBeLessThan(5);
        expect(distanceMetersLL(la.endAnchor, anchor.exitPoint)).toBeLessThan(5);
      });
    }
  }
});
