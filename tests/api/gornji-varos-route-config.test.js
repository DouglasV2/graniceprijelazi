// T1 regression — Gornji Varoš route anchors + HR-side extension.
// Real-world geometry (OpenStreetMap): HR border control at ≈45.1631,17.2049 (D5), the Sava
// bridge/state border at ≈45.1493,17.2045, BiH control at ≈45.1357,17.2030. The HR→BiH display
// corridor must START on the HR approach (the BEFORE side gets the longer slice + request
// extension), cross the bridge and end past the BiH control.
import { describe, it, expect } from 'vitest';
import { BORDER_CROSSINGS, routeOriginAnchor, routeDestinationAnchor } from '../../server/index.js';

const gv = BORDER_CROSSINGS['gornji-varos'];

describe('Gornji Varoš — calibrated anchors match the real corridor', () => {
  it('borderPoint sits on the Sava bridge (state border), not inside BiH', () => {
    for (const direction of ['toBih', 'toHr']) {
      const border = gv.anchors[direction].borderPoint;
      expect(border.lat).toBeGreaterThan(45.147);
      expect(border.lat).toBeLessThan(45.152);
      expect(border.lng).toBeGreaterThan(17.198);
      expect(border.lng).toBeLessThan(17.210);
    }
  });

  it('toBih approachStart is on the HR side (north of the border, near the HR control)', () => {
    const a = gv.anchors.toBih;
    expect(a.approachStart.lat).toBeGreaterThan(a.borderPoint.lat);
    // ~1.5 km of HR-side road between border and HR control plaza.
    expect(a.approachStart.lat).toBeGreaterThan(45.158);
    // Exit is on the BiH side (south of the border).
    expect(a.exitPoint.lat).toBeLessThan(a.borderPoint.lat);
    expect(a.exitPoint.lat).toBeLessThan(45.140);
  });

  it('toHr mirrors the same corridor (BiH approach, HR exit)', () => {
    const a = gv.anchors.toHr;
    expect(a.approachStart.lat).toBeLessThan(a.borderPoint.lat);
    expect(a.exitPoint.lat).toBeGreaterThan(a.borderPoint.lat);
  });
});

describe('Gornji Varoš — HR-side display extension (T1 acceptance)', () => {
  it('toBih displayCorridor extends the HR (before) side more than the BiH side', () => {
    const dc = gv.anchors.toBih.routeGuard.displayCorridor;
    expect(dc.sliceBeforeMeters).toBeGreaterThanOrEqual(2000);
    expect(dc.sliceBeforeMeters).toBeGreaterThan(dc.sliceAfterMeters);
    expect(dc.requestExtendBeforeMeters).toBeGreaterThan(dc.requestExtendAfterMeters);
  });

  it('toHr displayCorridor extends the HR (after/exit) side more than the BiH side', () => {
    const dc = gv.anchors.toHr.routeGuard.displayCorridor;
    expect(dc.sliceAfterMeters).toBeGreaterThan(dc.sliceBeforeMeters);
    expect(dc.requestExtendAfterMeters).toBeGreaterThan(dc.requestExtendBeforeMeters);
  });

  it('displayMaxMeters is large enough for the asymmetric window (no silent re-slicing)', () => {
    for (const direction of ['toBih', 'toHr']) {
      const guard = gv.anchors[direction].routeGuard;
      const dc = guard.displayCorridor;
      expect(Number(guard.displayMaxMeters)).toBeGreaterThanOrEqual(Number(dc.sliceBeforeMeters) + Number(dc.sliceAfterMeters));
    }
  });

  it('routeOriginAnchor extends the Google request origin past the HR approach (toBih)', () => {
    const anchor = gv.anchors.toBih;
    const origin = routeOriginAnchor(anchor);
    // The extended origin must be FURTHER north (HR side) than the precise approach anchor.
    expect(origin.lat).toBeGreaterThan(anchor.approachStart.lat);
    const destination = routeDestinationAnchor(anchor);
    // And the destination further south (BiH side) than the precise exit anchor.
    expect(destination.lat).toBeLessThan(anchor.exitPoint.lat);
  });

  it('per-side request extension is honoured independently (before ≠ after)', () => {
    const anchor = gv.anchors.toBih;
    const origin = routeOriginAnchor(anchor);
    const destination = routeDestinationAnchor(anchor);
    const northExtension = origin.lat - anchor.approachStart.lat;
    const southExtension = anchor.exitPoint.lat - destination.lat;
    // HR (before) side is extended more than the BiH (after) side.
    expect(northExtension).toBeGreaterThan(southExtension);
  });
});
