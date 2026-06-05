// Pure UI-decision helpers for camera cards (V5 §8). Extracted from App.jsx so the honesty
// rules can be unit-tested: the UI must NEVER present a camera minute estimate unless the
// camera is genuinely wait-capable, reliable, fresh and not contradicting the official signal.
import { hasKnownWait } from './wait-format.js';

// Decide whether the camera card may show a minute estimate ("procjena iz kamere") or must
// fall back to a visual-only label. `headlineWait` is the fused/official wait shown elsewhere.
export function cameraEstimateDecision(analytics = {}, headlineWait = null) {
  const reliable = analytics.cameraEstimateReliable === true && analytics.waitIsCameraDriven === true;
  const contradictsOfficial = reliable
    && hasKnownWait(headlineWait)
    && hasKnownWait(analytics.wait)
    && Math.abs(Number(analytics.wait) - Number(headlineWait)) > 20;
  return {
    reliable,
    contradictsOfficial,
    // Only a usable camera estimate may be rendered as a minute number with "Prema kameri".
    usable: reliable && !contradictsOfficial,
  };
}

// Freshness label from an age in seconds. Anything older than the TTL is "stara procjena".
export function freshnessLabelFromAge(ageSeconds, { staleAfterSeconds = 15 * 60 } = {}) {
  if (ageSeconds === null || ageSeconds === undefined || !Number.isFinite(Number(ageSeconds))) {
    return { label: 'čeka osvježenje', stale: false };
  }
  const sec = Math.max(0, Number(ageSeconds));
  const stale = sec > staleAfterSeconds;
  if (sec < 60) return { label: 'upravo ažurirano', stale };
  if (sec < 3600) return { label: `ažurirano prije ${Math.round(sec / 60)} min`, stale };
  return { label: `stara procjena (${Math.round(sec / 3600)} h)`, stale: true };
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function cautiousBandLabel(rawLabel = '') {
  const label = String(rawLabel || 'Vizualna provjera').trim();
  if (!label || /^vizualna/i.test(label)) return 'Vizualna provjera';
  if (/^djeluje kao/i.test(label)) return label;
  return `Vizualno djeluje kao ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

// Camera queue labels must not fake certainty. "Mala/Srednja/Velika kolona" is only confident
// when we have an actual camera-driven estimate, or an ROI-calibrated YOLO signal. Heuristic/no-ROI
// states are deliberately phrased as visual assistance, not a precise AI queue verdict.
export function buildCameraQueueLabel(analytics = {}, { estimateUsable = false } = {}) {
  const raw = analytics.queueBandLabel || analytics.finalVisualBand || 'Vizualna provjera';
  const cvUsed = analytics.cvUsed === true || analytics.yoloUsed === true;
  const roiFeatures = analytics.roiFeaturesPrimary || analytics.roiFeatures || analytics.yoloCamera || null;
  const roiCalibrated = Boolean(roiFeatures?.roiCalibrated || analytics.roiCalibrated);
  const queueVehicles = Number(roiFeatures?.vehiclesInQueueRoi ?? analytics.queueVehicles ?? NaN);
  const noDetections = normalizeText(analytics.cvFallbackReason).includes('no-detections') || queueVehicles === 0;

  if (estimateUsable) {
    if (roiCalibrated && Number.isFinite(queueVehicles)) return `${queueVehicles} vozila u koloni`;
    return raw;
  }
  if (cvUsed && roiCalibrated && Number.isFinite(queueVehicles)) {
    if (queueVehicles <= 1 || noDetections) return 'AI kamera ne vidi kolonu';
    return `AI kamera vidi ${queueVehicles} vozila u koloni`;
  }
  if (cvUsed && !roiCalibrated) return 'AI signal niže pouzdanosti';
  return cautiousBandLabel(raw);
}

// Map a raw detector fallback reason to clean, user-safe Croatian copy. NEVER leak the raw token
// (e.g. "no-detections", "timeout", "http-502") to the user. `no-detections` is a NORMAL empty-lane
// result, not an outage.
export function cameraStatusCopy(reason = '') {
  const r = String(reason || '').toLowerCase();
  if (!r) return 'AI detekcija trenutno nije dostupna.';
  if (r.includes('no-endpoint') || r.includes('disabled') || r.includes('not-configured')) return 'AI detekcija nije konfigurirana.';
  if (r.includes('no-detection') || r.includes('empty')) return 'AI nije pronašao vozila u ovom kadru.';
  // timeout / http-xxx / error / invalid-json / no-image → generic "temporarily unavailable"
  return 'AI detekcija trenutno nije dostupna.';
}

export function buildCameraTrustText(analytics = {}, { estimateUsable = false, contradictsOfficial = false } = {}) {
  const cvUsed = analytics.cvUsed === true || analytics.yoloUsed === true;
  const roiFeatures = analytics.roiFeaturesPrimary || analytics.roiFeatures || analytics.yoloCamera || null;
  const roiCalibrated = Boolean(roiFeatures?.roiCalibrated || analytics.roiCalibrated);
  const fallback = analytics.cvFallbackReason || roiFeatures?.fallbackReason || null;

  if (estimateUsable && cvUsed && roiCalibrated) return 'Procjena koristi AI detekciju vozila unutar kalibrirane zone kolone.';
  if (estimateUsable) return analytics.message || 'Procjena iz kamere koristi svježi signal, ali i dalje je uspoređujemo s javnim izvorima.';
  if (contradictsOfficial) return 'Kamera se ne slaže dovoljno sa službenim izvorom, zato ju prikazujemo samo kao vizualnu provjeru.';
  if (cvUsed && !roiCalibrated) return 'AI vidi vozila, ali kamera nije potpuno kalibrirana.';
  if (!cvUsed && fallback) return `Kamera trenutno služi kao vizualna provjera. ${cameraStatusCopy(fallback)}`;
  return 'Kamera trenutno služi kao vizualna provjera — čekanje ne izvodimo iz same slike.';
}
