// Structural checks for every crossing's route anchors, both directions (2026-05-29).
// Guards against the "control zone too short → straight-line fallback that misses the queue"
// defect that affected Vinjani Gornji/Donji: every direction must define approach/border/exit
// anchors and span a non-degenerate control zone.

import { describe, it, expect } from 'vitest';
import { BORDER_CROSSINGS } from '../../server/index.js';

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
