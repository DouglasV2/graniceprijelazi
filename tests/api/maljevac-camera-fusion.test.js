// The live NO-GO: /api/camera-analytics had a fresh camera signal but /api/admin/traffic-vision
// showed visualBand:null + finalEstimateMin:0 (Google-only). Root cause: the camera VISUAL band was
// only persisted as a source snapshot when a snapshot-counter/cv frame existed, so a heuristic
// occupancy band never reached effectiveBorderSignal. These tests assert the camera-visual signal
// now reaches the fusion and prevents a false-low estimate, plus the canonical direction mapping.
import { describe, it, expect, beforeAll } from 'vitest';
import {
  effectiveBorderSignal, BORDER_CROSSINGS, CAMERA_FEEDS, initializeDatastore,
  inferCameraDirections, cameraRelevantForDirection,
} from '../../server/index.js';

beforeAll(async () => { await initializeDatastore(); });

const crossing = () => BORDER_CROSSINGS.maljevac;
// A clean store isolates the fusion from data other test files persist to the shared on-disk store
// (e.g. a leaked measured report would block the camera floor). We only exercise the camera path here.
const cleanStore = () => ({ users: [], overrides: {}, statusOverrides: {}, reports: [], audit: [], routeSearches: [], historySnapshots: [], sourceSnapshots: [] });
const cameraVisual = (direction, band, occupancyPct = 62) => ({
  crossingId: 'maljevac', direction, sourceName: 'Kamera vizualna provjera', sourceType: 'camera-visual',
  rawWaitMin: null, normalizedWaitMin: null, confidence: 60, weight: 0,
  metadata: { queueBand: band, queueBandLabel: `${band} kolona`, occupancyPct, cameraIds: ['mal-hak-hr-entry'] },
  fetchedAt: new Date().toISOString(),
});
const googleClear = (direction) => ({
  crossingId: 'maljevac', direction, sourceName: 'Google promet', sourceType: 'google-traffic-estimate',
  rawWaitMin: 0, normalizedWaitMin: 0, confidence: 70, weight: 1, metadata: { severity: 'clear', delayMin: 0 },
  fetchedAt: new Date().toISOString(),
});

describe('Maljevac camera-visual signal reaches Traffic Vision fusion', () => {
  it('a srednja camera-visual band + Google clear → visualBand set + estimate NOT false-low', async () => {
    const sig = await effectiveBorderSignal(crossing(), 'toHr', 'car', cleanStore(), [cameraVisual('toHr', 'srednja'), googleClear('toHr')]);
    expect(sig.visualBand).toBe('srednja');
    expect(sig.wait).toBeGreaterThanOrEqual(20); // floored by the camera signal — not 0/2/5 from Google clear
  });

  it('a velika camera-visual band commits even higher', async () => {
    const sig = await effectiveBorderSignal(crossing(), 'toHr', 'car', cleanStore(), [cameraVisual('toHr', 'velika'), googleClear('toHr')]);
    expect(sig.visualBand).toBe('velika');
    expect(sig.wait).toBeGreaterThanOrEqual(30);
  });

  it('WITHOUT a camera-visual snapshot the band is null (Google-only) — the bug state we fixed the plumbing for', async () => {
    const sig = await effectiveBorderSignal(crossing(), 'toHr', 'car', cleanStore(), [googleClear('toHr')]);
    expect(sig.visualBand == null).toBe(true);
  });

  it('an untrusted ROI does not claim an exact count, but the visual band still prevents false-low', async () => {
    const sig = await effectiveBorderSignal(crossing(), 'toHr', 'car', cleanStore(), [cameraVisual('toHr', 'srednja'), googleClear('toHr')]);
    // No trusted vehicle count is asserted from the visual band; only the band + floor.
    expect(sig.wait).toBeGreaterThanOrEqual(20);
    expect(['srednja', 'velika', 'ekstremna']).toContain(sig.visualBand);
  });
});

describe('Maljevac camera direction mapping is canonical', () => {
  it('toHr → mal-hak-hr-entry (Ulaz u HR iz BiH), toBih → mal-hak-hr-exit (Izlaz iz HR u BiH)', () => {
    const feeds = CAMERA_FEEDS.maljevac || [];
    const entry = feeds.find((c) => c.id === 'mal-hak-hr-entry');
    const exit = feeds.find((c) => c.id === 'mal-hak-hr-exit');
    expect(inferCameraDirections(entry)).toEqual(['toHr']);
    expect(inferCameraDirections(exit)).toEqual(['toBih']);
    expect(cameraRelevantForDirection(entry, 'toHr', feeds)).toBe(true);
    expect(cameraRelevantForDirection(entry, 'toBih', feeds)).toBe(false);
    expect(cameraRelevantForDirection(exit, 'toBih', feeds)).toBe(true);
    expect(cameraRelevantForDirection(exit, 'toHr', feeds)).toBe(false);
  });
});
