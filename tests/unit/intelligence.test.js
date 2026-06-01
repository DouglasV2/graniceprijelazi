import { describe, it, expect } from 'vitest';
import {
  CONFIDENCE_LEVELS,
  computeConfidenceProfile,
  computeSmartRange,
  buildSourceExplanation,
  classifyQueueBand,
  QUEUE_BANDS,
  computeAverageHash,
  hammingDistanceHex,
  detectStaleFrames,
  buildCameraAnalysis,
  cameraContributionMode,
  computeReportTrust,
  dedupeReports,
  detectReportAnomalies,
  computeAccuracyStats,
  evaluateWaitAlerts,
  rankBestCrossings,
  computeMeasuredWait,
  haversineMeters,
  locateInGeofence,
  computeBiasCorrection,
} from '../../server/intelligence.js';

// A synthetic crossing geofence (~Gradiška), approach ~1.1 km north of the booth.
const GEOFENCE = {
  approach: { lat: 45.1500, lng: 17.2510 },
  border: { lat: 45.1453, lng: 17.2521 },
  exit: { lat: 45.1380, lng: 17.2575 },
  approachRadiusM: 1300,
  borderRadiusM: 350,
  exitRadiusM: 500,
};

describe('confidence engine', () => {
  it('says NEDOVOLJNO when there is no signal', () => {
    const p = computeConfidenceProfile({ signals: [] });
    expect(p.level).toBe(CONFIDENCE_LEVELS.NONE);
    expect(p.precision).toBe('unknown');
  });

  it('spec example A: official 90 + camera 85 + users 95 + google 10 → VISOKA (3 sources agree)', () => {
    const p = computeConfidenceProfile({
      agreementSpread: 5,
      signals: [
        { kind: 'official', wait: 90, ageMinutes: 8, confidence: 85, soft: false },
        { kind: 'camera', wait: 85, ageMinutes: 5, confidence: 80 },
        { kind: 'report', wait: 95, ageMinutes: 10, confidence: 70, trust: 0.6 },
        { kind: 'google', wait: 10, ageMinutes: 3, confidence: 60 },
      ],
    });
    expect(p.level).toBe(CONFIDENCE_LEVELS.HIGH);
    expect(p.precision).toBe('exact');
    expect(p.independentSources).toBe(4);
  });

  it('spec example B: camera 45 + google 8, no users/official → NISKA', () => {
    const p = computeConfidenceProfile({
      signals: [
        { kind: 'camera', wait: 45, ageMinutes: 20, confidence: 55 },
        { kind: 'google', wait: 8, ageMinutes: 5, confidence: 60 },
      ],
    });
    expect(p.level).toBe(CONFIDENCE_LEVELS.LOW);
    expect(p.precision).toBe('range');
  });

  it('a single stale camera is heavily penalised', () => {
    const p = computeConfidenceProfile({ signals: [{ kind: 'camera', wait: 40, ageMinutes: 90, confidence: 50, stale: true }] });
    expect(p.level).toBe(CONFIDENCE_LEVELS.LOW);
  });

  it('measured wait alone lifts confidence', () => {
    const measured = computeConfidenceProfile({ signals: [{ kind: 'measured', wait: 50, ageMinutes: 5, confidence: 90 }] });
    const google = computeConfidenceProfile({ signals: [{ kind: 'google', wait: 50, ageMinutes: 5, confidence: 60 }] });
    expect(measured.score).toBeGreaterThan(google.score);
  });
});

describe('smart range', () => {
  it('returns unknown for non-numeric wait', () => {
    expect(computeSmartRange(null, { level: CONFIDENCE_LEVELS.HIGH }).precision).toBe('unknown');
  });
  it('low confidence widens the band more than high confidence', () => {
    const hi = computeSmartRange(50, { level: CONFIDENCE_LEVELS.HIGH });
    const lo = computeSmartRange(50, { level: CONFIDENCE_LEVELS.LOW });
    const hiWidth = hi.rangeMax - hi.rangeMin;
    const loWidth = lo.rangeMax - lo.rangeMin;
    expect(loWidth).toBeGreaterThan(hiWidth);
  });
  it('disagreement spread widens the range', () => {
    const calm = computeSmartRange(60, { level: CONFIDENCE_LEVELS.MEDIUM }, { agreementSpread: 4 });
    const noisy = computeSmartRange(60, { level: CONFIDENCE_LEVELS.MEDIUM }, { agreementSpread: 50 });
    expect(noisy.rangeMax - noisy.rangeMin).toBeGreaterThan(calm.rangeMax - calm.rangeMin);
  });
});

