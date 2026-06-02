// PrijelazRadar — Confidence Calibration (V5 §7).
//
// PURE module. Confidence must represent the model's REAL historical reliability against
// measured-wait ground truth — not a heuristic score. If the app says "Visoka pouzdanost",
// we must be able to prove (from resolved accuracy records) that such estimates were
// materially more accurate than "Srednja"/"Niska". HIGH therefore requires empirical proof;
// without enough measured samples a confidence is capped at MEDIUM (often LOW/INSUFFICIENT).

export const CALIBRATION_VERSION = 'cal-v1';
export const CONF_LEVELS = Object.freeze(['nedovoljno', 'niska', 'srednja', 'visoka']);

// Empirical thresholds a bucket must meet to EARN each level (spec §7 A).
export const CALIBRATION_THRESHOLDS = Object.freeze({
  high: { minN: 30, within15: 0.70, within30: 0.90, p90: 30, underRate: 0.40 },
  medium: { minN: 15, within30: 0.70, p90: 60 },
});

function isNum(v) { return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)); }
function clampUnit(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function median(a) { const s = [...a].sort((x, y) => x - y); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function percentile(a, p) { const s = [...a].sort((x, y) => x - y); if (!s.length) return null; const i = Math.max(0, Math.min(s.length - 1, Math.ceil(p * s.length) - 1)); return s[i]; }
function round1(n) { return Math.round(Number(n) * 10) / 10; }

// The source-mix class of a prediction (a coarse bucket key for calibration).
export function sourceMixClass(mix = {}) {
  if (mix.hasMeasured) return 'measured';
  if (mix.hasHardPublic) return 'official';
  if (mix.hasCamera && mix.hasGoogle) return 'camera+google';
  if (mix.hasCamera) return 'camera';
  if (mix.hasGoogle) return 'google';
  return 'other';
}

// Core error metrics for a set of resolved accuracy rows.
// underestimated = predictedWait < actualWait (worse for the user — they expect less than reality).
export function bucketMetrics(rows = []) {
  const valid = rows.filter((r) => isNum(r.predictedWait) && isNum(r.actualWait));
  const n = valid.length;
  if (!n) return null;
  const abs = valid.map((r) => Math.abs(Number(r.predictedWait) - Number(r.actualWait)));
  const signed = valid.map((r) => Number(r.predictedWait) - Number(r.actualWait));
  const within = (t) => valid.filter((r) => Math.abs(Number(r.predictedWait) - Number(r.actualWait)) <= t).length / n;
  return {
    n,
    mae: round1(mean(abs)),
    medianError: median(abs),
    p90Error: percentile(abs, 0.9),
    bias: round1(mean(signed)),
    underestimateRate: round1(valid.filter((r) => Number(r.predictedWait) < Number(r.actualWait)).length / n),
    overestimateRate: round1(valid.filter((r) => Number(r.predictedWait) > Number(r.actualWait)).length / n),
    within15: round1(within(15)),
    within30: round1(within(30)),
    avgConfidenceScore: round1(mean(valid.map((r) => Number(r.confidenceScore || 0)))),
  };
}

function meetsHigh(m, th) { return m && m.n >= th.high.minN && m.within15 >= th.high.within15 && m.within30 >= th.high.within30 && (m.p90Error ?? 999) <= th.high.p90 && m.underestimateRate <= th.high.underRate; }
function meetsMedium(m, th) { return m && m.n >= th.medium.minN && m.within30 >= th.medium.within30 && (m.p90Error ?? 999) <= th.medium.p90; }

// Build the calibration model from resolved accuracy records. Returns lookup helpers plus a
// status summary. Confidence is resolved by HIERARCHICAL SHRINKAGE: most specific bucket with
// enough samples wins, otherwise it falls back to coarser buckets, then the global baseline.
export function computeCalibrationModel(records = [], opts = {}) {
  const th = opts.thresholds || CALIBRATION_THRESHOLDS;
  const minHigh = th.high.minN;
  const minMed = th.medium.minN;
  const valid = records.filter((r) => isNum(r.predictedWait) && isNum(r.actualWait));

  const buckets = new Map();
  const add = (k, r) => { (buckets.get(k) || buckets.set(k, []).get(k)).push(r); };
  for (const r of valid) {
    const cls = sourceMixClass(r.sourceMix || {});
    const lvl = r.confidenceLevel || 'srednja';
    add('global', r);
    add(`L:${lvl}`, r);
    add(`gc:${cls}:${lvl}`, r);
    add(`c:${r.crossingId}:${r.direction}:${lvl}`, r);
    add(`cc:${r.crossingId}:${r.direction}:${cls}:${lvl}`, r);
  }
  const cache = new Map();
  const metricsFor = (k) => { if (!cache.has(k)) cache.set(k, bucketMetrics(buckets.get(k) || [])); return cache.get(k); };
  const globalBaseline = bucketMetrics(valid);

  function empiricalScore(m) {
    if (!m) return null;
    let s = 0.65 * m.within15 + 0.25 * m.within30 + 0.10 * Math.max(0, 1 - (m.p90Error ?? 60) / 60);
    if (m.underestimateRate > 0.45) s *= 0.85;
    return clampUnit(s);
  }
  const baseScore = empiricalScore(globalBaseline);
  function shrunkScore(m) {
    const raw = empiricalScore(m);
    if (raw === null) return baseScore ?? 0.5;
    const w = Math.min(1, m.n / minHigh); // shrink toward baseline when few samples
    return clampUnit(w * raw + (1 - w) * (baseScore ?? 0.5));
  }

  // Resolve a calibrated confidence from a provisional (heuristic, already-downgraded) level.
  // Never upgrades above the provisional; HIGH is granted only with empirical proof.
  function calibratedConfidence(provisionalLevel, ctx = {}) {
    const cls = ctx.sourceMixClass || sourceMixClass(ctx.sourceMix || {});
    const lvl = provisionalLevel;
    const chain = [
      `cc:${ctx.crossingId}:${ctx.direction}:${cls}:${lvl}`,
      `c:${ctx.crossingId}:${ctx.direction}:${lvl}`,
      `gc:${cls}:${lvl}`,
      `L:${lvl}`,
    ];
    let m = null;
    let basis = 'insufficient';
    for (const k of chain) { const cand = metricsFor(k); if (cand && cand.n >= minMed) { m = cand; basis = k; break; } }
    if (!m && globalBaseline) { m = globalBaseline; basis = 'global-baseline'; }

    let level = provisionalLevel;
    const reasons = [];
    if (provisionalLevel === 'visoka') {
      if (m && m.n >= minHigh && meetsHigh(m, th)) {
        level = 'visoka';
      } else {
        level = 'srednja';
        reasons.push(m && m.n >= minHigh ? 'povijesna točnost ne potvrđuje visoku pouzdanost' : 'nedovoljno izmjerenih prolazaka za visoku pouzdanost');
      }
    }
    if (level === 'srednja' && m && m.n >= minMed && !meetsMedium(m, th)) {
      level = 'niska';
      reasons.push('povijesna točnost je niska za ovu vrstu procjene');
    }
    const score = m ? shrunkScore(m) : (provisionalLevel === 'visoka' ? 0.7 : provisionalLevel === 'srednja' ? 0.52 : provisionalLevel === 'niska' ? 0.34 : 0.1);
    return {
      level,
      score: Math.round(clampUnit(score) * 100) / 100,
      basis,
      sampleSize: m ? m.n : 0,
      bucketMetrics: m || null,
      reasons,
      calibrationVersion: CALIBRATION_VERSION,
      hasData: Boolean(m && m.n >= minMed && basis !== 'global-baseline'),
    };
  }

  return { calibratedConfidence, metricsFor, globalBaseline, sampleSize: valid.length, calibrationVersion: CALIBRATION_VERSION };
}

// Pre-calibration heuristic downgrade rules (spec §7 D). Calibration runs AFTER this and has
// the last word, but these guarantee structural caps regardless of historical data.
export function applyConfidenceDowngrades(startLevel, ctx = {}) {
  let level = startLevel;
  const reasons = [];
  const cap = (maxLevel, reason) => {
    if (CONF_LEVELS.indexOf(level) > CONF_LEVELS.indexOf(maxLevel)) { level = maxLevel; reasons.push(reason); }
  };
  if (Number(ctx.conflictSpread) > 45) cap('niska', 'izvori se jako ne slažu');
  else if (Number(ctx.conflictSpread) > 25) cap('srednja', 'izvori se ne slažu');
  if (ctx.cameraStale) cap('srednja', 'kamera je zastarjela');
  if (ctx.cameraHeuristicOnly) {
    cap('srednja', 'procjena iz kamere bez CV modela');
    if (ctx.queueBand === 'nema' || ctx.queueBand === 'mala') cap('niska', 'kamera ne pokazuje jasnu kolonu');
  }
  if (ctx.googleOnly) cap('srednja', 'samo Google prilazni promet (ne čekanje na granici)');
  if (ctx.singleSource && !ctx.hasRecentMeasured) cap('srednja', 'samo jedan izvor');
  if (ctx.staleData) cap('niska', 'podaci su stari');
  return { level, reasons };
}

// Confidence quality KPIs (spec §7 C). overall + per crossing/direction + per confidence bucket,
// with a reliability ordering check (HIGH must beat MEDIUM must beat LOW) → miscalibrated flag.
export function computeConfidenceCalibrationStats(records = []) {
  const valid = records.filter((r) => isNum(r.predictedWait) && isNum(r.actualWait));
  const byBucket = { visoka: [], srednja: [], niska: [], nedovoljno: [] };
  const byCrossing = {};
  for (const r of valid) {
    const lvl = byBucket[r.confidenceLevel] ? r.confidenceLevel : 'nedovoljno';
    byBucket[lvl].push(r);
    const key = `${r.crossingId}:${r.direction}`;
    (byCrossing[key] = byCrossing[key] || []).push(r);
  }
  const perBucket = Object.fromEntries(Object.entries(byBucket).map(([k, rows]) => [k, bucketMetrics(rows)]));
  const perCrossing = Object.fromEntries(Object.entries(byCrossing).map(([k, rows]) => [k, bucketMetrics(rows)]));

  // Reliability ordering: better (lower MAE / higher within15) should track HIGH > MEDIUM > LOW.
  const order = ['visoka', 'srednja', 'niska'].map((l) => ({ level: l, m: perBucket[l] })).filter((x) => x.m && x.m.n >= 5);
  let miscalibrated = false;
  const reliabilityIssues = [];
  for (let i = 0; i + 1 < order.length; i += 1) {
    const hi = order[i];
    const lo = order[i + 1];
    if (hi.m.within15 < lo.m.within15 - 0.05 || hi.m.mae > lo.m.mae + 3) {
      miscalibrated = true;
      reliabilityIssues.push(`${hi.level} nije pouzdaniji od ${lo.level} (within15 ${hi.m.within15} vs ${lo.m.within15}, MAE ${hi.m.mae} vs ${lo.m.mae})`);
    }
  }
  return { overall: bucketMetrics(valid), perBucket, perCrossing, sampleSize: valid.length, miscalibrated, reliabilityIssues };
}

// Abs-error histogram, grouped by confidence bucket (spec §7 G).
export function computeErrorHistogram(records = []) {
  const bins = [[0, 5], [5, 10], [10, 15], [15, 30], [30, 45], [45, 60], [60, Infinity]];
  const labels = ['0-5', '5-10', '10-15', '15-30', '30-45', '45-60', '60+'];
  const blank = () => labels.reduce((acc, l) => ({ ...acc, [l]: 0 }), {});
  const out = { visoka: blank(), srednja: blank(), niska: blank(), nedovoljno: blank(), overall: blank() };
  for (const r of records) {
    if (!isNum(r.predictedWait) || !isNum(r.actualWait)) continue;
    const e = Math.abs(Number(r.predictedWait) - Number(r.actualWait));
    const idx = bins.findIndex(([lo, hi]) => e >= lo && e < hi);
    const label = labels[idx === -1 ? labels.length - 1 : idx];
    const lvl = out[r.confidenceLevel] ? r.confidenceLevel : 'nedovoljno';
    out[lvl][label] += 1;
    out.overall[label] += 1;
  }
  return out;
}

// Reliability report + actionable recommendations (spec §7 G).
export function computeReliabilityReport(records = []) {
  const stats = computeConfidenceCalibrationStats(records);
  const crossingsRanked = Object.entries(stats.perCrossing)
    .filter(([, m]) => m && m.n >= 5)
    .map(([key, m]) => ({ key, ...m }));
  const worstMae = [...crossingsRanked].sort((a, b) => b.mae - a.mae).slice(0, 5);
  const worstUnderestimate = [...crossingsRanked].sort((a, b) => b.underestimateRate - a.underestimateRate).slice(0, 5);
  const recommendations = [];
  if (stats.miscalibrated) recommendations.push('Confidence je miskalibriran — privremeno onemogući HIGH dok se ne sredi.');
  for (const c of worstMae) if (c.mae > 25) recommendations.push(`Visoka greška na ${c.key} (MAE ${c.mae} min) — treba više izmjerenih prolazaka.`);
  for (const c of worstUnderestimate) if (c.underestimateRate > 0.5) recommendations.push(`${c.key} sustavno podcjenjuje čekanje (${Math.round(c.underestimateRate * 100)}%).`);
  return { ...stats, worstMae, worstUnderestimate, recommendations };
}
