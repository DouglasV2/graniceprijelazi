// Traffic + Vision prediction layer (v2). The app's differentiator: instead of re-printing
// HAK/BIHAMK/AMS numbers, it COMPUTES its own border-wait estimate from (1) Google traffic on the
// border-approach SEGMENT, (2) YOLO/ROI camera vehicle counts → a queue→wait model, fused with
// (3) chat/verified-location ground truth, using public sources only as a fallback signal.
//
// This module is PURE (no network, no store, no globals) so every piece is unit-testable. The
// server wires it behind PREDICTION_V2_ENABLED with a try/catch fallback to the legacy fusion, so
// a failure here never takes down the estimate.
export const TRAFFIC_VISION_MODEL_VERSION = 'traffic-vision-v2';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const isNum = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const round = (n) => Math.round(Number(n));
const round1 = (n) => Math.round(Number(n) * 10) / 10;

function haversineMeters(a, b) {
  if (!a || !b) return 0;
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function nearestIndex(point, path) {
  if (!point || !Array.isArray(path) || !path.length) return -1;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < path.length; i += 1) {
    const d = haversineMeters(point, path[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function pathMeters(path, from, to) {
  let s = 0;
  for (let i = from; i < to; i += 1) s += haversineMeters(path[i], path[i + 1]);
  return s;
}

// ── §1/§2 GOOGLE TRAFFIC v2 ──────────────────────────────────────────────────────────────────
// Per-crossing service rate (vehicles cleared per minute) for the queue→wait model. Tunable.
export const SERVICE_RATE_CONFIG = {
  default: { vehiclesPerMinute: 1.5, lanes: 1 },
  // Busier motorway crossings clear faster (more booths/lanes).
  'gornji-varos': { vehiclesPerMinute: 2.2, lanes: 2 },
  bijaca: { vehiclesPerMinute: 2.0, lanes: 2 },
  svilaj: { vehiclesPerMinute: 2.0, lanes: 2 },
  maljevac: { vehiclesPerMinute: 1.4, lanes: 1 },
};

// Time-of-day + weekend modifiers on the service rate (peak = slower clearance).
function serviceRateModifier(date = new Date()) {
  const hour = date.getHours();
  const day = date.getDay(); // 0 Sun .. 6 Sat
  let mod = 1;
  if (hour >= 14 && hour <= 19) mod *= 0.85;        // afternoon peak — slower
  else if (hour >= 0 && hour <= 5) mod *= 1.15;     // night — faster
  if (day === 0 || day === 6) mod *= 0.9;           // weekend — slower
  return mod;
}

export function serviceRateFor(crossingId, direction, { date = new Date(), truckRatio = 0 } = {}) {
  const base = SERVICE_RATE_CONFIG[crossingId] || SERVICE_RATE_CONFIG.default;
  let rate = Number(base.vehiclesPerMinute) || SERVICE_RATE_CONFIG.default.vehiclesPerMinute;
  rate *= serviceRateModifier(date);
  // Heavy trucks/buses slow a booth down substantially.
  rate *= clamp(1 - 0.45 * clamp(truckRatio, 0, 1), 0.45, 1);
  return Math.max(0.3, round1(rate));
}

// Border-specific Google delay from the (already border-sliced) route segment: the wait signal is
// `current travel time on the approach segment − baseline/free-flow time`, NOT the whole city route.
export function computeGoogleTrafficV2(route = {}, anchor = {}) {
  const out = {
    currentTravelTimeMin: null,
    baselineTravelTimeMin: null,
    delayMin: null,
    delayRatio: null,
    routeDistanceKm: null,
    distanceBeforeBorderKm: null,
    distanceAfterBorderKm: null,
    routeCrossesBorder: false,
    worstTrafficLevel: route?.trafficSummary?.worstTrafficLevel || 'UNKNOWN',
    jamMeters: route?.trafficSummary?.jamMeters ?? 0,
    confidence: 0,
    trafficModelUsed: 'segment-delay-v2',
    fallbackReason: null,
  };
  if (!route || !Array.isArray(route.path) || route.path.length < 2) {
    out.fallbackReason = 'no-route-path';
    return out;
  }
  const current = Number(route.durationMinutes);
  const baseline = Number(route.staticMinutes ?? route.durationMinutes);
  if (!isNum(current) || !isNum(baseline)) {
    out.fallbackReason = 'no-duration';
    return out;
  }
  out.currentTravelTimeMin = round1(current);
  out.baselineTravelTimeMin = round1(baseline);
  out.delayMin = round1(Math.max(0, current - baseline));
  out.delayRatio = baseline > 0 ? round1(current / baseline) : null;
  out.routeDistanceKm = isNum(route.distanceKm) ? round1(route.distanceKm) : round1((route.distanceMeters || 0) / 1000);

  // Where does the border sit on the sliced path? Distance before/after tells us the segment really
  // straddles the crossing (a route that never crosses = unreliable for a border wait).
  const border = anchor.borderPoint || route.borderPoint;
  if (border) {
    const bi = nearestIndex(border, route.path);
    if (bi > 0 && bi < route.path.length - 1) {
      out.distanceBeforeBorderKm = round1(pathMeters(route.path, 0, bi) / 1000);
      out.distanceAfterBorderKm = round1(pathMeters(route.path, bi, route.path.length - 1) / 1000);
      out.routeCrossesBorder = out.distanceBeforeBorderKm >= 0.1 && out.distanceAfterBorderKm >= 0.1;
    } else {
      out.fallbackReason = 'border-at-segment-edge';
    }
  } else {
    out.fallbackReason = 'no-border-anchor';
  }

  // Confidence: high when the segment straddles the border with sane geometry + a real signal.
  let conf = 0.4;
  if (out.routeCrossesBorder) conf += 0.35;
  if (out.routeDistanceKm >= 0.5 && out.routeDistanceKm <= 12) conf += 0.15;
  if (out.worstTrafficLevel === 'TRAFFIC_JAM' || out.worstTrafficLevel === 'SLOW') conf += 0.1;
  if (route.routeGuard && route.routeGuard.ok === false) conf -= 0.25;
  if (out.fallbackReason) conf = Math.min(conf, 0.4);
  out.confidence = round1(clamp(conf, 0, 0.95));
  return out;
}

// §2 Multi-sampling: aggregate several border-segment variants (different approach/exit distances)
// into one robust Google signal. An outlier route (didn't cross, or wildly long) can't dominate.
export function aggregateGoogleSamples(samples = []) {
  const list = (Array.isArray(samples) ? samples : []).filter(Boolean);
  if (!list.length) return { delayMin: null, delayRatio: null, confidence: 0, routeCrossesBorder: false, sampleCount: 0, chosen: null, fallbackReason: 'no-samples' };
  // Prefer samples that cross the border with sane geometry; fall back to all if none cross.
  const crossing = list.filter((s) => s.routeCrossesBorder && !s.fallbackReason);
  const usable = crossing.length ? crossing : list;
  const delays = usable.map((s) => Number(s.delayMin)).filter(isNum).sort((a, b) => a - b);
  if (!delays.length) return { delayMin: null, delayRatio: null, confidence: 0.2, routeCrossesBorder: crossing.length > 0, sampleCount: list.length, chosen: usable[0] || null, fallbackReason: 'no-delay' };
  const median = delays[Math.floor((delays.length - 1) / 2)];
  // chosen = the usable sample whose delay is closest to the median (most representative).
  const chosen = usable.reduce((best, s) => (Math.abs(Number(s.delayMin) - median) < Math.abs(Number(best.delayMin) - median) ? s : best), usable[0]);
  const confidence = round1(clamp((crossing.length ? 0.6 : 0.3) + Math.min(0.3, (usable.length - 1) * 0.12) + (chosen.confidence || 0) * 0.2, 0, 0.95));
  return {
    delayMin: round1(median),
    delayRatio: chosen.delayRatio ?? null,
    maxReliableDelayMin: round1(Math.max(...delays)),
    routeCrossesBorder: crossing.length > 0,
    worstTrafficLevel: chosen.worstTrafficLevel,
    jamMeters: chosen.jamMeters ?? 0,
    confidence,
    sampleCount: list.length,
    crossingCount: crossing.length,
    chosen,
    fallbackReason: crossing.length ? null : 'no-sample-crossed-border',
  };
}

// ── §3/§4 YOLO ROI → queue → wait ────────────────────────────────────────────────────────────
// Numeric camera estimate from YOLO features, not just a band. Honest confidence: lower without a
// calibrated ROI, at night, or with few/low-confidence detections.
export function estimateCameraWaitV2(yolo = {}, { crossingId, direction, serviceRate, date = new Date() } = {}) {
  const out = {
    estimatedQueueVehicles: null,
    estimatedServiceRateVehiclesPerMinute: null,
    estimatedCameraWaitMin: null,
    cameraWaitRangeMin: null,
    cameraWaitRangeMax: null,
    cameraConfidence: 0,
    roiCalibrated: Boolean(yolo.roiCalibrated),
    fallbackReason: null,
  };
  const queue = isNum(yolo.vehiclesInQueueRoi) ? Number(yolo.vehiclesInQueueRoi)
    : isNum(yolo.queueVehicles) ? Number(yolo.queueVehicles)
    : isNum(yolo.visibleVehicleCount) ? Number(yolo.visibleVehicleCount)
    : null;
  if (queue === null) { out.fallbackReason = 'no-queue-count'; return out; }
  out.estimatedQueueVehicles = round(queue);

  const counts = yolo.vehicleCountByClass || {};
  const heavy = (Number(counts.trucks || 0) + Number(counts.buses || 0));
  const total = Math.max(1, Number(yolo.visibleVehicleCount || queue || 1));
  const truckRatio = clamp(heavy / total, 0, 1);
  const rate = isNum(serviceRate) ? Number(serviceRate) : serviceRateFor(crossingId, direction, { date, truckRatio });
  out.estimatedServiceRateVehiclesPerMinute = round1(rate);

  // queue / serviceRate, plus a small fixed booth handling time.
  const wait = queue <= 0 ? 0 : queue / rate + (queue <= 2 ? 1 : 2);
  out.estimatedCameraWaitMin = clamp(round(wait), 0, 240);

  // Confidence: calibrated ROI + good detection + daylight → high; else lower.
  let conf = 0.35;
  if (out.roiCalibrated) conf += 0.3;
  if (Number(yolo.averageDetectionConfidence || 0) >= 55) conf += 0.15;
  if (yolo.isNightOrLowLight) conf -= 0.2;
  if (Number(yolo.cameraImageQualityScore ?? 100) < 40) conf -= 0.15;
  if (queue <= 1) conf = Math.min(conf, 0.5); // a single car carries little certainty either way
  out.cameraConfidence = round1(clamp(conf, 0.05, 0.95));

  const spread = Math.max(2, Math.round(out.estimatedCameraWaitMin * (out.roiCalibrated ? 0.25 : 0.45)));
  out.cameraWaitRangeMin = Math.max(0, out.estimatedCameraWaitMin - spread);
  out.cameraWaitRangeMax = Math.min(240, out.estimatedCameraWaitMin + spread);
  return out;
}

// ── §6 GOOGLE + YOLO + ground-truth FUSION ─────────────────────────────────────────────────────
function googleDelayToWait(google) {
  // The approach-segment delay is mostly the queue's extra time; the booth wait is ≈ that delay
  // plus a short service time. A jam ratio nudges it up. Conservative (Google sees the approach,
  // the booth queue can be a bit longer).
  if (!google || !isNum(google.delayMin)) return null;
  const base = Number(google.delayMin);
  const jamBonus = google.worstTrafficLevel === 'TRAFFIC_JAM' ? 4 : google.worstTrafficLevel === 'SLOW' ? 2 : 0;
  return clamp(round(base + jamBonus + (base > 0 ? 2 : 0)), 0, 240);
}

// Combine the signals into one committed estimate + honest confidence + a plain-language reason +
// a full source breakdown. Implements the scenario matrix in the spec (§6).
export function fuseTrafficVision({ google = null, camera = null, publicSig = null, chat = null, verified = null, baselineWaitMin = 10 } = {}) {
  const breakdown = { googleTraffic: google || null, yoloCamera: camera || null, publicSource: publicSig || null, chatReports: chat || null, verifiedLocation: verified || null };
  const result = (expectedWaitMin, rangeMin, rangeMax, confidenceScore, label, explanation, lead) => ({
    expectedWaitMin: clamp(round(expectedWaitMin), 0, 360),
    rangeMin: clamp(round(rangeMin), 0, 360),
    rangeMax: clamp(round(rangeMax), 0, 360),
    confidenceScore: clamp(round(confidenceScore), 1, 99),
    confidenceLabel: label,
    modelVersion: TRAFFIC_VISION_MODEL_VERSION,
    explanation,
    lead,
    sourceBreakdown: breakdown,
  });

  // 1) Verified location = ground truth (§9). Fresh measured pass overrides everything.
  if (verified && isNum(verified.waitMin) && Number(verified.ageMin ?? 999) <= 30) {
    const w = Number(verified.waitMin);
    return result(w, Math.max(0, w - 3), w + 4, 92, 'high', 'Mjereno na terenu (provjerena lokacija) — najpouzdaniji izvor.', 'verified');
  }

  const cameraWait = camera && isNum(camera.estimatedCameraWaitMin) ? Number(camera.estimatedCameraWaitMin) : null;
  const cameraConf = camera ? Number(camera.cameraConfidence || 0) : 0;
  const googleWait = googleDelayToWait(google);
  const googleConf = google ? Number(google.confidence || 0) : 0;
  const googleUsable = googleWait !== null && google && google.routeCrossesBorder && googleConf >= 0.45;
  const cameraUsable = cameraWait !== null && cameraConf >= 0.4;
  const LOW = 12;

  // 2) Strong chat consensus (§9): several recent reports (esp. with location) can lead, but a
  // single chat report never dominates.
  const chatLead = chat && isNum(chat.waitMin) && Number(chat.count || 0) >= 2 && Number(chat.ageMin ?? 999) <= 30;

  // 3) Camera + Google fusion (the differentiator).
  if (cameraUsable && googleUsable) {
    const agreeLow = cameraWait < LOW && googleWait < LOW;
    const agreeHigh = cameraWait >= LOW && googleWait >= LOW;
    const blended = (cameraWait * cameraConf + googleWait * googleConf) / Math.max(0.1, cameraConf + googleConf);
    if (agreeLow) {
      return result(Math.min(cameraWait, googleWait + 2), 0, Math.max(cameraWait, googleWait) + 4, 88, 'high',
        `AI kamera vidi ${camera.estimatedQueueVehicles} vozila i Google promet je gotovo bez zastoja — slažu se da je prohodno.`, 'camera+google');
    }
    if (agreeHigh) {
      return result(blended, Math.min(cameraWait, googleWait) - 3, Math.max(cameraWait, googleWait) + 5, 86, 'high',
        `AI kamera vidi ${camera.estimatedQueueVehicles} vozila u koloni, Google promet pokazuje +${google.delayMin} min — izvori se slažu.`, 'camera+google');
    }
    // disagree → medium confidence, wider range, conflict explanation (§6.3/§6.4)
    const lo = Math.min(cameraWait, googleWait);
    const hi = Math.max(cameraWait, googleWait);
    return result(blended, Math.max(0, lo - 2), hi + 6, 58, 'medium',
      cameraWait > googleWait
        ? `AI kamera vidi gužvu (${camera.estimatedQueueVehicles} vozila), ali Google promet je slabiji — procjena je manje sigurna.`
        : `Google promet pokazuje usporenje (+${google.delayMin} min), ali kamera vidi malo vozila — procjena je manje sigurna.`,
      'camera+google-conflict');
  }

  // 4) Only camera usable.
  if (cameraUsable) {
    const conf = clamp(round(40 + cameraConf * 45), 20, 80);
    return result(cameraWait, camera.cameraWaitRangeMin ?? Math.max(0, cameraWait - 4), camera.cameraWaitRangeMax ?? cameraWait + 6, conf, conf >= 65 ? 'medium' : 'low',
      `AI kamera vidi ${camera.estimatedQueueVehicles} vozila u koloni.`, 'camera');
  }
  // 5) Only Google usable.
  if (googleUsable) {
    const conf = clamp(round(35 + googleConf * 45), 20, 78);
    return result(googleWait, Math.max(0, googleWait - 3), googleWait + 6, conf, conf >= 65 ? 'medium' : 'low',
      `Google promet na prilazu granici pokazuje +${google.delayMin} min usporenja.`, 'google');
  }

  // 6) Chat consensus (no usable camera/google).
  if (chatLead) {
    return result(chat.waitMin, Math.max(0, chat.waitMin - 5), Number(chat.waitMin) + 8, 55, 'medium',
      `${chat.count} svježih dojava vozača u zadnjih ${Math.round(chat.ageMin)} min.`, 'chat');
  }

  // 7) Public source = FALLBACK only — it must not alone hold an extreme wait when camera+google
  // don't corroborate it. Cap a high soft-public value when nothing supports it.
  if (publicSig && isNum(publicSig.waitMin)) {
    const pw = Number(publicSig.waitMin);
    const unsupportedHigh = pw > 25 && !cameraUsable && !googleUsable;
    const capped = unsupportedHigh ? Math.min(pw, publicSig.soft ? 18 : 25) : pw;
    const conf = publicSig.soft ? 32 : 45;
    return result(capped, Math.max(0, capped - 6), capped + (unsupportedHigh ? 12 : 8), conf, 'low',
      unsupportedHigh
        ? `Samo službena ${publicSig.soft ? 'okvirna ' : ''}procjena (${pw} min); kamera/Google je ne potvrđuju, pa je prikaz oprezniji.`
        : `Procjena se temelji na službenom izvoru (${pw} min).`,
      'public');
  }

  // 8) Nothing usable.
  return result(baselineWaitMin, Math.max(0, baselineWaitMin - 5), baselineWaitMin + 8, 15, 'low',
    'Nema dovoljno pouzdanih signala (kamera/Google/dojave) — prikazujemo okvirnu procjenu.', 'baseline');
}