describe('explanation engine', () => {
  it('enumerates official + camera + reports (spec example)', () => {
    const s = buildSourceExplanation({ official: true, cameraQueue: true, reportCount: 4 });
    expect(s).toContain('službenom izvoru');
    expect(s).toContain('kameri');
    expect(s).toContain('4 korisničke dojave');
  });
  it('camera-mostly with no official', () => {
    const s = buildSourceExplanation({ cameraQueue: true, googleClear: false });
    expect(s).toContain('kameri');
  });
  it('google clear while queue conflict is surfaced', () => {
    const s = buildSourceExplanation({ official: true, googleClear: true, googleClearWhileQueue: true });
    expect(s.toLowerCase()).toContain('google promet izgleda protočno');
    expect(s).toContain('graničnoj kontroli');
  });
  it('no data → honest message', () => {
    expect(buildSourceExplanation({})).toContain('nema dovoljno podataka');
  });
});

describe('queue bands', () => {
  it('empty road → nema', () => {
    expect(classifyQueueBand({ occupancyPct: 5, queueVehicles: 0 }).band).toBe('nema');
  });
  it('packed lane → velika/ekstremna even with low vehicle count', () => {
    const b = classifyQueueBand({ occupancyPct: 20, laneFullnessPct: 85, queueVehicles: 6, confidence: 70 });
    expect(['velika', 'ekstremna']).toContain(b.band);
  });
  it('stale/low-confidence frame cannot claim more than srednja', () => {
    const b = classifyQueueBand({ occupancyPct: 90, laneFullnessPct: 90, queueVehicles: 30, confidence: 80, stale: true });
    expect(QUEUE_BANDS.indexOf(b.band)).toBeLessThanOrEqual(2);
  });
});

describe('image hash + stale detection', () => {
  const gradient = (x) => Math.min(255, x); // brighter on the right
  it('identical frames have hamming distance 0', () => {
    const h1 = computeAverageHash(gradient, 64, 64);
    const h2 = computeAverageHash(gradient, 64, 64);
    expect(h1).toBe(h2);
    expect(hammingDistanceHex(h1, h2)).toBe(0);
  });
  it('flips when the image changes', () => {
    const flat = computeAverageHash(() => 100, 64, 64);
    const half = computeAverageHash((x) => (x < 32 ? 0 : 255), 64, 64);
    expect(hammingDistanceHex(flat, half)).toBeGreaterThan(0);
  });
  it('3 repeated frames → stale', () => {
    const h = computeAverageHash(gradient, 64, 64);
    expect(detectStaleFrames([h, h, h]).stale).toBe(true);
  });
  it('changing frames are not stale', () => {
    const a = computeAverageHash((x) => (x < 32 ? 0 : 255), 64, 64);
    const b = computeAverageHash((x) => (x < 48 ? 0 : 255), 64, 64);
    const c = computeAverageHash(() => 120, 64, 64);
    expect(detectStaleFrames([a, b, c]).stale).toBe(false);
  });
});

describe('camera analysis builder', () => {
  it('produces the full structured shape', () => {
    const a = buildCameraAnalysis({ visibleTotal: 9, queueVehicles: 9, occupancyPct: 55, laneFullnessPct: 70, flowVehicles15: 12, queueTrend: 'rising', confidence: 72, snapshotAgeSec: 30, wait: 25, method: 'snapshot-flow-v2' });
    expect(a).toMatchObject({ visibleVehicles: 9, queueVehicles: 9, occupancyPct: 55, flowVehicles15: 12, trend: 'rising', confidence: 72, stale: false, snapshotAgeSec: 30 });
    expect(a.queueBand).toBeDefined();
    expect(a.contributesWait).toBe(25);
  });
  it('a stale camera reports a band but contributes no wait', () => {
    const a = buildCameraAnalysis({ queueVehicles: 20, occupancyPct: 80, confidence: 70, stale: true, wait: 60 });
    expect(a.contributesWait).toBeNull();
    expect(a.queueBand).toBeDefined();
  });
  it('visualOnly cameras never contribute wait', () => {
    const a = buildCameraAnalysis({ queueVehicles: 20, occupancyPct: 80, confidence: 90, wait: 60, visualOnly: true });
    expect(a.contributesWait).toBeNull();
    expect(a.visualOnly).toBe(true);
  });
});

describe('camera direction safety', () => {
  it('camera valid for one direction does not feed the other', () => {
    const cam = { validForDirections: ['toBih'] };
    expect(cameraContributionMode(cam, 'toBih')).toBe('hard');
    expect(cameraContributionMode(cam, 'toHr')).toBe('none');
  });
  it('a camera with no declared direction is visual-only', () => {
    expect(cameraContributionMode({}, 'toBih')).toBe('visual');
  });
  it('explicit visualOnly overrides', () => {
    expect(cameraContributionMode({ validForDirections: ['toBih'], visualOnly: true }, 'toBih')).toBe('visual');
  });
});

