import { describe, it, expect } from 'vitest';
import {
  formatMinutes,
  hasKnownWait,
  isUsableMinuteValue,
  normalizeMinutes,
  formatWaitDisplay,
} from '../../src/utils/wait-format.js';

describe('hasKnownWait', () => {
  it('rejects null / undefined / empty string / NaN', () => {
    expect(hasKnownWait(null)).toBe(false);
    expect(hasKnownWait(undefined)).toBe(false);
    expect(hasKnownWait('')).toBe(false);
    expect(hasKnownWait(NaN)).toBe(false);
    expect(hasKnownWait('abc')).toBe(false);
  });

  it('accepts finite numbers including 0', () => {
    expect(hasKnownWait(0)).toBe(true);
    expect(hasKnownWait(12)).toBe(true);
    expect(hasKnownWait('15')).toBe(true);
  });
});

describe('isUsableMinuteValue / normalizeMinutes', () => {
  it('rejects negative numbers', () => {
    expect(isUsableMinuteValue(-1)).toBe(false);
    expect(normalizeMinutes(-3)).toBeNull();
  });
  it('rejects NaN / null / undefined', () => {
    expect(isUsableMinuteValue(NaN)).toBe(false);
    expect(isUsableMinuteValue(null)).toBe(false);
    expect(normalizeMinutes(undefined)).toBeNull();
  });
  it('rounds positive finite values', () => {
    expect(normalizeMinutes(12.4)).toBe(12);
    expect(normalizeMinutes(12.6)).toBe(13);
  });
});

describe('formatMinutes', () => {
  it('renders short waits in minutes', () => {
    expect(formatMinutes(7)).toBe('7 min');
  });
  it('renders long waits in hours and minutes', () => {
    expect(formatMinutes(90)).toBe('1 h 30 min');
    expect(formatMinutes(120)).toBe('2 h');
  });
  it('handles unknown / unparseable values with em-dash, never "NaN" / "undefined"', () => {
    expect(formatMinutes(null)).toBe('—');
    expect(formatMinutes(undefined)).toBe('—');
    expect(formatMinutes('')).toBe('—');
    expect(formatMinutes(NaN)).toBe('—');
    expect(formatMinutes('abc')).toBe('—');
  });
});

describe('formatWaitDisplay', () => {
  it('never returns "0–15 min" — zero-low ranges collapse to "do X min"', () => {
    const out = formatWaitDisplay(7, {
      hasSoftUpperBoundPublic: true,
      rangeMin: 0,
      rangeMax: 15,
    });
    expect(out).not.toMatch(/0\s*[–-]\s*15/);
    expect(out).toMatch(/^do\s+/);
    expect(out).toBe('do 15 min');
  });

  it('renders mid-range bands like "30–45 min" verbatim', () => {
    const out = formatWaitDisplay(38, {
      hasSoftUpperBoundPublic: true,
      rangeMin: 30,
      rangeMax: 45,
    });
    expect(out).toBe('30–45 min');
  });

  it('returns a human fallback (not "null"/"NaN") when wait is unknown', () => {
    expect(formatWaitDisplay(null)).toBe('čeka izvor');
    expect(formatWaitDisplay(undefined)).toBe('čeka izvor');
    expect(formatWaitDisplay(NaN)).toBe('čeka izvor');
    expect(formatWaitDisplay('')).toBe('čeka izvor');
  });

  it('does not show "-" prefix waits as a normal estimate', () => {
    // Negative values should not be produced upstream, but if one slips
    // through we surface it visibly rather than render a polished label.
    const out = formatWaitDisplay(-5);
    expect(out).toBe('-5 min'); // explicit sign; not silently absorbed
  });

  it('marks low-confidence estimates with "~" prefix', () => {
    const out = formatWaitDisplay(18, { confidenceHint: 'low' });
    expect(out).toBe('~18 min');
  });

  it('returns plain "X min" for confident wait without soft bound', () => {
    expect(formatWaitDisplay(22, { confidenceHint: 'high' })).toBe('22 min');
  });

  it('shows a range at HIGH-engine confidence only when no range, else exact', () => {
    // confidenceLevel "visoka" with no range → exact number (no false precision needed).
    expect(formatWaitDisplay(40, { confidenceLevel: 'visoka' })).toBe('40 min');
  });

  it('medium confidence (srednja) surfaces a range instead of a single number', () => {
    expect(formatWaitDisplay(45, { confidenceLevel: 'srednja', rangeMin: 35, rangeMax: 55 })).toBe('35–55 min');
  });

  it('low confidence (niska) with a range shows the band', () => {
    expect(formatWaitDisplay(50, { confidenceLevel: 'niska', precision: 'range', rangeMin: 40, rangeMax: 58 })).toBe('40–58 min');
  });

  it('visual congestion conflict shows a floor ("od X min"), never a confident low number', () => {
    // Maljevac case: camera visibly shows a big queue but the computed wait is low.
    expect(formatWaitDisplay(11, { visualCongestionConflict: true })).toBe('od 11 min');
    expect(formatWaitDisplay(11, { conflictKind: 'congestion' })).toBe('od 11 min');
  });

  it('clear-high conflict shows an approximate ("~X"), never a confident high number', () => {
    // Šamac case: wait is high but the camera shows little/no queue → suspect, verify.
    expect(formatWaitDisplay(360, { conflictKind: 'clear-high' })).toBe('~6 h');
  });

  it('google-jam conflict shows a floor ("od X"), low wait but Google jam on the approach', () => {
    expect(formatWaitDisplay(8, { conflictKind: 'google-jam' })).toBe('od 8 min');
  });

  it('never returns the literal strings "null", "undefined", or "NaN"', () => {
    for (const candidate of [null, undefined, NaN, '', 'foo', 0, 15, 30, 45, 80]) {
      const out = formatWaitDisplay(candidate);
      expect(out).not.toMatch(/\bnull\b/);
      expect(out).not.toMatch(/\bundefined\b/);
      expect(out).not.toMatch(/\bNaN\b/);
    }
  });
});
