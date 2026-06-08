// Location recommendation scoring — pure (driveTime + wait + reliability penalty).
import { describe, it, expect } from 'vitest';
import { rankCrossingsByLocation, reliabilityPenaltyMin, approxDriveMinFromKm, haversineKm } from '../../src/utils/crossing-recommendation.js';

const user = { lat: 45.20, lng: 15.80 }; // near Maljevac
const crossings = [
  { id: 'maljevac', name: 'Maljevac', lat: 45.196, lng: 15.796, waitMin: 34, confidence: 'srednja' },
  { id: 'izacic', name: 'Izačić', lat: 44.876, lng: 15.764, waitMin: 20, confidence: 'visoka' },
  { id: 'gradiska', name: 'Gradiška', lat: 45.145, lng: 17.252, waitMin: 10, confidence: 'visoka' },
];

describe('reliability penalty + drive approximation', () => {
  it('penalises low/medium confidence', () => {
    expect(reliabilityPenaltyMin('visoka')).toBe(0);
    expect(reliabilityPenaltyMin('srednja')).toBe(5);
    expect(reliabilityPenaltyMin('niska')).toBe(12);
    expect(reliabilityPenaltyMin(null)).toBe(12);
  });
  it('approxDriveMinFromKm scales with distance', () => {
    expect(approxDriveMinFromKm(70, 70)).toBe(60);
    expect(approxDriveMinFromKm(null)).toBeNull();
  });
});

describe('rankCrossingsByLocation', () => {
  it('ranks by driveTime + wait (+penalty) — nearest-with-low-total wins', () => {
    const { best } = rankCrossingsByLocation(user, crossings);
    expect(best.id).toBe('maljevac'); // ~0.5km away + 34 wait + 5 penalty << far crossings
    expect(best.totalMin).toBeGreaterThan(34);
    expect(best.badges).toContain('Najbrže ukupno');
  });

  it('a much-farther crossing with lower wait does NOT always win', () => {
    // Gradiška has wait 10 but is ~115km away → big driveMin → not best.
    const { best } = rankCrossingsByLocation(user, crossings);
    expect(best.id).not.toBe('gradiska');
  });

  it('prefers a Google driveMin over the haversine approximation', () => {
    const withGoogle = rankCrossingsByLocation(user, [
      { id: 'a', name: 'A', lat: 45.0, lng: 15.0, waitMin: 10, confidence: 'visoka', driveMin: 90 },
    ]);
    expect(withGoogle.best.driveMin).toBe(90);
    expect(withGoogle.best.driveApprox).toBe(false);
  });

  it('flags driveApprox when no Google drive time is supplied', () => {
    expect(rankCrossingsByLocation(user, crossings).best.driveApprox).toBe(true);
  });

  it('a low-confidence crossing is penalised vs an equal high-confidence one', () => {
    const here = { lat: 45.0, lng: 16.0 };
    const r = rankCrossingsByLocation(here, [
      { id: 'low', name: 'Low', lat: 45.01, lng: 16.0, waitMin: 30, confidence: 'niska' },
      { id: 'high', name: 'High', lat: 45.01, lng: 16.0, waitMin: 30, confidence: 'visoka' },
    ]);
    expect(r.best.id).toBe('high'); // same drive + wait, but no penalty
  });

  it('returns alternatives (2-3) and flags when options are similar', () => {
    const here = { lat: 45.0, lng: 16.0 };
    const r = rankCrossingsByLocation(here, [
      { id: 'a', name: 'A', lat: 45.01, lng: 16.0, waitMin: 20, confidence: 'visoka' },
      { id: 'b', name: 'B', lat: 45.012, lng: 16.0, waitMin: 22, confidence: 'visoka' },
      { id: 'c', name: 'C', lat: 45.9, lng: 16.0, waitMin: 10, confidence: 'visoka' },
    ]);
    expect(r.alternatives.length).toBeGreaterThanOrEqual(1);
    expect(r.similar).toBe(true); // A and B within 10 min total
  });

  it('no usable crossings → null best, no crash', () => {
    expect(rankCrossingsByLocation(user, [{ id: 'x', name: 'X', waitMin: null }]).best).toBeNull();
    expect(rankCrossingsByLocation(null, []).best).toBeNull();
  });
});

describe('haversineKm', () => {
  it('~111 km per degree latitude', () => {
    expect(haversineKm({ lat: 45, lng: 16 }, { lat: 46, lng: 16 })).toBeGreaterThan(105);
    expect(haversineKm({ lat: 45, lng: 16 }, { lat: 46, lng: 16 })).toBeLessThan(115);
  });
});