describe('trust engine', () => {
  it('measured + gps verified outranks anonymous manual', () => {
    const measured = computeReportTrust({ measured: true, gpsVerified: true, wait: 50, ageMinutes: 5, userId: 'u1' });
    const manual = computeReportTrust({ wait: 50, ageMinutes: 5, anonymous: true });
    expect(measured.trust).toBeGreaterThan(manual.trust);
  });
  it('age decays trust', () => {
    const fresh = computeReportTrust({ wait: 50, ageMinutes: 5 });
    const old = computeReportTrust({ wait: 50, ageMinutes: 150 });
    expect(old.trust).toBeLessThan(fresh.trust);
  });
  it('disagreement with reference lowers trust', () => {
    const agree = computeReportTrust({ wait: 50, ageMinutes: 5 }, { referenceWait: 52 });
    const disagree = computeReportTrust({ wait: 50, ageMinutes: 5 }, { referenceWait: 5 });
    expect(disagree.trust).toBeLessThan(agree.trust);
  });
});

describe('anti-fake', () => {
  it('dedupes spammed near-identical reports from one user', () => {
    const base = new Date();
    const reports = [
      { userId: 'u1', crossingId: 'x', direction: 'toBih', wait: 50, createdAt: new Date(base).toISOString() },
      { userId: 'u1', crossingId: 'x', direction: 'toBih', wait: 52, createdAt: new Date(base.getTime() - 5 * 60000).toISOString() },
      { userId: 'u2', crossingId: 'x', direction: 'toBih', wait: 51, createdAt: new Date(base).toISOString() },
    ];
    const kept = dedupeReports(reports);
    expect(kept.length).toBe(2); // u1 collapsed to one, u2 kept
  });
  it('flags an outlier report far from consensus', () => {
    const reports = [{ wait: 50 }, { wait: 55 }, { wait: 48 }, { wait: 200 }];
    const { anomalies } = detectReportAnomalies(reports, 51);
    expect(anomalies.some((r) => r.wait === 200)).toBe(true);
  });
});

describe('accuracy stats', () => {
  it('computes MAE, median, p90 and bias', () => {
    const records = [
      { crossingId: 'a', direction: 'toBih', predictedWait: 30, actualWait: 35 },
      { crossingId: 'a', direction: 'toBih', predictedWait: 60, actualWait: 50 },
      { crossingId: 'a', direction: 'toBih', predictedWait: 20, actualWait: 22 },
    ];
    const stats = computeAccuracyStats(records);
    expect(stats.overall.n).toBe(3);
    expect(stats.overall.mae).toBeCloseTo((5 + 10 + 2) / 3, 1);
    expect(stats.perCrossing['a:toBih']).toBeTruthy();
  });
  it('ignores records without an actual wait', () => {
    const stats = computeAccuracyStats([{ crossingId: 'a', direction: 'toBih', predictedWait: 30, actualWait: null }]);
    expect(stats.sampleSize).toBe(0);
  });
});

describe('alerts', () => {
  it('fires drop-below when crossing the threshold downward', () => {
    const events = evaluateWaitAlerts(45, 20, { crossingId: 'x', dropBelow: 30 });
    expect(events.some((e) => e.type === 'drop-below')).toBe(true);
  });
  it('fires rise-above and sudden-change on a big jump', () => {
    const events = evaluateWaitAlerts(20, 80, { crossingId: 'x', riseAbove: 60, suddenDelta: 25 });
    expect(events.some((e) => e.type === 'rise-above')).toBe(true);
    expect(events.some((e) => e.type === 'sudden-change')).toBe(true);
  });
  it('no alert without a previous value', () => {
    expect(evaluateWaitAlerts(null, 80, { crossingId: 'x' })).toHaveLength(0);
  });
});

describe('best crossing engine', () => {
  it('recommends the lowest total and quantifies the saving (spec example)', () => {
    const result = rankBestCrossings([
      { id: 'gornji-varos', name: 'Gornji Varoš', wait: 90, extraDriveMinutes: 0 },
      { id: 'jasenovac', name: 'Jasenovac', wait: 25, extraDriveMinutes: 0 },
      { id: 'stara-gradiska', name: 'Stara Gradiška', wait: 40, extraDriveMinutes: 0 },
    ], { referenceId: 'gornji-varos' });
    expect(result.best.id).toBe('jasenovac');
    expect(result.recommendation.savingMinutes).toBe(65);
    expect(result.recommendation.message).toContain('Ušteda 65 min');
  });
  it('accounts for extra drive time', () => {
    const result = rankBestCrossings([
      { id: 'a', name: 'A', wait: 30, extraDriveMinutes: 0 },
      { id: 'b', name: 'B', wait: 10, extraDriveMinutes: 40 },
    ]);
    expect(result.best.id).toBe('a');
  });
  it('skips crossings without a live wait', () => {
    const result = rankBestCrossings([{ id: 'a', name: 'A', wait: null, displayReady: false }]);
    expect(result.best).toBeNull();
  });
});

