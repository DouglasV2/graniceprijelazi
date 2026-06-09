import { describe, it, expect } from 'vitest';
import { routeGeometryValidated } from '../../src/utils/route-geometry.js';

const line = (n, straight) => Array.from({ length: n }, (_, i) => ({
  lat: 45 + i * 0.01,
  lng: 16 + (straight ? i * 0.01 : Math.sin(i) * 0.01), // straight = collinear; else a bend
}));

describe('routeGeometryValidated — straight-line fallback must NOT count as a validated zone', () => {
  it('rejects too-few points (a 2–3 point fallback)', () => {
    expect(routeGeometryValidated([{ lat: 45, lng: 16 }, { lat: 45.1, lng: 16.1 }])).toBe(false);
    expect(routeGeometryValidated(line(3, true))).toBe(false);
  });
  it('rejects a near-perfectly-straight polyline (collinear fallback)', () => {
    expect(routeGeometryValidated(line(12, true))).toBe(false);
  });
  it('accepts a genuinely bending road-snapped polyline', () => {
    expect(routeGeometryValidated(line(12, false))).toBe(true);
  });
  it('rejects degenerate / empty / non-array input', () => {
    expect(routeGeometryValidated([])).toBe(false);
    expect(routeGeometryValidated(null)).toBe(false);
    expect(routeGeometryValidated(Array.from({ length: 6 }, () => ({ lat: 45, lng: 16 })))).toBe(false);
  });
});
