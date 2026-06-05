import { describe, it, expect } from 'vitest';
import {
  formatMinutes,
  hasKnownWait,
  isUsableMinuteValue,
  normalizeMinutes,
  formatWaitDisplay,
  shapeWaitDisplay,
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

  it('shapes mid-range soft bands into an actionable approximate headline', () => {
    const out = formatWaitDisplay(38, {
      hasSoftUpperBoundPublic: true,
      rangeMin: 30,
      rangeMax: 45,
    });
    expect(out).toBe('oko 40 min');
  });

  it('collapses a wide low-floor soft range ("7–21") to an actionable upper bound ("do 21 min")', () => {
    // The driver-confusing case: a wide range starting near zero reads as "maybe nothing, maybe a lot".
    expect(formatWaitDisplay(14, { hasSoftUpperBoundPublic: true, rangeMin: 7, rangeMax: 21 })).toBe('do 20 min');
    expect(formatWaitDisplay(14, { confidenceLevel: 'niska', precision: 'range', rangeMin: 6, rangeMax: 20 })).toBe('do 20 min');
  });

  it('camera-led congestion shows an honest FLOOR ("od X"), never a token low number', () => {
    // A camera-visible queue means "at least X min" — a floor, not an approximate that understates it.
    expect(formatWaitDisplay(30, { conflictKind: 'camera-congestion', precision: 'range', rangeMin: 4, rangeMax: 40 })).toBe('od 30 min');
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

  it('medium confidence collapses broad ranges to an approximate headline', () => {
    expect(formatWaitDisplay(45, { confidenceLevel: 'srednja', rangeMin: 35, rangeMax: 55 })).toBe('oko 45 min');
  });

  it('low confidence with a broad range does not leak raw wide bands', () => {
    expect(formatWaitDisplay(50, { confidenceLevel: 'niska', precision: 'range', rangeMin: 40, rangeMax: 58 })).toBe('oko 50 min');
  });

  it('hard-authority congestion keeps the official figure as a floor ("od X min")', () => {
    // A hard official/measured number is low but the camera shows a queue → committed floor.
    expect(formatWaitDisplay(11, { conflictKind: 'congestion' })).toBe('od 11 min');
  });

  it('camera-led congestion commits to a number (floor), never "check elsewhere"', () => {
    // Camera raised the estimate: a committed "od X min" floor (at least this long), not a punt.
    expect(formatWaitDisplay(30, { conflictKind: 'camera-congestion', precision: 'range', rangeMin: 30, rangeMax: 55 })).toBe('od 30 min');
  });

  it('clear-high conflict shows an approximate ("~X"), never a confident high number', () => {
    // Šamac case: wait is high but the camera shows little/no queue → suspect, verify.
    expect(formatWaitDisplay(360, { conflictKind: 'clear-high' })).toBe('~6 h');
  });

  it('camera-congestion (extreme visible queue) shows an honest floor "od X min", never "do 15"', () => {
    const shaped = shapeWaitDisplay(50, { conflictKind: 'camera-congestion', confidenceLevel: 'srednja', rangeMin: 45, rangeMax: 80 });
    expect(shaped.primaryLabel).toBe('od 50 min');
    expect(shaped.primaryLabel).not.toMatch(/^do /);
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


describe('shapeWaitDisplay production guardrails', () => {
  it('does not leak a 32–70 minute raw range to users', () => {
    const shaped = shapeWaitDisplay(48, { confidenceLevel: 'srednja', rangeMin: 32, rangeMax: 70 });
    expect(shaped.primaryLabel).toBe('oko 50 min');
    expect(shaped.broadRangeCollapsed).toBe(true);
    expect(shaped.displayRangeLabel).toContain('manje sigurno');
  });

  it('does not leak a 15–29 minute raw range to users', () => {
    const shaped = shapeWaitDisplay(22, { confidenceLevel: 'srednja', rangeMin: 15, rangeMax: 29 });
    expect(shaped.primaryLabel).toBe('oko 20 min');
    expect(shaped.broadRangeCollapsed).toBe(true);
  });
});
