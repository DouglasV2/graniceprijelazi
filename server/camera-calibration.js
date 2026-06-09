// Count → wait calibration (pure, unit-testable). Learns a per-(crossing,direction) rate that maps a
// TRUSTED camera vehicle count to a wait in minutes, from samples that pair a camera count with a
// ground-truth wait. Sources are WEIGHTED by trust:
//   verified (measured A→B / measured session / official ground truth) → weight 1.0   (primary truth)
//   report   (driver reports / chat) → weight 0.35                                    (lower trust)
// A crossing only becomes `calibrated` with enough samples, a low (weighted) MAE, AND at least a few
// VERIFIED samples — driver reports speed up data collection but can NEVER auto-calibrate alone or
// skew the learned rate (robust weighted-median ratio ignores outliers).

const TIER_WEIGHT = { verified: 1.0, report: 0.35 };

// Map a resolution source string to a trust tier. Anything mentioning report/chat/dojava is a
// lower-trust driver report; everything else (measured-session, location-wait, ground-truth:*) is verified.
export function classifySampleSource(source = '') {
  const s = String(source || '').toLowerCase();
  return /report|chat|dojav/.test(s) ? 'report' : 'verified';
}

function normalizePairs(samples = []) {
  return (samples || [])
    .map((s) => {
      const tier = s.tier || classifySampleSource(s.source);
      return { count: Number(s.count), wait: Number(s.wait), tier, weight: Number.isFinite(Number(s.weight)) ? Number(s.weight) : (TIER_WEIGHT[tier] ?? 0.35) };
    })
    .filter((s) => Number.isFinite(s.count) && Number.isFinite(s.wait) && s.count > 0 && s.wait >= 0);
}

function weightedMedian(items) {
  // items: [{ value, weight }] — value = wait/count ratio. Robust to outliers (a 300-min mistake
  // can't move the median). Returns the value at the half-weight crossing.
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return null;
  let acc = 0;
  for (const x of sorted) { acc += x.weight; if (acc >= total / 2) return x.value; }
  return sorted[sorted.length - 1].value;
}

export function learnCountToWaitModel(samples = [], { minSamples = 6, maxMae = 18, minVerifiedSamples = 2 } = {}) {
  const pairs = normalizePairs(samples);
  const sampleSize = pairs.length;
  const verifiedCount = pairs.filter((p) => p.tier === 'verified').length;
  const reportCount = pairs.filter((p) => p.tier === 'report').length;
  const breakdown = { verified: verifiedCount, report: reportCount };
  if (sampleSize < minSamples) {
    return { calibrated: false, sampleSize, minutesPerVehicle: null, mae: null, breakdown, reason: 'insufficient-samples' };
  }
  const ratio = weightedMedian(pairs.map((p) => ({ value: p.wait / p.count, weight: p.weight })));
  const minutesPerVehicle = Math.round((ratio ?? 0) * 100) / 100;
  const totalW = pairs.reduce((s, p) => s + p.weight, 0) || 1;
  const mae = Math.round((pairs.reduce((s, p) => s + p.weight * Math.abs(minutesPerVehicle * p.count - p.wait), 0) / totalW) * 10) / 10;
  // Reports alone must NOT auto-calibrate — require a floor of verified/measured samples.
  const hasVerifiedFloor = verifiedCount >= minVerifiedSamples;
  const calibrated = minutesPerVehicle > 0 && mae <= maxMae && hasVerifiedFloor;
  const reason = !hasVerifiedFloor ? 'needs-verified-samples'
    : (minutesPerVehicle <= 0 ? 'non-positive-rate' : (mae > maxMae ? 'mae-too-high' : 'ok'));
  return { calibrated, sampleSize, minutesPerVehicle, mae, breakdown, reason };
}

// Apply a learned model to a current count. Returns minutes, or null when not calibrated (→ heuristic).
export function applyCalibratedWait(count, model, { maxWaitMin = 360 } = {}) {
  if (!model || !model.calibrated || !Number.isFinite(Number(count))) return null;
  const c = Math.max(0, Number(count));
  if (c === 0) return 0; // a genuinely empty trusted ROI = no wait
  return Math.max(0, Math.min(maxWaitMin, Math.round(model.minutesPerVehicle * c)));
}

// Group resolved (count, measuredWait, source) records by `${crossingId}:${direction}` and learn a
// model per key. Each record carries cameraCount + actualWait + source (→ trust tier).
export function buildCalibrationModels(records = [], opts = {}) {
  const byKey = new Map();
  for (const r of records || []) {
    const count = Number(r.cameraCount ?? r.count);
    const wait = Number(r.actualWait ?? r.wait);
    if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(wait)) continue;
    const key = `${r.crossingId}:${r.direction}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ count, wait, source: r.source, tier: r.tier });
  }
  const out = {};
  for (const [key, samples] of byKey) out[key] = { ...learnCountToWaitModel(samples, opts), key };
  return out;
}

export function calibrationKey(crossingId, direction) {
  return `${crossingId}:${direction === 'toHr' ? 'toHr' : 'toBih'}`;
}
