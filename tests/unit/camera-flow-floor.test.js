// Unit tests for the camera occupancy-gated wait floor (2026-05-30).
//
// Trust bug: a visibly bumper-to-bumper lane read as "~4 min" because adjacent
// cars merge into a few connected components and the component-derived queue
// count collapses. The flow estimator now floors the wait by how full the
// monitored lane band is (occupancyPct), gated so empty / lane-striped asphalt
// and single-frame misreads never trigger it.

import { describe, it, expect } from 'vitest';
import { estimateCameraFlowFromSnapshot } from '../../server/index.js';

describe('estimateCameraFlowFromSnapshot occupancy-gated wait floor', () => {
  it('does not inflate an empty / nearly empty lane', () => {
    const out = estimateCameraFlowFromSnapshot({ visibleTotal: 1, occupancyPct: 12, componentDensity: 0.2 });
    expect(out.wait).toBeLessThanOrEqual(6);
  });

  it('does not floor when occupancy is high but almost nothing was detected (misread guard)', () => {
    const lowQueue = estimateCameraFlowFromSnapshot({ visibleTotal: 1, occupancyPct: 70, componentDensity: 0.3 });
    // queueVehicles (1) is below the gate of 3, so the occ-70 floor (~24) must
    // NOT apply; the wait stays the small base-model value.
    expect(lowQueue.wait).toBeLessThan(20);
  });

  it('floors the wait for a visibly full lane that under-counts vehicles', () => {
    // Few merged components (queue 5) but the band is ~70% occupied: the old
    // model returned a single-digit wait; the floor must lift it.
    const packed = estimateCameraFlowFromSnapshot({ visibleTotal: 5, occupancyPct: 70, componentDensity: 1.2 });
    expect(packed.wait).toBeGreaterThanOrEqual(20);
  });

  it('floors a single packed lane even when whole-frame occupancy is low', () => {
    // The real Maljevac case: one lane bumper-to-bumper, the other lane + grass
    // empty -> whole-frame occupancy ~25% (below the gate) but the fullest lane
    // band is ~75%. The lane-band signal must still lift the wait.
    const oneLane = estimateCameraFlowFromSnapshot({
      visibleTotal: 5, occupancyPct: 25, laneFullnessPct: 75, componentDensity: 1.1,
    });
    expect(oneLane.wait).toBeGreaterThanOrEqual(20);
  });

  it('scales the floor with fullness (more occupancy => more wait)', () => {
    const half = estimateCameraFlowFromSnapshot({ visibleTotal: 4, occupancyPct: 50, componentDensity: 1 });
    const full = estimateCameraFlowFromSnapshot({ visibleTotal: 4, occupancyPct: 85, componentDensity: 1 });
    expect(full.wait).toBeGreaterThan(half.wait);
  });

  it('never lowers a wait that is already high from a long counted queue', () => {
    const longQueue = estimateCameraFlowFromSnapshot({ visibleTotal: 26, occupancyPct: 80, componentDensity: 1.6 });
    const occupancyFloor = Math.round(Math.min(42, (80 - 36) * 0.72));
    expect(longQueue.wait).toBeGreaterThanOrEqual(occupancyFloor);
  });
});
