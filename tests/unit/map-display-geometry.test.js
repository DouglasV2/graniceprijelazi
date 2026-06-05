// Map "Provjerena zona" display geometry — pure tests (Problem D).
import { describe, it, expect } from 'vitest';
import {
  distanceMetersLL,
  pathLengthMeters,
  simplifyPath,
  corridorPolygon,
  buildMeasurementZone,
  pathCrossesBorder,
} from '../../server/map-display-geometry.js';

// A short ~2 km path roughly across a border, with a couple of deliberate wiggles.
const border = { lat: 45.10, lng: 16.00 };
const anchor = {
  approachStart: { lat: 45.090, lng: 16.000 },
  borderPoint: border,
  exitPoint: { lat: 45.110, lng: 16.000 },
};
function wigglyPath() {
  const pts = [];
  for (let i = 0; i <= 20; i += 1) {
    const lat = 45.090 + i * 0.001;
    // small east/west zig-zag (~a few metres) that should be simplified away
    const lng = 16.0 + (i % 2 === 0 ? 0.00004 : -0.00004);
    pts.push({ lat, lng });
  }
  return pts;
}

describe('geometry helpers', () => {
  it('distanceMetersLL ~ 111 m per 0.001 deg latitude', () => {
    expect(distanceMetersLL({ lat: 45, lng: 16 }, { lat: 45.001, lng: 16 })).toBeGreaterThan(100);
    expect(distanceMetersLL({ lat: 45, lng: 16 }, { lat: 45.001, lng: 16 })).toBeLessThan(120);
  });
  it('pathLengthMeters sums segment lengths', () => {
    expect(pathLengthMeters(wigglyPath())).toBeGreaterThan(2000);
  });
  it('simplifyPath drops wiggle points but keeps endpoints', () => {
    const raw = wigglyPath();
    const simplified = simplifyPath(raw, 18);
    expect(simplified.length).toBeLessThan(raw.length);
    expect(simplified[0]).toEqual(raw[0]);
    expect(simplified[simplified.length - 1]).toEqual(raw[raw.length - 1]);
  });
  it('corridorPolygon returns a closed ribbon (first === last)', () => {
    const poly = corridorPolygon([anchor.approachStart, border, anchor.exitPoint], 55);
    expect(poly.length).toBeGreaterThanOrEqual(5);
    expect(poly[0]).toEqual(poly[poly.length - 1]);
  });
});

describe('buildMeasurementZone', () => {
  it('produces a tidy display model with anchors, simplified corridor + zone polygon', () => {
    const zone = buildMeasurementZone({ path: wigglyPath(), anchor, direction: 'toBih' });
    expect(zone.ok).toBe(true);
    expect(zone.borderAnchor).toEqual(border);
    expect(zone.approachAnchor).toEqual(anchor.approachStart);
    expect(zone.exitAnchor).toEqual(anchor.exitPoint);
    expect(zone.displayCorridorPolyline.length).toBeLessThan(wigglyPath().length); // de-wiggled
    expect(zone.measurementZonePolygon.length).toBeGreaterThanOrEqual(5);
    expect(zone.zoneDistanceKm).toBeGreaterThan(1.5);
    expect(zone.zoneDistanceKm).toBeLessThan(3);
  });
  it('falls back to the anchor corridor when the path is unusable (no crash)', () => {
    const zone = buildMeasurementZone({ path: [], anchor, direction: 'toHr' });
    expect(zone.displayCorridorPolyline.length).toBeGreaterThanOrEqual(2);
    expect(zone.borderAnchor).toEqual(border);
  });
  it('insufficient geometry → ok:false but still safe shape', () => {
    const zone = buildMeasurementZone({ path: [], anchor: {}, direction: 'toBih' });
    expect(zone.ok).toBe(false);
    expect(zone.reason).toBe('insufficient-geometry');
    expect(Array.isArray(zone.measurementZonePolygon)).toBe(true);
  });
  it('does not invent anchors from garbage points', () => {
    const zone = buildMeasurementZone({ path: [{ lat: 'x', lng: null }, {}], anchor: {}, direction: 'toBih' });
    expect(zone.ok).toBe(false);
  });
});

describe('pathCrossesBorder', () => {
  const border = { lat: 45.10, lng: 16.00 };
  it('a path with real length on both sides crosses', () => {
    const r = pathCrossesBorder(wigglyPath(), border, { minSideMeters: 250 });
    expect(r.crosses).toBe(true);
    expect(r.beforeMeters).toBeGreaterThan(250);
    expect(r.afterMeters).toBeGreaterThan(250);
  });
  it('a one-sided path (entirely before the border) does NOT cross', () => {
    const oneSide = [];
    for (let i = 0; i <= 10; i += 1) oneSide.push({ lat: 45.080 + i * 0.001, lng: 16.0 }); // ends at 45.090, below border 45.10
    expect(pathCrossesBorder(oneSide, border).crosses).toBe(false);
  });
  it('a path that never comes near the border does NOT cross', () => {
    const elsewhere = [{ lat: 44.0, lng: 17.0 }, { lat: 44.02, lng: 17.0 }];
    expect(pathCrossesBorder(elsewhere, border).crosses).toBe(false);
  });
});

describe('buildMeasurementZone must-cross + display anchors', () => {
  const border = { lat: 45.10, lng: 16.00 };
  const anchorWithDisplay = {
    approachStart: { lat: 45.095, lng: 16.0 },
    borderPoint: border,
    exitPoint: { lat: 45.105, lng: 16.0 },
    displayApproachStart: { lat: 45.085, lng: 16.0 }, // ~1.7km before border
    displayExitPoint: { lat: 45.115, lng: 16.0 },     // ~1.7km after border
  };
  it('uses the EXTENDED display anchors for the corridor ends', () => {
    const zone = buildMeasurementZone({ path: [], anchor: anchorWithDisplay, direction: 'toBih' });
    expect(zone.approachAnchor).toEqual(anchorWithDisplay.displayApproachStart);
    expect(zone.exitAnchor).toEqual(anchorWithDisplay.displayExitPoint);
    expect(zone.crossesBorder).toBe(true);
    expect(zone.zoneDistanceKm).toBeGreaterThan(3); // ~3.4km across the extended corridor
  });
  it('a one-sided Google path falls back to the clean corridor that DOES cross', () => {
    const oneSided = [{ lat: 45.085, lng: 16.0 }, { lat: 45.090, lng: 16.0 }, { lat: 45.095, lng: 16.0 }]; // all before border
    const zone = buildMeasurementZone({ path: oneSided, anchor: anchorWithDisplay, direction: 'toHr' });
    expect(zone.geometrySource).toBe('clean-anchor-corridor');
    expect(zone.crossesBorder).toBe(true);
  });
});
