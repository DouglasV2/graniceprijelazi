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

function roundToStep(value, step = 5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n / step) * step);
}

function displayStepForWait(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 5;
  if (n >= 90) return 15;
  if (n >= 30) return 5;
  return 5;
}

function normalizedConfidence(sourceMeta = {}) {
  const label = String(sourceMeta.confidenceLabel || sourceMeta.confidenceLevel || sourceMeta.confidenceHint || '').toLowerCase();
  if (label.includes('visok') || label === 'high') return 'high';
  if (label.includes('sred') || label === 'medium' || label === 'low-medium') return 'medium';
  if (label.includes('nisk') || label === 'low') return 'low';
  if (sourceMeta.hasSoftUpperBoundPublic) return 'low';
  return 'high';
}

function rangeGuardFor(confidence) {
  if (confidence === 'high') return 10;
  if (confidence === 'medium') return 15;
  return 20;
}

function displayBand(min, max) {
  const lo = Math.max(0, Math.round(Number(min)));
  const hi = Math.max(lo, Math.round(Number(max)));
  if (hi < 60) return `${lo}–${hi} min`;
  return `${formatMinutes(lo)}–${formatMinutes(hi)}`;
}

// Production display shaping layer. The raw fusion model may keep a wide uncertainty range for
// backtesting/debug, but the public UI must be actionable. This function turns raw ranges into a
// compact label and never leaks unhelpful bands like "32 min–1 h 10 min" to drivers.
export function shapeWaitDisplay(wait, sourceMeta = {}) {
  if (!hasKnownWait(wait)) {
    return {
      primaryLabel: 'čeka izvor',
      displayRangeLabel: null,
      confidence: normalizedConfidence(sourceMeta),
      broadRangeCollapsed: false,
      reason: 'unknown-wait',
    };
  }
  const n = Number(wait);
  const confidence = normalizedConfidence(sourceMeta);
  const isSoftBound = sourceMeta.hasSoftUpperBoundPublic === true;
  const kind = sourceMeta.conflictKind;
  const hasRange = hasKnownWait(sourceMeta.rangeMin) && hasKnownWait(sourceMeta.rangeMax);
  const approx = (value = n) => `oko ${formatMinutes(roundToStep(value, displayStepForWait(value)))}`;

  // Conflict copy is intentionally conservative: a low official number + camera/Google jam is a
  // floor, not a fake precise number.
  if (kind === 'clear-high') return { primaryLabel: `~${formatMinutes(n)}`, displayRangeLabel: null, confidence, broadRangeCollapsed: false, reason: 'clear-high-conflict' };
  // A visible queue (camera) / jam (Google / official-low conflict) is a FLOOR — "od X min", never a
  // confident low/precise number. Camera-congestion is the "road visibly full → at least X" case.
  if (kind === 'congestion' || kind === 'google-jam' || kind === 'camera-congestion') return { primaryLabel: `od ${formatMinutes(n)}`, displayRangeLabel: null, confidence, broadRangeCollapsed: false, reason: 'congestion-floor' };

  // Small-value consistency rule: every surface (sidebar, marker, overlay, history, alerts) must
  // agree on tiny waits. "0 min" is shown ONLY as a deliberate, high-confidence "no waiting" —
  // any other near-zero estimate reads "do 5 min" so two surfaces can't disagree (0 vs do 5).
  if (!hasRange && n >= 0 && n <= 5) {
    if (n === 0 && confidence === 'high') return { primaryLabel: '0 min', displayRangeLabel: null, confidence, broadRangeCollapsed: false, reason: 'no-wait' };
    return { primaryLabel: 'do 5 min', displayRangeLabel: null, confidence, broadRangeCollapsed: false, reason: 'small-value-upper-bound' };
  }

  if (hasRange) {
    const rawMin = Math.max(0, Number(sourceMeta.rangeMin));
    const rawMax = Math.max(rawMin, Number(sourceMeta.rangeMax));
    const width = rawMax - rawMin;
    const guard = rangeGuardFor(confidence);
    const step = displayStepForWait((rawMin + rawMax) / 2);
    const roundedMin = roundToStep(rawMin, step);
    const roundedMax = Math.max(roundedMin, roundToStep(rawMax, step));
    const roundedWidth = roundedMax - roundedMin;
    const lowFloor = rawMin <= 8;

    if (rawMin === 0 || (lowFloor && (isSoftBound || confidence === 'low') && width >= 10)) {
      return {
        primaryLabel: `do ${formatMinutes(roundedMax)}`,
        displayRangeLabel: null,
        confidence,
        broadRangeCollapsed: true,
        reason: 'low-floor-upper-bound',
      };
    }

    // Medium/low ranges wider than ~12 minutes are technically honest but not useful as the
    // headline (e.g. 15–29, 32–70). Collapse to an approximate, rounded estimate and let the
    // explanation/confidence text carry the uncertainty.
    if (width > guard || (confidence !== 'high' && width >= 12)) {
      return {
        primaryLabel: approx(n || ((rawMin + rawMax) / 2)),
        displayRangeLabel: `${displayBand(roundedMin, roundedMax)} · manje sigurno`,
        confidence,
        broadRangeCollapsed: true,
        reason: width > guard ? 'range-over-guardrail' : 'medium-wide-range',
      };
    }

    if (roundedWidth >= 5) {
      return {
        primaryLabel: displayBand(roundedMin, roundedMax),
        displayRangeLabel: displayBand(roundedMin, roundedMax),
        confidence,
        broadRangeCollapsed: false,
        reason: 'range-ok',
      };
    }
  }

  if (isSoftBound || confidence === 'low') return { primaryLabel: `~${formatMinutes(n)}`, displayRangeLabel: null, confidence, broadRangeCollapsed: false, reason: 'low-approx' };
  if (confidence === 'medium') return { primaryLabel: approx(n), displayRangeLabel: null, confidence, broadRangeCollapsed: false, reason: 'medium-approx' };
  return { primaryLabel: formatMinutes(n), displayRangeLabel: null, confidence, broadRangeCollapsed: false, reason: 'exact-high' };
}

// User-facing wait label. Goes through the production shaping layer so raw broad model ranges do
// not appear in the app as if they were actionable precision.
export function formatWaitDisplay(wait, sourceMeta = {}) {
  return shapeWaitDisplay(wait, sourceMeta).primaryLabel;
}