describe('measured wait', () => {
  it('computes wait from start/finish timestamps', () => {
    const start = new Date('2026-06-01T10:00:00Z').toISOString();
    const finish = new Date('2026-06-01T10:42:00Z').toISOString();
    const m = computeMeasuredWait({ startedAt: start, finishedAt: finish });
    expect(m.wait).toBe(42);
  });
  it('rejects negative or absurd durations', () => {
    expect(computeMeasuredWait({ startedAt: new Date().toISOString(), finishedAt: new Date(Date.now() - 1000).toISOString() })).toBeNull();
  });
  it('weakly verifies gps (no geofence) when there is sane movement', () => {
    const m = computeMeasuredWait({ startedAt: new Date(Date.now() - 600000).toISOString(), finishedAt: new Date().toISOString(), startGps: { lat: 45.1, lng: 16.0 }, endGps: { lat: 45.11, lng: 16.01 } });
    expect(m.gpsVerified).toBe(true);
  });
});

describe('geofence + GPS-verified measured wait (V5 §1)', () => {
  it('haversine distance is roughly correct', () => {
    // ~1.11 km per 0.01° latitude.
    const d = haversineMeters({ lat: 45.0, lng: 17.0 }, { lat: 45.01, lng: 17.0 });
    expect(d).toBeGreaterThan(1050);
    expect(d).toBeLessThan(1180);
  });

  it('locates a point in approach / border / far zones', () => {
    expect(locateInGeofence(GEOFENCE.border, GEOFENCE)).toBe('border');
    expect(locateInGeofence(GEOFENCE.approach, GEOFENCE)).toBe('approach');
    expect(locateInGeofence({ lat: 46.0, lng: 18.0 }, GEOFENCE)).toBe('far');
  });

  it('GPS-verifies a real track: start at approach, end at booth, moved', () => {
    const m = computeMeasuredWait({
      startedAt: new Date(Date.now() - 1800000).toISOString(),
      finishedAt: new Date().toISOString(),
      startGps: GEOFENCE.approach,
      endGps: GEOFENCE.border,
    }, GEOFENCE);
    expect(m.gpsVerified).toBe(true);
    expect(m.gpsSuspicious).toBe(false);
  });

  it('flags a suspicious track: long wait but no movement (gaming)', () => {
    const m = computeMeasuredWait({
      startedAt: new Date(Date.now() - 1800000).toISOString(),
      finishedAt: new Date().toISOString(),
      startGps: GEOFENCE.border,
      endGps: GEOFENCE.border,
    }, GEOFENCE);
    expect(m.gpsVerified).toBe(false);
    expect(m.gpsSuspicious).toBe(true);
  });

  it('does not verify when both points are far from the crossing', () => {
    const m = computeMeasuredWait({
      startedAt: new Date(Date.now() - 1800000).toISOString(),
      finishedAt: new Date().toISOString(),
      startGps: { lat: 48.0, lng: 16.0 },
      endGps: { lat: 48.05, lng: 16.0 },
    }, GEOFENCE);
    expect(m.gpsVerified).toBe(false);
    expect(m.gpsSuspicious).toBe(true);
  });
});

describe('bias correction (V5 §2)', () => {
  const at = (hour) => { const d = new Date(); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
  it('learns a per-crossing correction once min sample is met, else stays neutral', () => {
    const records = [];
    // 6 records at the same crossing/direction/hour where we under-predicted by ~10 min.
    for (let i = 0; i < 6; i += 1) records.push({ crossingId: 'gradiska', direction: 'toBih', predictedWait: 30, actualWait: 40, predictedAt: at(9) });
    const bias = computeBiasCorrection(records, { minSample: 5 });
    const corr = bias.correctionFor('gradiska', 'toBih', 9);
    expect(corr.correctionMin).toBe(10); // actual - predicted
    expect(corr.n).toBeGreaterThanOrEqual(5);
  });

  it('returns a neutral correction when there are too few samples (no overfitting)', () => {
    const records = [{ crossingId: 'x', direction: 'toBih', predictedWait: 20, actualWait: 80, predictedAt: at(10) }];
    const bias = computeBiasCorrection(records, { minSample: 5 });
    expect(bias.correctionFor('x', 'toBih', 10).correctionMin).toBe(0);
    expect(bias.correctionFor('x', 'toBih', 10).basis).toBe('insufficient');
  });
});
