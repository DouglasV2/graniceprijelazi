import { describe, it, expect } from 'vitest';
import { parseWaitMinutesFromText, resolveReportWaitMinutes, clampWaitMinutes, WAIT_QUICK_OPTIONS } from '../../src/utils/parse-wait-minutes.js';

describe('parseWaitMinutesFromText (Croatian free text)', () => {
  const cases = [
    ['30 min', 30],
    ['30 minuta', 30],
    ['čekao sam 30 min', 30],
    ['trideset minuta', 30],
    ['čekao sam trideset minuta', 30],
    ['pola sata', 30],
    ['pol sata', 30],
    ['sat vremena', 60],
    ['jedan sat', 60],
    ['sat i pol', 90],
    ['1h 20', 80],
    ['1 h 20 min', 80],
    ['dva sata', 120],
    ['dvadeset pet minuta', 25],
  ];
  for (const [text, expected] of cases) {
    it(`"${text}" → ${expected}`, () => {
      expect(parseWaitMinutesFromText(text)).toBe(expected);
    });
  }

  it('returns null when there is no time in the text', () => {
    expect(parseWaitMinutesFromText('prošao sam uredno')).toBeNull();
    expect(parseWaitMinutesFromText('')).toBeNull();
    expect(parseWaitMinutesFromText(null)).toBeNull();
  });
});

describe('clampWaitMinutes (validation 0–360)', () => {
  it('rejects empty / NaN / negative as null (not a usable value)', () => {
    expect(clampWaitMinutes('')).toBeNull();
    expect(clampWaitMinutes(null)).toBeNull();
    expect(clampWaitMinutes(undefined)).toBeNull();
    expect(clampWaitMinutes('abc')).toBeNull();
    expect(clampWaitMinutes(-5)).toBeNull();
  });
  it('clamps an absurdly large value to 360', () => {
    expect(clampWaitMinutes(99999)).toBe(360);
  });
  it('rounds and keeps valid values', () => {
    expect(clampWaitMinutes(30)).toBe(30);
    expect(clampWaitMinutes('45')).toBe(45);
    expect(clampWaitMinutes(30.6)).toBe(31);
  });
});

describe('resolveReportWaitMinutes (explicit > message > category default)', () => {
  it('explicit choice wins over a number in the message', () => {
    expect(resolveReportWaitMinutes({ explicit: 45, message: 'čekao sam 20 min', categoryDefault: 12 })).toBe(45);
  });
  it('parses the message when there is no explicit choice', () => {
    expect(resolveReportWaitMinutes({ explicit: null, message: 'čekao sam 30 min', categoryDefault: 12 })).toBe(30);
    expect(resolveReportWaitMinutes({ message: 'trideset minuta', categoryDefault: 65 })).toBe(30);
    expect(resolveReportWaitMinutes({ message: 'pola sata', categoryDefault: 65 })).toBe(30);
    expect(resolveReportWaitMinutes({ message: 'sat i pol', categoryDefault: 12 })).toBe(90);
  });
  it('falls back to the category default when there is no explicit choice and no parseable time', () => {
    expect(resolveReportWaitMinutes({ explicit: null, message: 'prošao uredno', categoryDefault: 12 })).toBe(12);
    expect(resolveReportWaitMinutes({ message: 'gužva je', categoryDefault: 65 })).toBe(65);
  });
  it('an invalid explicit value (empty/negative) does not block the message parse', () => {
    expect(resolveReportWaitMinutes({ explicit: '', message: '30 min', categoryDefault: 12 })).toBe(30);
    expect(resolveReportWaitMinutes({ explicit: -3, message: '30 min', categoryDefault: 12 })).toBe(30);
  });
});

describe('WAIT_QUICK_OPTIONS', () => {
  it('offers the requested ranges with usable minute values', () => {
    expect(WAIT_QUICK_OPTIONS.map((o) => o.label)).toEqual(['0–15', '15–30', '30–45', '45–60', '60+']);
    expect(WAIT_QUICK_OPTIONS.every((o) => clampWaitMinutes(o.min) === o.min)).toBe(true);
  });
});
