// Structural checks for every crossing's route anchors, both directions (2026-05-29).
// Guards against the "control zone too short → straight-line fallback that misses the queue"
// defect that affected Vinjani Gornji/Donji: every direction must define approach/border/exit
// anchors and span a non-degenerate control zone.

import { describe, it, expect } from 'vitest';
import { BORDER_CROSSINGS } from '../../server/index.js';
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
  for (const id of crossingIds) {
    it(`${id} shares the border point across directions`, () => {
      const a = BORDER_CROSSINGS[id].anchors.toBih.borderPoint;
      const b = BORDER_CROSSINGS[id].anchors.toHr.borderPoint;
      expect(distanceMeters(a, b)).toBeLessThan(50);
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

describe('Maljevac display zone is longer + crosses the border (both directions)', () => {
  const MIN_SIDE_M = 500;
  const MIN_TOTAL_M = 1800;
  for (const direction of ['toBih', 'toHr']) {
    it(`maljevac · ${direction} crosses border, >${MIN_SIDE_M}m each side, >${MIN_TOTAL_M}m total`, () => {
      const anchor = BORDER_CROSSINGS.maljevac.anchors[direction];
      const zone = buildMeasurementZone({ path: [], anchor, direction });
      expect(zone.crossesBorder).toBe(true);
      expect(zone.beforeBorderKm * 1000).toBeGreaterThan(MIN_SIDE_M);
      expect(zone.afterBorderKm * 1000).toBeGreaterThan(MIN_SIDE_M);
      expect(zone.zoneDistanceKm * 1000).toBeGreaterThan(MIN_TOTAL_M);
      // realistic upper bound — still a "zone", not a city route
      expect(zone.zoneDistanceKm).toBeLessThan(3.6);
    });
  }

  it('maljevac toHr goes BiH approach → border → HR exit (correct order, ends on HR side)', () => {
    const anchor = BORDER_CROSSINGS.maljevac.anchors.toHr;
    const zone = buildMeasurementZone({ path: [], anchor, direction: 'toHr' });
    // BiH side is east (higher lng), HR side is west (lower lng); border lng sits between them.
    expect(zone.approachAnchor.lng).toBeGreaterThan(zone.borderAnchor.lng); // approach on BiH side
    expect(zone.exitAnchor.lng).toBeLessThan(zone.borderAnchor.lng);        // exit on HR side
    expect(zone.exitAnchor).toEqual(anchor.displayExitPoint);               // ends at the HR exit anchor
  });

  it('maljevac toBih goes HR approach → border → BiH exit (correct order)', () => {
    const anchor = BORDER_CROSSINGS.maljevac.anchors.toBih;
    const zone = buildMeasurementZone({ path: [], anchor, direction: 'toBih' });
    expect(zone.approachAnchor.lng).toBeLessThan(zone.borderAnchor.lng);    // approach on HR side
    expect(zone.exitAnchor.lng).toBeGreaterThan(zone.borderAnchor.lng);     // exit on BiH side
  });

  it('a one-sided Google path for Maljevac falls back to a corridor that still crosses', () => {
    const anchor = BORDER_CROSSINGS.maljevac.anchors.toHr;
    // a stub that stays on the BiH side and never reaches HR
    const stub = [{ lat: 45.1889, lng: 15.8089 }, { lat: 45.1925, lng: 15.8030 }, { lat: 45.1945, lng: 15.7985 }];
    const zone = buildMeasurementZone({ path: stub, anchor, direction: 'toHr' });
    expect(zone.geometrySource).toBe('clean-anchor-corridor');
    expect(zone.crossesBorder).toBe(true);
  });
});

// Live-location must keep using the PRECISE short anchors, never the extended display anchors.
describe('live-location anchors stay precise + finite (not replaced by display/Google geometry)', () => {
  for (const direction of ['toBih', 'toHr']) {
    it(`maljevac · ${direction} location-wait anchors are finite + equal the precise control anchors`, () => {
      const anchor = BORDER_CROSSINGS.maljevac.anchors[direction];
      const la = buildLocationWaitAnchors(BORDER_CROSSINGS.maljevac, direction);
      expect(la).toBeTruthy();
      for (const a of [la.startAnchor, la.endAnchor, la.borderAnchor]) {
        expect(Number.isFinite(a.lat)).toBe(true);
        expect(Number.isFinite(a.lng)).toBe(true);
      }
      // start/end follow the PRECISE approachStart/exitPoint, NOT the extended display anchors.
      expect(distanceMeters(la.startAnchor, anchor.approachStart)).toBeLessThan(5);
      expect(distanceMeters(la.endAnchor, anchor.exitPoint)).toBeLessThan(5);
      expect(distanceMeters(la.startAnchor, anchor.displayApproachStart)).toBeGreaterThan(500);
      expect(distanceMeters(la.endAnchor, anchor.displayExitPoint)).toBeGreaterThan(500);
    });
  }

  it('the precise Maljevac control zone stays SHORT (so route-guard + live measurement are tight)', () => {
    for (const direction of ['toBih', 'toHr']) {
      const a = BORDER_CROSSINGS.maljevac.anchors[direction];
      // precise approachStart → exitPoint is the tight control zone, well under the display corridor
      expect(distanceMeters(a.approachStart, a.exitPoint)).toBeLessThan(1500);
    }
  });
});
