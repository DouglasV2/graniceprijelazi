// V5 PRIORITET 0 — camera estimate sanity / no false camera wait.
//
// The trust bug: a camera with no visible queue could still emit 20–60 min "procjena iz
// kamere" because high occupancy/area (dark frames, shadows, structures) or low throughput
// were treated as queue evidence. Occupancy/area alone is NOT a queue: REAL vehicle
// detections must corroborate it, and the wait is hard-capped by the qualitative band.
import { describe, it, expect } from 'vitest';
import { estimateCameraFlowFromSnapshot } from '../../server/index.js';

describe('camera sanity: clear camera cannot fabricate a wait', () => {
  it('Svilaj clear: 0–2 vehicles, low occupancy → wait ≤ 8 (not 20)', () => {
    const out = estimateCameraFlowFromSnapshot({ visibleVehicles: 1, queueVehicles: 1, occupancyPct: 10, laneFullnessPct: 12, componentDensity: 0.2 });
    expect(out.wait).toBeLessThanOrEqual(8);
    expect(out.queueBand).toBe('nema');
  });

  it('high occupancy but NO real vehicles (shadows/structures) → still ≤ 8 min', () => {
    // The decisive Svilaj/Maljevac fix: occupancy 80% but only 1 real detection → no queue.
    const out = estimateCameraFlowFromSnapshot({ visibleVehicles: 1, queueVehicles: 18, occupancyPct: 80, laneFullnessPct: 85, componentDensity: 0.3 });
    expect(out.wait).toBeLessThanOrEqual(8);
  });

  it('Maljevac low visible traffic: ≤ 6 real vehicles, camera-only → no 60+ estimate', () => {
    const out = estimateCameraFlowFromSnapshot({ visibleVehicles: 6, queueVehicles: 30, occupancyPct: 90, laneFullnessPct: 95, componentDensity: 1.0 });
    expect(out.wait).toBeLessThan(60);
  });

  it('low throughput ALONE does not generate a wait (empty road, slow flow)', () => {
    const out = estimateCameraFlowFromSnapshot({ visibleVehicles: 2, queueVehicles: 2, occupancyPct: 8, laneFullnessPct: 10, componentDensity: 0.1 });
    expect(out.wait).toBeLessThanOrEqual(8);
  });

  it('a genuinely packed lane (many real vehicles + full) still produces a real wait', () => {
    const out = estimateCameraFlowFromSnapshot({ visibleVehicles: 16, queueVehicles: 24, occupancyPct: 80, laneFullnessPct: 88, componentDensity: 1.5 });
    expect(out.wait).toBeGreaterThanOrEqual(20);
    expect(['velika', 'ekstremna']).toContain(out.queueBand);
  });

  it('band escalates only with BOTH real detections and fullness', () => {
    const shadowy = estimateCameraFlowFromSnapshot({ visibleVehicles: 2, queueVehicles: 20, occupancyPct: 75, laneFullnessPct: 80 });
    expect(shadowy.queueBand === 'nema' || shadowy.queueBand === 'velika' ? shadowy.wait : 0).toBeLessThanOrEqual(8);
    // 2 real vehicles can never be "ekstremna"
    expect(shadowy.queueBand).not.toBe('ekstremna');
  });

  it('separates visibleVehicles from queueVehicles', () => {
    const out = estimateCameraFlowFromSnapshot({ visibleVehicles: 8, queueVehicles: 12, occupancyPct: 60, laneFullnessPct: 70 });
    expect(out.visibleVehicles).toBe(8);
    expect(out.queueVehicles).toBeGreaterThanOrEqual(8);
    expect(out.evidenceCap).toBeGreaterThan(0);
  });
});
