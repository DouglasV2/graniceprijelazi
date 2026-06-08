// Resolve the wait minutes a driver actually reported, with a clear precedence:
//   1) an EXPLICIT choice (quick-time button / numeric input) — always wins;
//   2) otherwise, a best-effort parse of the free-text message ("čekao sam 30 min", "pola sata");
//   3) otherwise, the report category's default minutes (legacy fallback — never breaks the old flow).
// Pure + isolated so the precedence and the Croatian parser can be unit-tested directly.

const WORD_NUM = {
  nula: 0, jedan: 1, jedna: 1, jednu: 1, dva: 2, dvije: 2, tri: 3, cetiri: 4, pet: 5,
  sest: 6, sedam: 7, osam: 8, devet: 9, deset: 10, jedanaest: 11, dvanaest: 12, trinaest: 13,
  cetrnaest: 14, petnaest: 15, sesnaest: 16, sedamnaest: 17, osamnaest: 18, devetnaest: 19,
  dvadeset: 20, trideset: 30, cetrdeset: 40, pedeset: 50, sezdeset: 60, sedamdeset: 70,
  osamdeset: 80, devedeset: 90, sto: 100,
};

// Lowercase + strip Croatian diacritics so "čekao"/"cekao" and "šezdeset"/"sezdeset" both match.
function norm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[čć]/g, 'c')
    .replace(/š/g, 's')
    .replace(/ž/g, 'z')
    .replace(/đ/g, 'd')
    .trim();
}

// Sum word-number tokens, skipping leading non-number words ("sam trideset" → 30,
// "dvadeset pet" → 25, "trideset i pet" → 35). Returns NaN if no number token is found.
function parseWordNumber(str) {
  const parts = norm(str).split(/\s+/).filter((p) => p && p !== 'i');
  let total = 0;
  let started = false;
  for (const p of parts) {
    if (WORD_NUM[p] !== undefined) { total += WORD_NUM[p]; started = true; }
    else if (started) break;
  }
  return started ? total : NaN;
}

// Clamp to a valid reportable range. Returns an integer in [0,360], or null when the value is not a
// usable number (empty / NaN / negative) so the caller can fall through to the next source.
export function clampWaitMinutes(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(360, Math.round(n));
}

// Best-effort parse of minutes from a free-text Croatian message. Returns a number or null.
export function parseWaitMinutesFromText(text) {
  const s = norm(text);
  if (!s) return null;

  // "sat i pol" / "sat i po" = 90 (check before the generic "sat" rules).
  if (/\bsat\s+i\s+(pol|po)\b/.test(s)) return 90;
  // "pol(a) sata / ure / h" = 30.
  if (/\bpol(a)?\s+(sat\w*|ure|h)\b/.test(s)) return 30;

  // Digit hours (+ optional minutes): "1h 20", "1 h 20 min", "2 sata 30 min", "1h".
  const hm = s.match(/(\d+)\s*(?:h\b|sat\w*)\s*(?:i\s+)?(\d{1,2})?\s*(?:min\w*)?/);
  if (hm && /h|sat/.test(hm[0])) {
    const h = Number(hm[1]);
    const mins = hm[2] ? Number(hm[2]) : 0;
    if (Number.isFinite(h)) return clampWaitMinutes(h * 60 + mins);
  }

  // Word hours: "jedan sat" → 60, "dva sata" → 120, "sat vremena" / lone "sat" → 60.
  const wh = s.match(/\b([a-z]+)\s+(sat\w*)\b/);
  if (wh) {
    const w = WORD_NUM[wh[1]];
    return clampWaitMinutes(Number.isFinite(w) ? w * 60 : 60);
  }
  if (/\bsat\w*\b/.test(s)) return 60;

  // Digit minutes: "30 min", "30 minuta", "čekao sam 30 min".
  const dm = s.match(/(\d+)\s*min\w*/);
  if (dm) return clampWaitMinutes(Number(dm[1]));

  // Word minutes: "trideset minuta", "čekao sam trideset minuta", "dvadeset pet minuta".
  const wmm = s.match(/\b([a-z]+(?:\s+[a-z]+)?)\s+min\w*/);
  if (wmm) {
    const w = parseWordNumber(wmm[1]);
    if (Number.isFinite(w)) return clampWaitMinutes(w);
  }

  return null;
}

// The single entry point the composer uses. explicit > parsed message > category default.
export function resolveReportWaitMinutes({ explicit, message, categoryDefault } = {}) {
  const e = clampWaitMinutes(explicit);
  if (e !== null) return e;

  const parsed = parseWaitMinutesFromText(message);
  const p = clampWaitMinutes(parsed);
  if (p !== null) return p;

  const def = clampWaitMinutes(categoryDefault);
  return def !== null ? def : 0;
}

// Quick-time options for the composer (upper-bound minutes — conservative, never under-reports).
export const WAIT_QUICK_OPTIONS = [
  { label: '0–15', min: 15 },
  { label: '15–30', min: 30 },
  { label: '30–45', min: 45 },
  { label: '45–60', min: 60 },
  { label: '60+', min: 90 },
];
