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
