// Pure helpers for displaying border-wait values in the UI.
// Extracted from App.jsx so unit tests can validate them in isolation.

export function formatMinutes(minutes) {
  if (minutes === null || minutes === undefined || minutes === '') return '—';
  const n = Number(minutes);
  if (!Number.isFinite(n)) return '—';
  if (n < 0) return `-${formatMinutes(Math.abs(n))}`;
  if (n < 60) return `${Math.round(n)} min`;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function hasKnownWait(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

export function isUsableMinuteValue(value) {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

export function normalizeMinutes(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

// User-facing wait label. Never returns "0–15 min"; collapses zero-low ranges to "do X min".
// For mid-range bands renders the compact form "30–45 min" rather than the
// duplicated "30 min–45 min".
export function formatWaitDisplay(wait, sourceMeta = {}) {
  if (!hasKnownWait(wait)) return 'čeka izvor';
  const n = Number(wait);
  // Camera-vs-wait wording. We always COMMIT to a number (no "provjeri"): 'clear-high' keeps the
  // official figure as "~X" (camera sees less), while 'congestion'/'google-jam' keep the
  // authoritative low figure as a floor "od X min" (camera/Google see more). 'camera-congestion'
  // is a camera-LED committed estimate, so it falls through to the range form ("30–60 min").
  if (sourceMeta.conflictKind === 'clear-high') return `~${formatMinutes(n)}`;
  if (sourceMeta.conflictKind === 'congestion' || sourceMeta.conflictKind === 'google-jam') return `od ${formatMinutes(n)}`;
  const hint = sourceMeta.confidenceHint || '';
  // The confidence engine's level/precision is the source of truth for honesty: we only
  // show a single exact number at HIGH confidence. Anything below shows a range (when one
  // is available) or a "~" approximation, so we never present false precision (spec §8, §13).
  const level = sourceMeta.confidenceLevel || '';
  const precision = sourceMeta.precision || '';
  const isSoftBound = sourceMeta.hasSoftUpperBoundPublic === true;
  const isLowConf = hint === 'low' || hint === 'low-medium' || level === 'niska';
  const isMediumConf = hint === 'medium' || level === 'srednja';
  const wantRange = isSoftBound || isLowConf || isMediumConf || precision === 'range';
  if (wantRange && hasKnownWait(sourceMeta.rangeMin) && hasKnownWait(sourceMeta.rangeMax)) {
    const rMin = Math.max(0, Number(sourceMeta.rangeMin));
    const rMax = Number(sourceMeta.rangeMax);
    if (rMax - rMin >= 5) {
      if (rMin === 0) return `do ${formatMinutes(rMax)}`;
      if (rMax < 60) return `${Math.round(rMin)}–${Math.round(rMax)} min`;
      return `${formatMinutes(rMin)}–${formatMinutes(rMax)}`;
    }
  }
  if (isSoftBound || isLowConf) return `~${formatMinutes(n)}`;
  return formatMinutes(n);
}
