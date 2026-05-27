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
  const hint = sourceMeta.confidenceHint || '';
  const isSoftBound = sourceMeta.hasSoftUpperBoundPublic === true;
  const isLowConf = hint === 'low' || hint === 'low-medium';
  if ((isSoftBound || isLowConf) && hasKnownWait(sourceMeta.rangeMin) && hasKnownWait(sourceMeta.rangeMax)) {
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
