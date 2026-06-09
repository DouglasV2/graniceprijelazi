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


// Camera queue labels must not fake certainty. "Mala/Srednja/Velika kolona" is only confident
// when we have an actual camera-driven estimate, or an ROI-calibrated YOLO signal. Heuristic/no-ROI
// states are deliberately phrased as visual assistance, not a precise AI queue verdict.
export function buildCameraQueueLabel(analytics = {}, { estimateUsable = false } = {}) {
  const raw = analytics.queueBandLabel || analytics.finalVisualBand || 'Provjera na slici';
  const cvUsed = analytics.cvUsed === true || analytics.yoloUsed === true;
  const roiFeatures = analytics.roiFeaturesPrimary || analytics.roiFeatures || analytics.yoloCamera || null;
  const roiCalibrated = Boolean(roiFeatures?.roiCalibrated || analytics.roiCalibrated);
  // TRUSTED ROI = a real reviewed polygon. A seeded/rect-derived ROI (roiTrusted false) may count 0
  // in a mis-mapped zone, so we must NOT turn that into a confident "AI kamera ne vidi kolonu".
  const roiTrusted = Boolean(roiFeatures?.roiTrusted);
  const queueVehicles = Number(roiFeatures?.vehiclesInQueueRoi ?? analytics.queueVehicles ?? NaN);
  const noDetections = normalizeText(analytics.cvFallbackReason).includes('no-detections') || queueVehicles === 0;
  // Does the VISUAL band show a real queue (srednja/velika/ekstremna)? This is occupancy-based and
  // independent of YOLO, so it stays valid even when AI detection is weak/untrusted.
  const visualQueue = /srednja|velika|ekstremna/i.test(`${raw} ${analytics.visualBand || ''}`);

  if (estimateUsable) {
    if (roiCalibrated && roiTrusted && Number.isFinite(queueVehicles)) return `${queueVehicles} vozila u koloni`;
    return raw;
  }
  // Only a reviewed, reliable camera zone may state a precise count or "no queue".
  if (cvUsed && roiCalibrated && roiTrusted && Number.isFinite(queueVehicles)) {
    if (queueVehicles <= 1 || noDetections) return 'Kamera ne vidi kolonu';
    return `Kamera broji ${queueVehicles} vozila u koloni`;
  }
  // Count not reliable yet. If the lane VISUALLY shows a real queue (srednja+), say so honestly.
  if (visualQueue) return 'Kamera pokazuje moguću kolonu';
  // An untrusted/uncalibrated ROI must NEVER claim "no queue" (its 0 may be a mis-mapped zone) — it
  // points to the live image regardless of the count.
  if (cvUsed && roiCalibrated && !roiTrusted) return 'Provjeri kolonu na slici uživo';
  if (cvUsed && !roiCalibrated) return 'Kamera još ne broji točno — provjeri na slici';
  // Heuristic-only / no usable camera signal: with zero detections we must NOT claim "djeluje kao
  // mala kolona" (that contradicts "kamera ne vidi vozila"). A clear frame reads "ne vidi kolonu";
  // anything else just points to the live image — never a fabricated band.
  if (noDetections) return 'Kamera trenutno ne vidi kolonu';
  return 'Provjeri sliku uživo';
}

// Map a raw detector fallback reason to clean, user-safe Croatian copy. NEVER leak the raw token
// (e.g. "no-detections", "timeout", "http-502") to the user. `no-detections` is a NORMAL empty-lane
// result, not an outage.
export function cameraStatusCopy(reason = '') {
  const r = String(reason || '').toLowerCase();
  if (!r) return 'Provjera s kamere trenutno nije dostupna.';
  if (r.includes('no-endpoint') || r.includes('disabled') || r.includes('not-configured')) return 'Provjera s kamere nije uključena.';
  if (r.includes('no-detection') || r.includes('empty')) return 'Kamera trenutno ne vidi vozila na slici.';
  // timeout / http-xxx / error / invalid-json / no-image → generic "temporarily unavailable"
  return 'Provjera s kamere trenutno nije dostupna.';
}

export function buildCameraTrustText(analytics = {}, { estimateUsable = false, contradictsOfficial = false } = {}) {
  const cvUsed = analytics.cvUsed === true || analytics.yoloUsed === true;
  const roiFeatures = analytics.roiFeaturesPrimary || analytics.roiFeatures || analytics.yoloCamera || null;
  const roiCalibrated = Boolean(roiFeatures?.roiCalibrated || analytics.roiCalibrated);
  const roiTrusted = Boolean(roiFeatures?.roiTrusted);
  const fallback = analytics.cvFallbackReason || roiFeatures?.fallbackReason || null;

  if (estimateUsable && cvUsed && roiCalibrated && roiTrusted) return 'Procjenu računamo iz broja vozila koja kamera vidi u koloni.';
  if (estimateUsable) return analytics.message || 'Procjena s kamere je svježa; svejedno je uspoređujemo s javnim izvorima.';
  if (contradictsOfficial) return 'Kamera se ne slaže dovoljno sa službenim izvorom, pa je koristimo samo za provjeru na slici.';
  const visualQueue = /srednja|velika|ekstremna/i.test(`${analytics.queueBandLabel || ''} ${analytics.visualBand || ''}`);
  // Visible queue but count not reliable → say the camera shows a possible queue, count isn't reliable yet.
  if (visualQueue && !roiTrusted) return 'Kamera pokazuje moguću kolonu, ali broj vozila još nije pouzdan — procjenu ne radimo samo iz slike.';
  // Calibrated but not yet reviewed (seeded/rect-derived) → don't claim a reliable verdict.
  if (cvUsed && roiCalibrated && !roiTrusted) return 'Kamera još ne broji točan broj vozila — pokazuje promet, ali čekanje ne računamo samo iz slike.';
  if (cvUsed && !roiCalibrated) return 'Kamera vidi vozila, ali još ne broji posve točno.';
  if (!cvUsed && fallback) return `Kamera je za provjeru na slici. ${cameraStatusCopy(fallback)}`;
  return 'Kamera je za provjeru na slici — čekanje ne računamo iz same slike.';
}
