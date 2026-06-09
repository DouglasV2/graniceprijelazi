// Count → wait calibration (pure, unit-testable). Learns a per-(crossing,direction) rate that maps a
// TRUSTED camera vehicle count to a wait in minutes, from samples that pair a camera count with a
// MEASURED ground-truth wait (verified A→B / measured session / confirmed report). Until there are
// enough low-error samples a crossing stays UNcalibrated → the caller keeps using the heuristic.
//
// The model is a robust "minutes per vehicle" rate = median(measuredWait / count). Median (not mean)
// so a single outlier pair can't skew it; interpretable as a real per-vehicle service rate. We also
// report MAE so we only trust a rate that actually fits the observed data.

export function learnCountToWaitModel(samples = [], { minSamples = 6, maxMae = 18 } = {}) {
  const pairs = (samples || [])
    .map((s) => ({ count: Number(s.count), wait: Number(s.wait) }))
    .filter((s) => Number.isFinite(s.count) && Number.isFinite(s.wait) && s.count > 0 && s.wait >= 0);
  const sampleSize = pairs.length;
  if (sampleSize < minSamples) {
    return { calibrated: false, sampleSize, minutesPerVehicle: null, mae: null, reason: 'insufficient-samples' };
  }
  const ratios = pairs.map((p) => p.wait / p.count).sort((a, b) => a - b);
  const minutesPerVehicle = Math.round(ratios[Math.floor((ratios.length - 1) / 2)] * 100) / 100; // median ratio
  const errors = pairs.map((p) => Math.abs(minutesPerVehicle * p.count - p.wait));
  const mae = Math.round((errors.reduce((a, b) => a + b, 0) / errors.length) * 10) / 10;
  const calibrated = minutesPerVehicle > 0 && mae <= maxMae;
  return {
    calibrated,
    sampleSize,
    minutesPerVehicle,
    mae,
    reason: calibrated ? 'ok' : (minutesPerVehicle <= 0 ? 'non-positive-rate' : 'mae-too-high'),
  };
}

// Apply a learned model to a current count. Returns minutes, or null when not calibrated (→ heuristic).
export function applyCalibratedWait(count, model, { maxWaitMin = 360 } = {}) {
  if (!model || !model.calibrated || !Number.isFinite(Number(count))) return null;
  const c = Math.max(0, Number(count));
  if (c === 0) return 0; // a genuinely empty trusted ROI = no wait
  return Math.max(0, Math.min(maxWaitMin, Math.round(model.minutesPerVehicle * c)));
}

// Group resolved (count, measuredWait) records by `${crossingId}:${direction}` and learn a model per
// key. `records` come from the resolved-accuracy store, each carrying cameraCount + actualWait.
export function buildCalibrationModels(records = [], opts = {}) {
  const byKey = new Map();
  for (const r of records || []) {
    const count = Number(r.cameraCount ?? r.count);
    const wait = Number(r.actualWait ?? r.wait);
    if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(wait)) continue;
    const key = `${r.crossingId}:${r.direction}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ count, wait });
  }
  const out = {};
  for (const [key, samples] of byKey) out[key] = { ...learnCountToWaitModel(samples, opts), key };
  return out;
}

export function calibrationKey(crossingId, direction) {
  return `${crossingId}:${direction === 'toHr' ? 'toHr' : 'toBih'}`;
}
