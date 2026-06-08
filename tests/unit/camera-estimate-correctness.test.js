// Production safety net (camera estimates): "na kamerama nema vozila a stavi krivu procjenu".
// The camera must never invent a high wait or a big "kolona" from pixel occupancy / lane
// fullness when few or no vehicles are actually visible (wet asphalt, greenery, shadows, night
// glare). These tests pin the two functions that decide the camera answer:
//   - classifyQueueBand          → the qualitative band the UI shows
//   - estimateCameraFlowFromSnapshot → the camera's minute estimate (hard-capped by evidence)
import { describe, it, expect } from 'vitest';
import { estimateCameraFlowFromSnapshot } from '../../server/index.js';
import { classifyQueueBand, QUEUE_BANDS, resolveCameraClearOverride, resolveCameraCongestionOverride } from '../../server/intelligence.js';

const rank = (b) => QUEUE_BANDS.indexOf(b);

describe('classifyQueueBand never over-reports congestion without vehicle evidence', () => {
  // GENUINE pixel noise = LOW real occupancy but a high laneFullness sensor reading (wet asphalt /
  // shadows on an open road). These must stay ≤ "mala" — no real objects are present.
  const noiseFrames = [
    { name: 'empty road, lane sensor reads 99', occupancyPct: 0, laneFullnessPct: 99, queueVehicles: 0 },
    { name: 'one car, lane 99 (the live Maljevac toHr frame)', occupancyPct: 0, laneFullnessPct: 99, queueVehicles: 1 },
    { name: 'low occupancy (8%) but lane sensor 95 (shadows)', occupancyPct: 8, laneFullnessPct: 95, queueVehicles: 1 },
  ];
  for (const f of noiseFrames) {
    it(`${f.name} → band ≤ "mala" (never velika/ekstremna)`, () => {
      const { band } = classifyQueueBand({ occupancyPct: f.occupancyPct, laneFullnessPct: f.laneFullnessPct, queueVehicles: f.queueVehicles, confidence: 65 });
      expect(rank(band)).toBeLessThanOrEqual(rank('mala'));
    });
  }

  // BUT high REAL occupancy + ~no detected vehicles ≠ clear. That is the live Maljevac NO-GO: a lane
  // visibly full of cars where the detector returned ~nothing was wrongly called "mala" → "do 5 min".
  // It must read "srednja" (possible queue) — never a confident "mala", never an unverifiable extreme.
  const disagreementFrames = [
    { name: 'one car but occupancy 90', occupancyPct: 90, laneFullnessPct: 90, queueVehicles: 1 },
    { name: 'two cars, full-looking frame, occupancy 80', occupancyPct: 80, laneFullnessPct: 85, queueVehicles: 2 },
  ];
  for (const f of disagreementFrames) {
    it(`${f.name} → "srednja" (possible queue), not a confident "mala" nor extreme`, () => {
      const { band } = classifyQueueBand({ occupancyPct: f.occupancyPct, laneFullnessPct: f.laneFullnessPct, queueVehicles: f.queueVehicles, confidence: 65 });
      expect(band).toBe('srednja');
    });
  }

  it('3–4 vehicles cap at "srednja" even with extreme fullness', () => {
    expect(classifyQueueBand({ occupancyPct: 95, laneFullnessPct: 95, queueVehicles: 4, confidence: 70 }).band).toBe('srednja');
  });

  it('a genuine queue (≥5 vehicles + high fullness) is still allowed to be velika/ekstremna', () => {
    expect(['velika', 'ekstremna']).toContain(classifyQueueBand({ occupancyPct: 60, laneFullnessPct: 80, queueVehicles: 9, confidence: 72 }).band);
    expect(classifyQueueBand({ occupancyPct: 90, laneFullnessPct: 92, queueVehicles: 30, confidence: 78 }).band).toBe('ekstremna');
  });

  // The live over-count: 3–4 cars VISIBLE but queueVehicles ×3-inflated to 9–12 + noisy lane 100 →
  // band must follow what is SEEN (visibleVehicles), not the inflated queue. Orašje/Brod/Šamac bug.
  it('visibleVehicles caps the band even when the ×3-inflated queueVehicles is high', () => {
    expect(classifyQueueBand({ laneFullnessPct: 100, queueVehicles: 9, visibleVehicles: 3, confidence: 62 }).band).toBe('srednja');
    expect(classifyQueueBand({ laneFullnessPct: 67, queueVehicles: 12, visibleVehicles: 4, confidence: 65 }).band).toBe('srednja');
    expect(classifyQueueBand({ laneFullnessPct: 90, queueVehicles: 6, visibleVehicles: 2, confidence: 60 }).band).toBe('mala');
  });

  it('a real queue with many VISIBLE vehicles still reads velika/ekstremna', () => {
    expect(['velika', 'ekstremna']).toContain(classifyQueueBand({ laneFullnessPct: 85, queueVehicles: 30, visibleVehicles: 16, confidence: 70 }).band);
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

describe('resolveCameraClearOverride — empty camera lowers a weak number, never a hard authority', () => {
  const base = { visualBand: 'nema', cameraClear: true, cameraStale: false, cameraWait: 2, currentWait: 12 };

  it('empty camera + Google/soft number → overrides DOWN to the camera wait', () => {
    const r = resolveCameraClearOverride({ ...base, hardAuthorityPresent: false });
    expect(r.override).toBe(true);
    expect(r.wait).toBe(2);
  });

  it('"mala" band (a car or two) also counts as clear enough to refine down', () => {
    const r = resolveCameraClearOverride({ ...base, visualBand: 'mala', cameraWait: 4 });
    expect(r.override).toBe(true);
    expect(r.wait).toBe(4);
  });

  it('a HARD official number / measured session BLOCKS the override (official|measured > camera)', () => {
    const r = resolveCameraClearOverride({ ...base, hardAuthorityPresent: true });
    expect(r.override).toBe(false);
    expect(r.wait).toBe(12);
  });

  it('does NOT fire when the camera shows a queue (band velika/ekstremna)', () => {
    expect(resolveCameraClearOverride({ ...base, visualBand: 'velika' }).override).toBe(false);
    expect(resolveCameraClearOverride({ ...base, visualBand: 'ekstremna' }).override).toBe(false);
  });

  it('does NOT fire on a stale frame or an unknown band', () => {
    expect(resolveCameraClearOverride({ ...base, cameraStale: true }).override).toBe(false);
    expect(resolveCameraClearOverride({ ...base, visualBand: null }).override).toBe(false);
  });

  it('never RAISES the wait — only lowers it', () => {
    const r = resolveCameraClearOverride({ ...base, cameraWait: 20, currentWait: 8 });
    expect(r.override).toBe(false);
    expect(r.wait).toBe(8);
  });

  it('needs both numbers present', () => {
    expect(resolveCameraClearOverride({ ...base, cameraWait: null }).override).toBe(false);
    expect(resolveCameraClearOverride({ ...base, currentWait: null }).override).toBe(false);
  });
});

describe('resolveCameraCongestionOverride — camera queue raises a low number (commit, never "provjeri")', () => {
  const base = { visualBand: 'ekstremna', cameraWait: null, currentWait: 8, hardAuthorityPresent: false };

  it('an EXTREME visible queue commits to a realistic wait (≥50), not a token 15-30 min', () => {
    const r = resolveCameraCongestionOverride({ ...base });
    expect(r.override).toBe(true);
    expect(r.wait).toBeGreaterThanOrEqual(50);
  });

  it('velika band raises to a lower floor (≥30) than ekstremna', () => {
    const r = resolveCameraCongestionOverride({ ...base, visualBand: 'velika' });
    expect(r.override).toBe(true);
    expect(r.wait).toBeGreaterThanOrEqual(30);
    expect(r.wait).toBeLessThan(50); // below the ekstremna floor
  });

  it('camera + Google approach-jam agree → estimate is reinforced higher', () => {
    const withGoogle = resolveCameraCongestionOverride({ ...base, googleHeavyNearBorder: true });
    const withoutGoogle = resolveCameraCongestionOverride({ ...base });
    expect(withGoogle.wait).toBeGreaterThan(withoutGoogle.wait);
    expect(withGoogle.wait).toBeGreaterThanOrEqual(60);
  });

  it('uses the camera own wait when it is higher than the floor', () => {
    const r = resolveCameraCongestionOverride({ ...base, cameraWait: 75 });
    expect(r.wait).toBe(75);
  });

  it('a HARD official / measured value BLOCKS the raise (official|measured > camera)', () => {
    const r = resolveCameraCongestionOverride({ ...base, hardAuthorityPresent: true });
    expect(r.override).toBe(false);
    expect(r.wait).toBe(8);
  });

  it('a MEDIUM (srednja) visible queue fires with a small floor (prevents an optimistic "do 20")', () => {
    const r = resolveCameraCongestionOverride({ ...base, visualBand: 'srednja' });
    expect(r.override).toBe(true);
    expect(r.wait).toBeGreaterThanOrEqual(20);
    expect(r.wait).toBeLessThan(30); // below the velika floor
  });

  it('does NOT fire for a clear/small band (nema/mala)', () => {
    for (const b of ['nema', 'mala']) {
      expect(resolveCameraCongestionOverride({ ...base, visualBand: b }).override).toBe(false);
    }
  });

  it('never LOWERS — if the current number already exceeds the band floor, no change', () => {
    const r = resolveCameraCongestionOverride({ ...base, currentWait: 70 });
    expect(r.override).toBe(false);
    expect(r.wait).toBe(70);
  });
});
