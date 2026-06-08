// Scenario M: with PREDICTION_V2 ENABLED, a low prediction must NOT overwrite a committed camera
// congestion floor. This is the exact live NO-GO: decision.appliedFloor=visual-band:srednja but
// finalEstimateMin=3 (prediction had overwritten finalWait after the floor was applied).
process.env.PREDICTION_V2_ENABLED = 'true';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { effectiveBorderSignal, BORDER_CROSSINGS, initializeDatastore } from '../../server/index.js';

beforeAll(async () => { await initializeDatastore(); });
afterAll(() => { delete process.env.PREDICTION_V2_ENABLED; });

const cleanStore = () => ({ users: [], overrides: {}, statusOverrides: {}, reports: [], audit: [], routeSearches: [], historySnapshots: [], sourceSnapshots: [] });
const cameraVisual = (direction, band) => ({
  crossingId: 'maljevac', direction, sourceName: 'Kamera vizualna provjera', sourceType: 'camera-visual',
  rawWaitMin: null, normalizedWaitMin: null, confidence: 60, weight: 0,
  metadata: { queueBand: band, queueBandLabel: `${band} kolona`, occupancyPct: 62, cameraIds: ['mal-hak-hr-entry'] },
  fetchedAt: new Date().toISOString(),
});
const googleClear = (direction) => ({
  crossingId: 'maljevac', direction, sourceName: 'Google promet', sourceType: 'google-traffic-estimate',
  rawWaitMin: 0, normalizedWaitMin: 0, confidence: 70, weight: 1, metadata: { severity: 'clear', delayMin: 0 },
  fetchedAt: new Date().toISOString(),
});

describe('predictionV2 cannot overwrite a committed camera-congestion floor (Scenario M)', () => {
  it('camera srednja + Google clear + V2 enabled → wait stays >= 22 and label is camera', async () => {
    const sig = await effectiveBorderSignal(BORDER_CROSSINGS.maljevac, 'toHr', 'car', cleanStore(), [cameraVisual('toHr', 'srednja'), googleClear('toHr')]);
    expect(sig.wait).toBeGreaterThanOrEqual(22);
    expect(sig.sourceType).toBe('camera-congestion-override');
    expect(sig.conflictKind).toBe('camera-congestion');
    // If V2 produced a real lead, it must be flagged demoted (never used to lower the number).
    if (sig.predictionV2 && sig.predictionV2.lead && sig.predictionV2.lead !== 'baseline') {
      expect(sig.predictionV2.demotedBy).toBe('camera-congestion-floor');
      expect(sig.wait).toBeGreaterThanOrEqual(22);
    }
  });

  it('camera velika + Google clear + V2 enabled → wait stays >= 30', async () => {
    const sig = await effectiveBorderSignal(BORDER_CROSSINGS.maljevac, 'toHr', 'car', cleanStore(), [cameraVisual('toHr', 'velika'), googleClear('toHr')]);
    expect(sig.wait).toBeGreaterThanOrEqual(30);
    expect(sig.sourceType).toBe('camera-congestion-override');
  });
});
