// PrijelazRadar — Intelligence layer (V4).
//
// This module is intentionally PURE: no network, no DB, no globals. Everything it
// needs is passed in. That makes the accuracy-critical logic (confidence, ranges,
// explanations, trust, camera queue bands, stale detection, accuracy stats, alerts,
// best-crossing) unit-testable in isolation and keeps the 5,900-line server file's
// blast radius small.
//
// The single most important product KPI is: "how close is the estimate to the real
// wait." Every function here optimises for that — primarily by being HONEST about
// uncertainty (ranges + confidence levels + "ne znam") instead of emitting a single
// falsely-precise number.

export const CONFIDENCE_LEVELS = Object.freeze({ HIGH: 'visoka', MEDIUM: 'srednja', LOW: 'niska', NONE: 'nedovoljno' });

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function round(n) {
  return Math.round(Number(n) || 0);
}

// True only for an actual finite numeric value — null/undefined/'' are NOT numbers
// (Number(null) === 0 is finite, which would silently corrupt accuracy/alert logic).
function isNum(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

function median(values = []) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values = [], p = 0.9) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const idx = clamp(Math.ceil(p * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[idx];
}

// ───────────────────────────────────────────────────────────────────────────
// 1. CONFIDENCE ENGINE
// ───────────────────────────────────────────────────────────────────────────
//
// Combines, transparently and additively, every factor that should move our
// trust in a wait estimate: how many INDEPENDENT sources back it, how fresh
// they are, whether they agree, camera quality/freshness, and report quality.
//
// `signals` is an array of normalised descriptors:
//   { kind: 'official'|'camera'|'google'|'report'|'measured', wait, ageMinutes,
//     confidence (0-100), soft (bool), stale (bool), trust (0-1, reports only),
//     queue (camera) }
//
// Returns { score (0-100), level, precision, factors[], independentSources }.
// `factors` is a human-readable breakdown so the UI/admin can show WHY.
export function computeConfidenceProfile(input = {}) {
  const signals = Array.isArray(input.signals) ? input.signals.filter(Boolean) : [];
  const agreementSpread = input.agreementSpread; // minutes spread among hard sources
  const factors = [];

  if (!signals.length) {
    return {
      score: 0,
      level: CONFIDENCE_LEVELS.NONE,
      precision: 'unknown',
      independentSources: 0,
      factors: [{ key: 'no-source', label: 'Nema živog izvora', impact: 0 }],
    };
  }

  let score = 18; // floor for "we have at least one signal"
  const kinds = new Set();
  let freshHardCount = 0;
  let hasMeasured = false;
  let cameraStaleOnly = false;

  for (const s of signals) {
    const age = Number(s.ageMinutes ?? 0);
    const baseConf = clamp(s.confidence ?? 50, 0, 100);
    const ageDecay = age <= 10 ? 1 : age <= 25 ? 0.75 : age <= 45 ? 0.5 : 0.25;
    const kindWeight = s.kind === 'measured' ? 26
      : s.kind === 'official' ? (s.soft ? 9 : 20)
      : s.kind === 'camera' ? (s.stale ? 4 : 14)
      : s.kind === 'report' ? clamp(8 + (s.trust ?? 0.4) * 14, 6, 22)
      : s.kind === 'google' ? 7
      : 6;
    const contribution = kindWeight * ageDecay * (0.5 + baseConf / 200);
    score += contribution;
    kinds.add(s.kind);
    if (s.kind === 'measured') hasMeasured = true;
    if ((s.kind === 'official' && !s.soft) || s.kind === 'measured' || (s.kind === 'camera' && !s.stale)) {
      if (age <= 45) freshHardCount += 1;
    }
    factors.push({
      key: `${s.kind}${s.soft ? '-soft' : ''}${s.stale ? '-stale' : ''}`,
      label: kindLabel(s.kind, s),
      impact: round(contribution),
      ageMinutes: round(age),
    });
  }

  const independentSources = kinds.size;

  // Cross-source AGREEMENT bonus / DISAGREEMENT penalty (the spec's core example).
  if (Number.isFinite(agreementSpread) && freshHardCount >= 2) {
    if (agreementSpread <= 6) { score += 22; factors.push({ key: 'agreement-strong', label: 'Izvori se snažno slažu', impact: 22 }); }
    else if (agreementSpread <= 14) { score += 10; factors.push({ key: 'agreement-moderate', label: 'Izvori se uglavnom slažu', impact: 10 }); }
    else if (agreementSpread > 28) { score -= 16; factors.push({ key: 'disagreement', label: 'Izvori se ne slažu', impact: -16 }); }
  }

  // Multiple independent KINDS is itself evidence.
  if (independentSources >= 3) { score += 12; factors.push({ key: 'multi-source', label: '3+ neovisna izvora', impact: 12 }); }
  else if (independentSources === 1) { score -= 10; factors.push({ key: 'single-source', label: 'Samo jedan izvor', impact: -10 }); }

  // Penalise the dangerous case: only a stale camera or only Google.
  if (signals.length === 1) {
    const only = signals[0];
    if (only.kind === 'camera' && only.stale) { score -= 18; cameraStaleOnly = true; factors.push({ key: 'stale-camera-only', label: 'Samo zastarjela kamera', impact: -18 }); }
    if (only.kind === 'google') { score -= 14; factors.push({ key: 'google-only', label: 'Samo Google promet (prilazna cesta)', impact: -14 }); }
    if (only.kind === 'official' && only.soft) { score -= 8; factors.push({ key: 'soft-only', label: 'Samo okvirna (soft) procjena', impact: -8 }); }
  }

  score = round(clamp(score, 0, 99));
  let level;
  if (score >= 70) level = CONFIDENCE_LEVELS.HIGH;
  else if (score >= 45) level = CONFIDENCE_LEVELS.MEDIUM;
  else level = CONFIDENCE_LEVELS.LOW;

  // Precision decides exact-number vs range vs "ne znam".
  let precision;
  if (level === CONFIDENCE_LEVELS.HIGH && !cameraStaleOnly) precision = 'exact';
  else if (level === CONFIDENCE_LEVELS.LOW) precision = 'range';
  else precision = 'range';

  return { score, level, precision, independentSources, hasMeasured, factors };
}

function kindLabel(kind, s = {}) {
  switch (kind) {
    case 'official': return s.soft ? 'Službeni izvor (okvirno)' : 'Službeni izvor';
    case 'camera': return s.stale ? 'Kamera (zastarjela slika)' : 'Kamera';
    case 'google': return 'Google promet';
    case 'report': return 'Dojava vozača';
    case 'measured': return 'Izmjereno čekanje';
    default: return 'Izvor';
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 1b. SOURCE PRIORITY LADDER + TRUST + STRUCTURED EXPLANATION (spec V5 §3/§4)
// ───────────────────────────────────────────────────────────────────────────
//
// Formal hierarchy: a clear/blue Google road never outranks a real booth signal — it
// only describes approach traffic. Higher tiers, when present, are the wait authority.
export const SOURCE_PRIORITY = Object.freeze(['admin', 'measured', 'official', 'camera', 'report', 'historical', 'google']);

// Trust score in [0,1] per source. Reports pass their own engine trust; the rest derive
// it from kind, freshness and quality flags (soft/stale). This is the weight's "why".
export function sourceTrustScore(kind, { ageMinutes = 0, confidence = 50, soft = false, stale = false, trust = null } = {}) {
  if (trust !== null && trust !== undefined) return Math.round(clamp(trust, 0, 1) * 100) / 100;
  const ageMult = ageMinutes <= 10 ? 1 : ageMinutes <= 25 ? 0.8 : ageMinutes <= 45 ? 0.55 : 0.3;
  const base = kind === 'admin' ? 1
    : kind === 'measured' ? 0.9
    : kind === 'official' ? (soft ? 0.55 : 0.85)
    : kind === 'camera' ? (stale ? 0.25 : 0.65)
    : kind === 'report' ? 0.5
    : kind === 'google' ? 0.4
    : 0.5;
  return Math.round(clamp(base * ageMult * (0.6 + confidence / 250), 0, 1) * 100) / 100;
}

// Build the structured "why this estimate?" payload the UI renders. `descriptors` is
// one entry per source that the fusion saw:
//   { kind, tier, label, value (wait), weight, ageMinutes, confidence, soft, stale,
//     directionVerified, heuristic, excluded, excludeReason, trust }
// Returns per-source contribution %, role, honest flags, conflict detection, and whether
// Google acted as the wait authority.
export function buildEstimateExplanation(descriptors = [], ctx = {}) {
  const used = descriptors.filter((d) => !d.excluded && Number(d.weight) > 0);
  const totalWeight = used.reduce((sum, d) => sum + Number(d.weight || 0), 0) || 1;
  const present = new Set(used.map((d) => d.tier || d.kind));
  if (ctx.admin) present.add('admin');
  const authorityTier = SOURCE_PRIORITY.find((t) => present.has(t)) || null;
  const googleAsAuthority = authorityTier === 'google';
  const leadId = used.length ? [...used].sort((a, b) => b.weight - a.weight)[0] : null;

  const flagsFor = (d) => {
    const f = [];
    if (d.kind === 'official' && d.soft) f.push('okvirno (soft)');
    if (d.kind === 'camera') {
      if (d.heuristic) f.push('heuristika (bez CV modela)');
      if (d.stale) f.push('zastarjela slika');
      if (d.directionVerified) f.push('smjer potvrđen'); else f.push('smjer nepotvrđen');
      if (Number(d.confidence) < 50) f.push('niska pouzdanost kamere');
    }
    if (d.kind === 'google') f.push(googleAsAuthority ? 'jedini signal' : 'samo prilazni promet (ne diktira čekanje)');
    if (d.kind === 'measured') f.push(d.flags?.includes('gps') ? 'GPS potvrđeno' : 'izmjereno');
    if (d.excluded && d.excludeReason) f.push(d.excludeReason);
    return f;
  };

  const sources = descriptors.map((d) => {
    const trust = sourceTrustScore(d.kind, d);
    const usedThis = !d.excluded && Number(d.weight) > 0;
    const contributionPct = usedThis ? Math.round((Number(d.weight) / totalWeight) * 100) : 0;
    const role = d.excluded ? 'excluded'
      : (d.kind === 'google' && !googleAsAuthority) ? 'helper'
      : (leadId && d === leadId) ? 'lead'
      : 'support';
    return { kind: d.kind, label: d.label, value: Number.isFinite(Number(d.value)) ? Number(d.value) : null, contributionPct, trust, role, used: usedThis, ageMinutes: Math.round(Number(d.ageMinutes || 0)), flags: flagsFor(d) };
  });

  // Conflict: disagreement among the BOOTH-truthful sources (everyone except Google).
  const hardValues = used.filter((d) => d.kind !== 'google' && Number.isFinite(Number(d.value))).map((d) => Number(d.value));
  const spread = hardValues.length >= 2 ? Math.max(...hardValues) - Math.min(...hardValues) : 0;
  const conflict = { detected: spread > 25, spreadMinutes: spread, kinds: hardValues.length >= 2 ? [...new Set(used.filter((d) => d.kind !== 'google').map((d) => d.kind))] : [] };

  return { authorityTier, googleAsAuthority, conflict, sources, summary: ctx.summary || '' };
}

// ───────────────────────────────────────────────────────────────────────────
// 2. SMART RANGES
// ───────────────────────────────────────────────────────────────────────────
//
// False precision kills trust. When confidence is not HIGH we widen into a band.
// The band scales with confidence level AND disagreement spread.
export function computeSmartRange(wait, profile = {}, opts = {}) {
  if (!isNum(wait)) return { rangeMin: null, rangeMax: null, precision: 'unknown' };
  const n = Number(wait);
  const level = profile.level || CONFIDENCE_LEVELS.MEDIUM;
  const spread = Number(opts.agreementSpread);
  const heavyGoogle = Boolean(opts.heavyGoogle);

  // Base half-width by confidence level, as a fraction of the wait + a floor.
  let frac;
  let floor;
  if (level === CONFIDENCE_LEVELS.HIGH) { frac = 0.12; floor = 4; }
  else if (level === CONFIDENCE_LEVELS.MEDIUM) { frac = 0.22; floor = 7; }
  else { frac = 0.38; floor = 10; }

  let half = Math.max(floor, Math.round(n * frac));
  if (Number.isFinite(spread) && spread > 20) half += Math.round(Math.min(20, spread * 0.4));
  if (heavyGoogle) half += 6;

  const rangeMin = Math.max(0, n - half);
  const rangeMax = Math.min(360, n + half + (heavyGoogle ? 4 : 0));
  return {
    rangeMin,
    rangeMax,
    precision: profile.precision || (level === CONFIDENCE_LEVELS.HIGH ? 'exact' : 'range'),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 3. SOURCE EXPLANATION ENGINE
// ───────────────────────────────────────────────────────────────────────────
//
// Every estimate must say WHY. `parts` describes what fed it.
//   { official, officialSoft, cameraQueue, cameraClear, cameraStale, googleClear,
//     googleHeavy, reportCount, measuredCount, googleClearWhileQueue,
//     disagreement, cameraVisualOnly }
export function buildSourceExplanation(parts = {}) {
  const used = [];
  if (parts.measuredCount > 0) used.push(parts.measuredCount === 1 ? 'jednom izmjerenom prolasku' : `${parts.measuredCount} izmjerena prolaska`);
  if (parts.official) used.push(parts.officialSoft ? 'okvirnom službenom izvoru' : 'službenom izvoru');
  if (parts.cameraQueue || parts.cameraClear) used.push(parts.cameraStale ? 'kameri (zastarjela slika)' : 'kameri');
  if (parts.reportCount > 0) used.push(parts.reportCount === 1 ? '1 korisničkoj dojavi' : `${parts.reportCount} korisničke dojave`);

  let sentence;
  if (!used.length && parts.googleClear) {
    sentence = 'Procjena se temelji uglavnom na Google prometu na prilaznoj cesti. Nema svježih službenih podataka ni kamere — pouzdanost je niska.';
  } else if (!used.length) {
    sentence = 'Trenutno nema dovoljno podataka za pouzdanu procjenu.';
  } else if (used.length === 1) {
    sentence = `Procjena se temelji na ${used[0]}.`;
  } else {
    const last = used[used.length - 1];
    sentence = `Procjena se temelji na ${used.slice(0, -1).join(', ')} i ${last}.`;
  }

  // The signature conflict the spec calls out explicitly.
  if (parts.googleClearWhileQueue) {
    sentence += ' Google promet izgleda protočno, ali službeni izvor ili kamera pokazuje kolonu na samoj graničnoj kontroli.';
  } else if (parts.googleClear && used.length) {
    sentence += ' Google promet je normalan na prilaznoj cesti, no to ne znači nulto čekanje na granici.';
  }
  if (parts.googleHeavy) sentence += ' Google pokazuje gust promet na prilazu.';
  if (parts.disagreement) sentence += ' Izvori se međusobno ne slažu pa je raspon procjene širi.';
  if (parts.cameraVisualOnly) sentence += ' Kamera ovog smjera služi samo za vizualnu provjeru i ne ulazi u izračun čekanja.';
  return sentence;
}

// ───────────────────────────────────────────────────────────────────────────
// 4b. YOLO + ROI (spec V5 §6)
// ───────────────────────────────────────────────────────────────────────────
//
// YOLO gives REAL vehicle detections (boxes). The ROI decides which of them are in the
// actual queue. This is the pure geometry + counting layer — testable in isolation and
// runtime-agnostic (the YOLO transport lives in the server, behind a feature flag).
const VEHICLE_TYPES = new Set(['car', 'auto', 'van', 'kombi', 'truck', 'kamion', 'bus', 'autobus']);

function isVehicleDetection(d = {}) {
  const t = String(d.type || d.label || d.cls || '').toLowerCase();
  return VEHICLE_TYPES.has(t) || /\b(car|van|truck|bus)\b/.test(t);
}

function vehicleClass(d = {}) {
  const t = String(d.type || d.label || d.cls || 'car').toLowerCase();
  if (t.includes('truck') || t.includes('kamion')) return 'trucks';
  if (t.includes('bus')) return 'buses';
  if (t.includes('van') || t.includes('kombi')) return 'vans';
  return 'cars';
}

// Axis-aligned rectangle membership in PERCENT coordinates (0-100). `rotate` on a ROI is
// cosmetic for the overlay; for membership we use the bounding rectangle (conservative).
export function pointInRect(px, py, rect) {
  if (!rect) return false;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const w = Number(rect.w);
  const h = Number(rect.h);
  if (![x, y, w, h, px, py].every(Number.isFinite)) return false;
  return px >= x && px <= x + w && py >= y && py <= y + h;
}

// Which side of the count line a point is on (sign of the 2D cross product). Used as a
// snapshot proxy for "already crossed" — true temporal crossing needs frame-to-frame tracking.
export function detectionPastCountLine(d = {}, line = null) {
  if (!line) return false;
  const { x1, y1, x2, y2 } = line;
  if (![x1, y1, x2, y2].every((n) => Number.isFinite(Number(n)))) return false;
  const cross = (x2 - x1) * (Number(d.y) - y1) - (y2 - y1) * (Number(d.x) - x1);
  return cross < 0; // one consistent side = "past the booth"
}

// Filter raw YOLO detections by the camera calibration: keep vehicles inside the queue ROI,
// drop anything in an ignore zone (parking, opposite direction, booths, frame edges) or
// outside the ROI, and count by class. Returns full diagnostics for the audit/debug.
export function applyRoiToDetections(detections = [], calibration = {}, opts = {}) {
  const queueRoi = calibration.queueRoi || calibration.roi || null;
  const ignoreZones = Array.isArray(calibration.ignoreZones) ? calibration.ignoreZones : [];
  const countLine = calibration.countLine || null;
  const minConfidence = opts.minConfidence ?? 35;
  const list = Array.isArray(detections) ? detections : [];

  const inRoi = [];
  const ignored = [];
  let passedVehicles = 0;
  const counts = { cars: 0, vans: 0, trucks: 0, buses: 0 };

  for (const d of list) {
    if (!isVehicleDetection(d)) { ignored.push({ ...d, reason: 'not_vehicle' }); continue; }
    if (Number(d.confidence ?? 100) < minConfidence) { ignored.push({ ...d, reason: 'low_confidence' }); continue; }
    const cx = Number(d.x);
    const cy = Number(d.y);
    if (ignoreZones.some((z) => pointInRect(cx, cy, z))) { ignored.push({ ...d, reason: 'ignore_zone' }); continue; }
    if (queueRoi && !pointInRect(cx, cy, queueRoi)) { ignored.push({ ...d, reason: 'outside_roi' }); continue; }
    inRoi.push(d);
    counts[vehicleClass(d)] += 1;
    if (detectionPastCountLine(d, countLine)) passedVehicles += 1;
  }

  const visibleVehicles = list.filter(isVehicleDetection).length; // all vehicles in frame
  return {
    hasRoi: Boolean(queueRoi),
    detectionsBeforeRoi: visibleVehicles,
    detectionsAfterRoi: inRoi.length,
    visibleVehicles,
    queueVehicles: inRoi.length,
    counts,
    passedVehicles,
    countLineCrossings: passedVehicles,
    inRoi,
    ignored,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 4c. CAMERA INTELLIGENCE v6 — wait-from-signals + YOLO eligibility (spec §6/§8/§11)
// ───────────────────────────────────────────────────────────────────────────
//
// Derive a wait from camera queue+flow signals. The physical model is queueing: wait ≈
// queue / throughput. High queue + low flow ⇒ high wait; high queue + high flow ⇒ lower;
// low queue + high flow ⇒ low. Without ROI/direction there is NO reliable wait; without flow
// or calibration we return a RANGE, never a confident single number.
export function estimateWaitFromCameraSignals(input = {}) {
  const { queueVehicles = null, flowVehiclesPerMinute = null, congestionBand = null, calibrationProfile = null, hasRoi = false, hasDirection = false, hasCountLine = false } = input;
  const reasonCodes = [];
  if (!hasRoi) { reasonCodes.push('missing_queue_roi'); return { waitMinutes: null, waitRange: null, precise: false, confidence: 'none', reasonCodes }; }
  if (!hasDirection) { reasonCodes.push('direction_not_verified'); return { waitMinutes: null, waitRange: null, precise: false, confidence: 'none', reasonCodes }; }
  if (!isNum(queueVehicles)) { reasonCodes.push('no_queue_count'); return { waitMinutes: null, waitRange: null, precise: false, confidence: 'low', reasonCodes }; }

  const cal = calibrationProfile || {};
  const vehicleToMinute = isNum(cal.vehicleToMinuteFactor) ? cal.vehicleToMinuteFactor : 1.2;
  const minWait = isNum(cal.minWait) ? cal.minWait : 0;
  const maxWait = isNum(cal.maxWait) ? cal.maxWait : 240;
  const enoughCal = cal.enoughMeasuredVolume === true;
  const q = Number(queueVehicles);
  const flowKnown = isNum(flowVehiclesPerMinute);
  const flow = flowKnown ? Number(flowVehiclesPerMinute) : null;

  let base;
  if (flowKnown && flow > 0) {
    base = clamp(q / flow, minWait, maxWait); // drain time = the wait
  } else if (flowKnown && flow === 0) {
    base = clamp(q * vehicleToMinute * 1.5, minWait, maxWait); // stopped queue → longer
    reasonCodes.push('stopped_queue');
  } else {
    base = clamp(q * vehicleToMinute, minWait, maxWait); // no flow → rough, wide range
    reasonCodes.push('insufficient_frames_for_flow');
  }
  if (!hasCountLine && !reasonCodes.includes('insufficient_frames_for_flow')) reasonCodes.push('no_count_line');

  const wide = !flowKnown || !hasCountLine || !enoughCal;
  if (!enoughCal) reasonCodes.push('uncalibrated');
  const waitMinutes = Math.round(base);
  const half = wide ? Math.max(8, Math.round(waitMinutes * 0.4)) : Math.max(4, Math.round(waitMinutes * 0.18));
  return {
    waitMinutes,
    waitRange: { min: Math.max(0, waitMinutes - half), max: Math.min(360, waitMinutes + half) },
    precise: !wide,
    confidence: enoughCal ? (wide ? 'medium' : 'medium') : 'low',
    congestionBand: congestionBand || null,
    reasonCodes,
  };
}

// Decide whether a camera may be used by YOLO in SHADOW (record only) and in FUSION (drives
// wait) modes. Fusion is strict: ROI + direction + countLine + fresh + latency + confidence +
// no error + good calibration + on the per-camera fusion allowlist. Shadow is lenient.
export function cameraYoloEligibility(camera = {}, direction = null, runtime = {}, flags = {}) {
  const reasonCodes = [];
  const hasRoi = Boolean(camera.queueRoi || camera.calibration?.queueRoi || camera.calibration?.roi);
  const validForDir = Array.isArray(camera.validForDirections) && camera.validForDirections.length > 0 && (!direction || camera.validForDirections.includes(direction));
  const hasCountLine = Boolean(camera.countLine || camera.calibration?.countLine);
  const fresh = runtime.hasFreshFrame !== false;
  const latencyOk = !isNum(runtime.latencyMs) || Number(runtime.latencyMs) <= (flags.maxLatencyMs ?? 8000);
  const confOk = !isNum(runtime.confidence) || Number(runtime.confidence) >= (flags.minConfidence ?? 35);
  const noError = !runtime.error && !runtime.timedOut;
  const calOk = runtime.calibrationOk !== false;

  if (!hasRoi) reasonCodes.push('missing_queue_roi');
  if (!validForDir) reasonCodes.push('direction_not_verified');
  if (!hasCountLine) reasonCodes.push('missing_count_line');
  if (!fresh) reasonCodes.push('stale_frame');
  if (!latencyOk) reasonCodes.push('latency_exceeded');
  if (!confOk) reasonCodes.push('low_confidence');
  if (!noError) reasonCodes.push('runtime_error');
  if (!calOk) reasonCodes.push('bad_calibration');

  const camId = camera.cameraId || camera.id;
  const shadowAllow = !Array.isArray(flags.shadowAllowlist) || flags.shadowAllowlist.length === 0 || flags.shadowAllowlist.includes(camId);
  const fusionAllow = Array.isArray(flags.fusionAllowlist) && flags.fusionAllowlist.includes(camId);

  const eligibleForShadow = hasRoi && validForDir && fresh && noError && shadowAllow;
  const eligibleForFusion = hasRoi && validForDir && hasCountLine && fresh && latencyOk && confOk && noError && calOk && fusionAllow;
  return { eligibleForShadow, eligibleForFusion, hasRoi, hasCountLine, validForDir, fusionAllowlisted: fusionAllow, reasonCodes };
}

// ───────────────────────────────────────────────────────────────────────────
// 4. CAMERA — QUEUE BANDS, IMAGE HASH, STALE & MOTION
// ───────────────────────────────────────────────────────────────────────────
//
// A camera must be able to say "nema kolone / mala / srednja / velika / ekstremna"
// even when it cannot count vehicles exactly. The band is driven by lane fullness
// and occupancy (area evidence) — robust to bumper-to-bumper undercounting — and
// degrades gracefully (caps at "srednja") when the frame is stale or low-confidence.
export const QUEUE_BANDS = Object.freeze(['nema', 'mala', 'srednja', 'velika', 'ekstremna']);

export function classifyQueueBand({ occupancyPct = 0, laneFullnessPct = 0, queueVehicles = 0, visibleVehicles = null, confidence = 60, stale = false } = {}) {
  const fullness = Math.max(Number(occupancyPct) || 0, Number(laneFullnessPct) || 0);
  const q = Number(queueVehicles) || 0;
  let band;
  if (fullness < 14 && q <= 1) band = 'nema';
  else if (fullness < 30 && q <= 5) band = 'mala';
  else if (fullness < 50 && q <= 12) band = 'srednja';
  else if (fullness < 70 && q <= 22) band = 'velika';
  else band = 'ekstremna';

  // VEHICLE-EVIDENCE CAP. The band must reflect how many vehicles are actually SEEN, not pixel
  // fullness (wet asphalt / shadows read 70–100 % lane on an open road) nor the ×3 area-inflated
  // queue estimate (which is only for the wait, and turns 3 visible cars into "9 in queue" →
  // "ekstremna"). Prefer the real detection count (visibleVehicles); fall back to queueVehicles
  // when it is not supplied. You cannot have a "velika/ekstremna kolona" with a handful of cars.
  const hasVisible = visibleVehicles !== null && visibleVehicles !== undefined && Number.isFinite(Number(visibleVehicles));
  const evidence = hasVisible ? Number(visibleVehicles) : q;
  let cap = 'ekstremna';
  if (evidence <= 2) cap = 'mala';
  else if (evidence <= 5) cap = 'srednja';
  else if (evidence <= 10) cap = 'velika';
  // DETECTION-DISAGREEMENT GUARD. A near-zero vehicle count only proves the lane is "clear" when the
  // lane ALSO reads empty. If measured OCCUPANCY is high (≥40%) but we detected ~no vehicles, the
  // detector probably FAILED (distant/low-light HAK frame, YOLO returned nothing) — that is NOT proof
  // of an empty lane, so we must not cap down to a confident "mala". Treat it as a POSSIBLE queue
  // (srednja) so a visibly busy lane can never collapse to "do 5 min". Note this keys on real
  // occupancyPct, NOT laneFullnessPct, so wet-asphalt/shadow pixel noise (low occupancy, high
  // fullness) still stays "mala" — preserving the earlier false-positive fix.
  const occ = Number(occupancyPct) || 0;
  if (cap === 'mala' && occ >= 40 && !stale) cap = 'srednja';
  if (QUEUE_BANDS.indexOf(band) > QUEUE_BANDS.indexOf(cap)) band = cap;

  // An unreliable frame must not scream "ekstremna". Cap the claim.
  if ((stale || confidence < 45) && QUEUE_BANDS.indexOf(band) > 2) band = 'srednja';

  const labels = {
    nema: 'Nema kolone',
    mala: 'Mala kolona',
    srednja: 'Srednja kolona',
    velika: 'Velika kolona',
    ekstremna: 'Ekstremna kolona',
  };
  return { band, label: labels[band], fullnessPct: round(fullness) };
}

// Rank of a queue band (higher = more congested). -1 for unknown.
export function queueBandRank(band) {
  return QUEUE_BANDS.indexOf(band);
}

// VISUAL CONGESTION CONFLICT (the Maljevac/Brod core fix). A camera can VISUALLY show a big
// queue (band velika/ekstremna) even when it is not wait-capable (no ROI) and therefore does
// not drive the wait. If the displayed wait is nonetheless low, that is a CONFLICT: the camera
// frame is fresher than a lagging official text source, so we must NOT present a confident low
// number — we flag it, drop confidence, and show a range / "provjeri službene izvore".
export function detectVisualCongestionConflict({ visualBand = null, fusedWait = null, lowThreshold = 30 } = {}) {
  const rank = queueBandRank(visualBand);
  // Any visible queue (srednja+) on a low number is a conflict — the camera frame is fresher than a
  // lagging text source, so we must not show a confident low number. srednja widens to a smaller max.
  const strong = rank >= queueBandRank('srednja');
  if (!strong || !isNum(fusedWait)) return { conflict: false, visualBand, suggestedRangeMax: null };
  if (Number(fusedWait) >= lowThreshold) return { conflict: false, visualBand, suggestedRangeMax: null };
  const suggestedRangeMax = visualBand === 'ekstremna' ? 120 : visualBand === 'velika' ? 60 : 45;
  return { conflict: true, visualBand, suggestedRangeMax };
}

// INVERSE conflict (the Šamac case): the camera VISUALLY shows little/no queue (nema/mala)
// but the fused wait is very high. The high number is suspect (stale/misparsed source, or a
// queue the camera angle can't see) — we flag it, drop confidence and warn, without
// fabricating a different number. Admin/measured stay authoritative for the value itself.
export function detectCameraClearConflict({ visualBand = null, fusedWait = null, highThreshold = 90 } = {}) {
  const rank = queueBandRank(visualBand);
  const clear = rank >= 0 && rank <= queueBandRank('mala'); // nema or mala (band must be known)
  if (!clear || !isNum(fusedWait)) return { conflict: false, visualBand };
  if (Number(fusedWait) < highThreshold) return { conflict: false, visualBand };
  return { conflict: true, visualBand };
}

// CAMERA-CLEAR LOW OVERRIDE. The user-requested "kamera prazna → reci da je prazno" behaviour:
// when a fresh, direction-relevant camera frame plainly shows an empty/near-empty crossing
// (band nema/mala) but the wait number comes only from WEAK signals (Google / a soft public
// estimate / historical / driver reports), trust the camera and lower the wait to what the frame
// supports. Honours the source priority — `hardAuthorityPresent` (a HARD official number, a
// measured session, or an admin value) BLOCKS the override, because those outrank the camera.
// Pure + deterministic so it can be unit-tested away from the live store.
export function resolveCameraClearOverride({
  visualBand = null,
  cameraClear = false,
  cameraStale = false,
  cameraWait = null,
  currentWait = null,
  hardAuthorityPresent = false,
} = {}) {
  const frameClear = Boolean(cameraClear) && !cameraStale && (visualBand === 'nema' || visualBand === 'mala');
  if (!frameClear || hardAuthorityPresent) return { override: false, wait: currentWait };
  if (!isNum(cameraWait) || !isNum(currentWait)) return { override: false, wait: currentWait };
  if (Number(cameraWait) >= Number(currentWait)) return { override: false, wait: currentWait };
  return { override: true, wait: Number(cameraWait) };
}

// CAMERA-CONGESTION HIGH OVERRIDE (symmetric to the clear-low one). The app must COMMIT to a
// number rather than tell people to "check official sources": when a fresh, direction-relevant
// camera VISUALLY shows a real queue (band velika/ekstremna) but the current number is low, raise
// the estimate to a camera-led value — the camera's own wait if it has one, otherwise a band floor.
// A road VISIBLY full of cars at a border is a LONG wait (this is the differentiator vs services
// that only echo a lagging official figure), so the floors are realistic: velika ≥ 30, ekstremna
// ≥ 50 min. Google approach-congestion (googleHeavyNearBorder) reinforces it. Honours source
// priority: a HARD official number or measured session (hardAuthorityPresent) keeps its value. Only
// RAISES, never lowers.
export function resolveCameraCongestionOverride({
  visualBand = null,
  cameraWait = null,
  currentWait = null,
  hardAuthorityPresent = false,
  googleHeavyNearBorder = false,
} = {}) {
  // A visible queue of ANY real size (srednja/velika/ekstremna) must stop a confident-low estimate.
  // srednja is a smaller floor (a medium queue is at least ~20 min at a border) so we never show
  // "do 20 min" on a visibly queued lane; velika/ekstremna commit higher.
  const rank = queueBandRank(visualBand);
  const strong = rank >= queueBandRank('srednja');
  if (!strong || hardAuthorityPresent || !isNum(currentWait)) return { override: false, wait: currentWait, band: visualBand };
  let floor = visualBand === 'ekstremna' ? 50 : visualBand === 'velika' ? 30 : 22;
  if (googleHeavyNearBorder) floor += visualBand === 'ekstremna' ? 15 : visualBand === 'velika' ? 10 : 6; // camera + Google agree → stronger
  const committed = Math.max(isNum(cameraWait) ? Number(cameraWait) : 0, floor);
  if (committed <= Number(currentWait)) return { override: false, wait: currentWait, band: visualBand };
  return { override: true, wait: committed, band: visualBand };
}

// Pick the worst (most congested) band from a list.
export function worstQueueBand(bands = []) {
  let worst = null;
  let worstRank = -1;
  for (const b of bands) {
    const r = queueBandRank(b);
    if (r > worstRank) { worstRank = r; worst = b; }
  }
  return worst;
}

// Average-hash (aHash): downscale luma to 8x8, threshold by the mean. Returns a
// 16-char hex string (64 bits). `sampleGray(x,y)` returns 0-255 for normalised
// coordinates 0..(w-1)/0..(h-1) — passed in so this stays decode-agnostic.
export function computeAverageHash(sampleGray, width, height, size = 8) {
  if (typeof sampleGray !== 'function' || !width || !height) return null;
  const vals = [];
  for (let gy = 0; gy < size; gy += 1) {
    for (let gx = 0; gx < size; gx += 1) {
      const px = Math.min(width - 1, Math.floor(((gx + 0.5) / size) * width));
      const py = Math.min(height - 1, Math.floor(((gy + 0.5) / size) * height));
      vals.push(clamp(sampleGray(px, py), 0, 255));
    }
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  let bits = '';
  for (const v of vals) bits += v >= mean ? '1' : '0';
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hammingDistanceHex(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dist = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { dist += x & 1; x >>= 1; }
  }
  return dist;
}

// Stale = the camera is serving the same frame repeatedly (frozen feed / cached
// placeholder). We treat ≥3 consecutive near-identical frames as stale. `hashes`
// is newest-first. Also returns a motion score (0-1) from the latest transition.
export function detectStaleFrames(hashes = [], { minRepeats = 3, threshold = 2 } = {}) {
  const valid = hashes.filter(Boolean);
  if (valid.length < 2) return { stale: false, repeats: valid.length ? 1 : 0, motion: null };
  let repeats = 1;
  for (let i = 1; i < valid.length; i += 1) {
    const d = hammingDistanceHex(valid[0], valid[i]);
    if (d !== null && d <= threshold) repeats += 1; else break;
  }
  const latestDist = hammingDistanceHex(valid[0], valid[1]);
  const motion = latestDist === null ? null : clamp(latestDist / 32, 0, 1);
  return { stale: repeats >= minRepeats, repeats, motion };
}

// Build the full structured per-camera analysis object the spec asks for.
export function buildCameraAnalysis(raw = {}) {
  const occupancyPct = round(raw.occupancyPct ?? 0);
  const laneFullnessPct = round(raw.laneFullnessPct ?? raw.occupancyPct ?? 0);
  const queueVehicles = round(raw.queueVehicles ?? 0);
  const stale = Boolean(raw.stale);
  const confidence = round(clamp(raw.confidence ?? 55, 0, 100));
  const bandInfo = classifyQueueBand({ occupancyPct, laneFullnessPct, queueVehicles, visibleVehicles: raw.visibleVehicles ?? raw.visibleTotal, confidence, stale });
  // A camera that is stale or low-confidence must NOT emit an aggressive minute
  // estimate — it can still report a qualitative band. visualOnly never emits wait.
  const reliable = !stale && confidence >= 45 && !raw.visualOnly;
  return {
    visibleVehicles: round(raw.visibleVehicles ?? raw.visibleTotal ?? 0),
    queueVehicles,
    occupancyPct,
    laneFullnessPct,
    flowVehicles15: round(raw.flowVehicles15 ?? 0),
    trend: raw.trend || raw.queueTrend || 'unknown',
    confidence,
    stale,
    snapshotAgeSec: raw.snapshotAgeSec === null || raw.snapshotAgeSec === undefined ? null : round(raw.snapshotAgeSec),
    method: raw.method || 'snapshot-flow',
    queueBand: bandInfo.band,
    queueBandLabel: bandInfo.label,
    motion: raw.motion === null || raw.motion === undefined ? null : Math.round(Number(raw.motion) * 100) / 100,
    visualOnly: Boolean(raw.visualOnly),
    // The wait this camera is allowed to contribute to hard fusion (null = none).
    contributesWait: reliable ? round(raw.wait ?? 0) : null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 5. CAMERA DIRECTION SAFETY
// ───────────────────────────────────────────────────────────────────────────
//
// A camera frame physically shows ONE side of the border. Feeding the same frame
// into both directions (the previous behaviour) contaminates the opposite
// direction. Each camera declares `validForDirections` and optionally `visualOnly`.
// Returns 'hard' (drives wait), 'visual' (display only), or 'none'.
export function cameraContributionMode(camera = {}, direction = 'toBih') {
  const valid = Array.isArray(camera.validForDirections) ? camera.validForDirections : null;
  if (camera.visualOnly === true) return 'visual';
  // If a camera does not declare its direction we CANNOT prove which side it shows,
  // so it is visual-only and must not enter the hard wait calculation (spec §2).
  if (!valid || !valid.length) return 'visual';
  if (!valid.includes(direction)) return 'none';
  return 'hard';
}

// ───────────────────────────────────────────────────────────────────────────
// 6. TRUST ENGINE (driver reports & measured sessions)
// ───────────────────────────────────────────────────────────────────────────
//
// Each report gets a trust score in [0,1]. Measured GPS-verified sessions are the
// gold standard; anonymous manual reports start low and decay with age.
export function computeReportTrust(report = {}, ctx = {}) {
  let trust = report.measured ? 0.7 : 0.4;
  const factors = [];
  if (report.measured) { trust += 0.15; factors.push('izmjereno'); }
  if (report.gpsVerified) { trust += 0.12; factors.push('GPS potvrđeno'); }
  if (report.userId && !report.anonymous) { trust += 0.05; factors.push('prijavljeni korisnik'); }
  const history = Number(ctx.userReportCount || 0);
  if (history >= 10) { trust += 0.08; factors.push('iskusan korisnik'); }
  else if (history >= 3) trust += 0.04;

  // Agreement with the rest of the picture (other reports / fused wait).
  if (Number.isFinite(ctx.referenceWait) && Number.isFinite(report.wait)) {
    const diff = Math.abs(Number(report.wait) - Number(ctx.referenceWait));
    if (diff <= 8) { trust += 0.08; factors.push('slaže se s ostalim izvorima'); }
    else if (diff >= 40) { trust -= 0.18; factors.push('odstupa od ostalih izvora'); }
  }

  // Age decay: a 90-min-old report is much weaker than a fresh one.
  const age = Number(report.ageMinutes ?? 0);
  const ageMult = age <= 15 ? 1 : age <= 30 ? 0.85 : age <= 60 ? 0.6 : age <= 120 ? 0.35 : 0.15;
  trust *= ageMult;
  factors.push(`starost ${round(age)} min`);
  return { trust: Math.round(clamp(trust, 0, 1) * 100) / 100, factors };
}

// ───────────────────────────────────────────────────────────────────────────
// 7. ANTI-FAKE: dedupe + anomaly detection
// ───────────────────────────────────────────────────────────────────────────
//
// One person must not be able to swing the wait by spamming. Collapse near-duplicate
// reports from the same user, and flag outliers far from the cohort consensus.
export function dedupeReports(reports = [], { windowMinutes = 20, waitDelta = 10 } = {}) {
  const kept = [];
  const seen = [];
  for (const r of [...reports].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))) {
    const dup = seen.find((s) => s.userKey === (r.userId || r.deviceId || 'anon')
      && s.crossingId === r.crossingId && s.direction === r.direction
      && Math.abs(new Date(s.createdAt) - new Date(r.createdAt)) <= windowMinutes * 60000
      && Math.abs(Number(s.wait) - Number(r.wait)) <= waitDelta);
    if (dup) continue;
    seen.push({ userKey: r.userId || r.deviceId || 'anon', crossingId: r.crossingId, direction: r.direction, createdAt: r.createdAt, wait: r.wait });
    kept.push(r);
  }
  return kept;
}

export function detectReportAnomalies(reports = [], referenceWait = null) {
  if (reports.length < 2) return { anomalies: [], median: reports[0]?.wait ?? null };
  const waits = reports.map((r) => Number(r.wait)).filter(Number.isFinite);
  const med = median(waits);
  const ref = Number.isFinite(referenceWait) ? referenceWait : med;
  const anomalies = reports.filter((r) => Number.isFinite(Number(r.wait)) && Math.abs(Number(r.wait) - ref) >= Math.max(35, ref * 0.8));
  return { anomalies, median: med };
}

// ───────────────────────────────────────────────────────────────────────────
// 8. ACCURACY STATS (the KPI itself)
// ───────────────────────────────────────────────────────────────────────────
//
// `records` = [{ crossingId, direction, predictedWait, actualWait, confidenceLevel }]
// Returns overall + per-crossing MAE / median error / p90 error / bias.
export function computeAccuracyStats(records = []) {
  const matched = records.filter((r) => isNum(r.predictedWait) && isNum(r.actualWait));
  const CATASTROPHIC_MIN = 30; // |predicted - actual| > 30 min = a trust-destroying miss
  const groupStats = (rows) => {
    if (!rows.length) return null;
    const errs = rows.map((r) => Math.abs(Number(r.predictedWait) - Number(r.actualWait)));
    const signed = rows.map((r) => Number(r.predictedWait) - Number(r.actualWait));
    const catastrophic = errs.filter((e) => e > CATASTROPHIC_MIN).length;
    return {
      n: rows.length,
      mae: Math.round((errs.reduce((a, b) => a + b, 0) / errs.length) * 10) / 10,
      medianError: median(errs),
      p90Error: percentile(errs, 0.9),
      // negative bias = app UNDER-estimates (worse for trust: "10 min" then 70 min queue).
      bias: Math.round((signed.reduce((a, b) => a + b, 0) / signed.length) * 10) / 10,
      worstErrorMin: Math.max(...errs),
      catastrophicMisses: catastrophic,
      catastrophicRate: Math.round((catastrophic / rows.length) * 100) / 100,
    };
  };

  const byCrossing = {};
  const byDirection = {};
  for (const r of matched) {
    const key = `${r.crossingId}:${r.direction}`;
    (byCrossing[key] = byCrossing[key] || []).push(r);
    (byDirection[r.direction] = byDirection[r.direction] || []).push(r);
  }
  const perCrossing = Object.fromEntries(Object.entries(byCrossing).map(([k, rows]) => [k, groupStats(rows)]));
  const perDirection = Object.fromEntries(Object.entries(byDirection).map(([k, rows]) => [k, groupStats(rows)]));
  return { overall: groupStats(matched), perCrossing, perDirection, sampleSize: matched.length };
}

// ───────────────────────────────────────────────────────────────────────────
// 9. ALERTS
// ───────────────────────────────────────────────────────────────────────────
//
// Produce push-ready alert events from a wait transition. Delivery (FCM/APNs/
// web-push) is a separate transport; this decides WHAT to send and dedupes by rule.
export function evaluateWaitAlerts(prev, next, opts = {}) {
  const events = [];
  const { crossingId, crossingName = crossingId, direction = 'toBih' } = opts;
  const p = isNum(prev) ? Number(prev) : null;
  const n = isNum(next) ? Number(next) : null;
  if (n === null) return events;
  const dropBelow = opts.dropBelow ?? 30;
  const riseAbove = opts.riseAbove ?? 60;
  const suddenDelta = opts.suddenDelta ?? 25;

  if (p !== null) {
    if (p >= dropBelow && n < dropBelow) events.push({ type: 'drop-below', crossingId, crossingName, direction, prev: p, next: n, title: `${crossingName}: čekanje palo ispod ${dropBelow} min`, body: `Sada ~${n} min.` });
    if (p <= riseAbove && n > riseAbove) events.push({ type: 'rise-above', crossingId, crossingName, direction, prev: p, next: n, title: `${crossingName}: čekanje preraslo ${riseAbove} min`, body: `Sada ~${n} min.` });
    if (Math.abs(n - p) >= suddenDelta) events.push({ type: 'sudden-change', crossingId, crossingName, direction, prev: p, next: n, title: `${crossingName}: nagla promjena čekanja`, body: `${p} → ${n} min.` });
  }
  return events;
}

// ───────────────────────────────────────────────────────────────────────────
// 10. BEST CROSSING ENGINE
// ───────────────────────────────────────────────────────────────────────────
//
// `crossings` = [{ id, name, wait, extraDriveMinutes, displayReady }]. Ranks by
// total cost (wait + extra drive) and produces the savings sentence the spec wants.
export function rankBestCrossings(crossings = [], opts = {}) {
  const usable = crossings
    .filter((c) => c.displayReady !== false && Number.isFinite(Number(c.wait)))
    .map((c) => ({ ...c, extraDriveMinutes: Number(c.extraDriveMinutes || 0), totalMinutes: Number(c.wait) + Number(c.extraDriveMinutes || 0) }))
    .sort((a, b) => a.totalMinutes - b.totalMinutes);
  if (!usable.length) return { best: null, ranked: [], recommendation: null };

  const best = usable[0];
  const referenceId = opts.referenceId;
  const reference = referenceId ? usable.find((c) => c.id === referenceId) : usable[usable.length - 1];
  let recommendation = null;
  if (reference && reference.id !== best.id) {
    const saving = Math.round(reference.totalMinutes - best.totalMinutes);
    if (saving >= 10) {
      recommendation = {
        bestId: best.id,
        bestName: best.name,
        comparedToId: reference.id,
        comparedToName: reference.name,
        savingMinutes: saving,
        message: `Ušteda ${saving} min ako ideš preko ${best.name}.`,
      };
    }
  }
  return { best, ranked: usable, recommendation };
}

// ───────────────────────────────────────────────────────────────────────────
// 11. MEASURED WAIT + GEOFENCE (spec V5 §1)
// ───────────────────────────────────────────────────────────────────────────

// Haversine great-circle distance in metres.
export function haversineMeters(a, b) {
  if (!a || !b || !Number.isFinite(Number(a.lat)) || !Number.isFinite(Number(b.lat))) return null;
  const R = 6371000;
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad((b.lng ?? b.lon) - (a.lng ?? a.lon));
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

// Which geofence zone a GPS point falls in for a given crossing/direction geofence.
// Returns 'approach' | 'border' | 'exit' | 'far'.
export function locateInGeofence(point, geofence) {
  if (!point || !geofence) return 'far';
  const dB = haversineMeters(point, geofence.border);
  if (dB !== null && dB <= (geofence.borderRadiusM ?? 350)) return 'border';
  const dA = haversineMeters(point, geofence.approach);
  if (dA !== null && dA <= (geofence.approachRadiusM ?? 1200)) return 'approach';
  const dE = haversineMeters(point, geofence.exit);
  if (dE !== null && dE <= (geofence.exitRadiusM ?? 500)) return 'exit';
  return 'far';
}

// Compute the real wait from a session: time from joining the queue to crossing.
// When a geofence is supplied we VERIFY the GPS track (anti-gaming): the start must be
// near the approach, the end near/past the border, and the device must have actually
// moved. A suspicious track (no movement for a long "wait", or coordinates nowhere near
// the crossing) is flagged so the trust engine can discount it.
export function computeMeasuredWait(session = {}, geofence = null) {
  const start = new Date(session.startedAt).getTime();
  const end = new Date(session.finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const minutes = Math.round((end - start) / 60000);
  if (minutes < 0 || minutes > 600) return null;

  const startGps = session.startGps;
  const endGps = session.endGps;
  const hasGps = startGps && endGps && Number.isFinite(Number(startGps.lat)) && Number.isFinite(Number(endGps.lat));
  let gpsVerified = false;
  let gpsSuspicious = false;
  if (hasGps) {
    const moved = haversineMeters(startGps, endGps);
    if (geofence) {
      const startZone = locateInGeofence(startGps, geofence);
      const endZone = locateInGeofence(endGps, geofence);
      const startNearApproach = startZone === 'approach' || startZone === 'border';
      const endPastBooth = endZone === 'border' || endZone === 'exit';
      gpsVerified = startNearApproach && endPastBooth && moved !== null && moved >= 60;
      // Implausible: claims a real wait but never moved, OR both points far from the crossing.
      const startFar = locateInGeofence(startGps, geofence) === 'far';
      const endFar = locateInGeofence(endGps, geofence) === 'far';
      gpsSuspicious = (minutes >= 5 && moved !== null && moved < 40) || (startFar && endFar);
    } else {
      // No geofence reference: accept only a sane amount of movement as weakly verified.
      gpsVerified = moved !== null && moved >= 50 && moved <= 8000;
      gpsSuspicious = minutes >= 5 && moved !== null && moved < 40;
    }
  }
  return {
    wait: minutes,
    gpsVerified,
    gpsSuspicious,
    durationMinutes: minutes,
    anonymous: !session.userId,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 12. BIAS CORRECTION (spec V5 §2 foundation)
// ───────────────────────────────────────────────────────────────────────────
//
// From resolved accuracy records, learn a per-(crossing×direction×hour) signed-error
// correction. Uses HIERARCHICAL SHRINKAGE: a fine bucket with few samples falls back
// toward coarser buckets (part-of-day → crossing → global), and the correction is only
// trusted once a minimum sample size is met. This avoids overfitting to 2-3 measurements
// — the central risk when measured waits become the calibration anchor.
//
// `records` = [{ crossingId, direction, predictedWait, actualWait, predictedAt }]
export function computeBiasCorrection(records = [], { minSample = 5 } = {}) {
  const usable = records.filter((r) => Number.isFinite(Number(r.predictedWait)) && Number.isFinite(Number(r.actualWait)));
  const partOfDay = (h) => (h < 6 ? 'night' : h < 11 ? 'morning' : h < 17 ? 'midday' : h < 22 ? 'evening' : 'night');
  const buckets = new Map(); // key → signed errors (actual - predicted)
  const add = (key, err) => { (buckets.get(key) || buckets.set(key, []).get(key)).push(err); };
  for (const r of usable) {
    const err = Number(r.actualWait) - Number(r.predictedWait);
    const hour = new Date(r.predictedAt || Date.now()).getHours();
    const pod = partOfDay(hour);
    add('global', err);
    add(`c:${r.crossingId}:${r.direction}`, err);
    add(`p:${r.crossingId}:${r.direction}:${pod}`, err);
    add(`h:${r.crossingId}:${r.direction}:${hour}`, err);
  }
  const med = (key) => { const v = buckets.get(key); return v && v.length ? { value: median(v), n: v.length } : null; };
  const globalBias = med('global');

  // Resolve the correction for a fine bucket by walking coarse→fine and trusting the
  // finest bucket that has enough samples.
  const correctionFor = (crossingId, direction, hour) => {
    const pod = partOfDay(hour);
    const chain = [`h:${crossingId}:${direction}:${hour}`, `p:${crossingId}:${direction}:${pod}`, `c:${crossingId}:${direction}`, 'global'];
    for (const key of chain) {
      const m = med(key);
      if (m && m.n >= minSample) return { correctionMin: Math.round(m.value), basis: key, n: m.n };
    }
    return { correctionMin: 0, basis: 'insufficient', n: usable.length };
  };

  const perCrossing = {};
  for (const r of usable) {
    const key = `${r.crossingId}:${r.direction}`;
    if (!perCrossing[key]) {
      const m = med(`c:${r.crossingId}:${r.direction}`);
      perCrossing[key] = m && m.n >= minSample ? { correctionMin: Math.round(m.value), n: m.n } : { correctionMin: 0, n: m?.n || 0, insufficient: true };
    }
  }
  return {
    sampleSize: usable.length,
    globalBias: globalBias ? { correctionMin: Math.round(globalBias.value), n: globalBias.n } : null,
    perCrossing,
    correctionFor,
  };
}
