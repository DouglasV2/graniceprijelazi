// Production safety net (camera estimates): "na kamerama nema vozila a stavi krivu procjenu".
// The camera must never invent a high wait or a big "kolona" from pixel occupancy / lane
// fullness when few or no vehicles are actually visible (wet asphalt, greenery, shadows, night
// glare). These tests pin the two functions that decide the camera answer:
//   - classifyQueueBand          → the qualitative band the UI shows
//   - estimateCameraFlowFromSnapshot → the camera's minute estimate (hard-capped by evidence)
import { describe, it, expect } from 'vitest';
import { estimateCameraFlowFromSnapshot } from '../../server/index.js';
import { classifyQueueBand, QUEUE_BANDS } from '../../server/intelligence.js';

const rank = (b) => QUEUE_BANDS.indexOf(b);

describe('classifyQueueBand never over-reports congestion without vehicle evidence', () => {
  const noiseFrames = [
    { name: 'empty road, lane sensor reads 99', occupancyPct: 0, laneFullnessPct: 99, queueVehicles: 0 },
    { name: 'one car, lane 99 (the live Maljevac toHr frame)', occupancyPct: 0, laneFullnessPct: 99, queueVehicles: 1 },
    { name: 'one car, occupancy 90 (shadows)', occupancyPct: 90, laneFullnessPct: 90, queueVehicles: 1 },
    { name: 'two cars, full-looking frame', occupancyPct: 80, laneFullnessPct: 85, queueVehicles: 2 },
  ];
  for (const f of noiseFrames) {
    it(`${f.name} → band ≤ "mala" (never velika/ekstremna)`, () => {
      const { band } = classifyQueueBand({ occupancyPct: f.occupancyPct, laneFullnessPct: f.laneFullnessPct, queueVehicles: f.queueVehicles, confidence: 65 });
      expect(rank(band)).toBeLessThanOrEqual(rank('mala'));
    });
  }

  it('3–4 vehicles cap at "srednja" even with extreme fullness', () => {
    expect(classifyQueueBand({ occupancyPct: 95, laneFullnessPct: 95, queueVehicles: 4, confidence: 70 }).band).toBe('srednja');
  });

  it('a genuine queue (≥5 vehicles + high fullness) is still allowed to be velika/ekstremna', () => {
    expect(['velika', 'ekstremna']).toContain(classifyQueueBand({ occupancyPct: 60, laneFullnessPct: 80, queueVehicles: 9, confidence: 72 }).band);
    expect(classifyQueueBand({ occupancyPct: 90, laneFullnessPct: 92, queueVehicles: 30, confidence: 78 }).band).toBe('ekstremna');
  });
});

describe('estimateCameraFlowFromSnapshot never fabricates a high wait from an empty/near-empty frame', () => {
  it('zero vehicles → 0 min, band "nema", regardless of occupancy noise', () => {
    const out = estimateCameraFlowFromSnapshot({ visibleVehicles: 0, queueVehicles: 0, occupancyPct: 0, laneFullnessPct: 0, componentDensity: 0 });
    expect(out.wait).toBe(0);
    expect(out.queueBand).toBe('nema');
  });

  it('one car with a 99% lane reading → at most a few minutes (evidence ceiling holds)', () => {
    const out = estimateCameraFlowFromSnapshot({ visibleVehicles: 1, queueVehicles: 1, occupancyPct: 0, laneFullnessPct: 99, componentDensity: 0.2 });
    expect(out.wait).toBeLessThanOrEqual(14);
    expect(rank(out.queueBand)).toBeLessThanOrEqual(rank('velika')); // internal band may be velika, but…
  });

  it('two cars in a "full"-looking shadowy frame → wait ≤ 8 and never ekstremna', () => {
    const out = estimateCameraFlowFromSnapshot({ visibleVehicles: 2, queueVehicles: 20, occupancyPct: 75, laneFullnessPct: 80, componentDensity: 0.3 });
    expect(out.wait).toBeLessThanOrEqual(8);
    expect(out.queueBand).not.toBe('ekstremna');
  });

  it('the occupancy wait-floor only fires with ≥4 REAL vehicles (no floor from pixels alone)', () => {
    const noFloor = estimateCameraFlowFromSnapshot({ visibleVehicles: 1, queueVehicles: 1, occupancyPct: 95, laneFullnessPct: 95 });
    expect(noFloor.wait).toBeLessThanOrEqual(6); // capped at the "nema/mala" evidence ceiling, no inflated floor
  });

  it('a real bumper-to-bumper queue does produce a meaningful wait', () => {
    const out = estimateCameraFlowFromSnapshot({ visibleVehicles: 16, queueVehicles: 30, occupancyPct: 88, laneFullnessPct: 92, componentDensity: 1.4 });
    expect(out.wait).toBeGreaterThan(15);
    expect(['velika', 'ekstremna']).toContain(out.queueBand);
  });

  it('the wait never exceeds the band evidence ceiling', () => {
    const caps = { nema: 6, mala: 14, srednja: 35, velika: 75, ekstremna: 240 };
    for (const q of [0, 1, 2, 6, 14, 30]) {
      const out = estimateCameraFlowFromSnapshot({ visibleVehicles: q, queueVehicles: q, occupancyPct: 70, laneFullnessPct: 70 });
      expect(out.wait).toBeLessThanOrEqual(caps[out.queueBand]);
    }
  });
});
