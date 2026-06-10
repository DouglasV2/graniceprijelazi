// T5 — history insights must answer "when is it worth going?" from REAL slots, and must
// degrade honestly (lowData / nulls) instead of fabricating patterns.
import { describe, it, expect } from 'vitest';
import { computeHistoryInsights, compareNowToTypical, formatHourWindow } from '../../src/utils/history-insights.js';

const slot = (hour, wait) => ({ hour: String(hour).padStart(2, '0'), wait });

describe('computeHistoryInsights', () => {
  const series = [
    slot(7, 5), slot(8, 6), slot(9, 8), slot(10, 14), slot(11, 20),
    slot(12, 26), slot(13, 30), slot(14, 35), slot(15, 48), slot(16, 44),
    slot(17, 32), slot(18, 22), slot(19, 12),
  ];

  it('finds the peak and calmest hour', () => {
    const out = computeHistoryInsights(series);
    expect(out.peak).toEqual({ hour: '15', wait: 48 });
    expect(out.calm).toEqual({ hour: '07', wait: 5 });
    expect(out.lowData).toBe(false);
    expect(out.sampleCount).toBe(13);
  });

  it('typical range is the p25–p75 band (not min–max)', () => {
    const out = computeHistoryInsights(series);
    expect(out.typicalRange.min).toBeGreaterThan(5);
    expect(out.typicalRange.max).toBeLessThan(48);
    expect(out.typicalRange.min).toBeLessThanOrEqual(out.typicalRange.max);
  });

  it('best window is the calm morning stretch, worst is the afternoon peak', () => {
    const out = computeHistoryInsights(series);
    expect(out.bestWindow.startHour).toBe(7);
    expect(out.bestWindow.endHour).toBe(10);
    expect(out.worstWindow.startHour).toBeGreaterThanOrEqual(14);
    expect(out.worstWindow.avgWait).toBeGreaterThan(out.bestWindow.avgWait);
  });

  it('empty series → lowData with null insights (no fabrication)', () => {
    const out = computeHistoryInsights([]);
    expect(out.sampleCount).toBe(0);
    expect(out.lowData).toBe(true);
    expect(out.peak).toBeNull();
    expect(out.bestWindow).toBeNull();
  });

  it('few samples → still computes but flags lowData', () => {
    const out = computeHistoryInsights([slot(9, 10), slot(10, 12)]);
    expect(out.lowData).toBe(true);
    expect(out.peak.wait).toBe(12);
  });

  it('ignores slots with unusable waits', () => {
    const out = computeHistoryInsights([slot(9, 10), { hour: '10', wait: 'NaN' }, { hour: '11' }]);
    expect(out.sampleCount).toBe(1);
  });
});

describe('compareNowToTypical', () => {
  const range = { min: 10, max: 20 };
  it('classifies better / worse / similar', () => {
    expect(compareNowToTypical(4, range)).toBe('better');
    expect(compareNowToTypical(35, range)).toBe('worse');
    expect(compareNowToTypical(15, range)).toBe('similar');
  });
  it('returns null when either side is unknown — UI must stay silent', () => {
    expect(compareNowToTypical(null, range)).toBeNull();
    expect(compareNowToTypical(15, null)).toBeNull();
    expect(compareNowToTypical(NaN, range)).toBeNull();
  });
});

describe('formatHourWindow', () => {
  it('formats a padded HH:00–HH:00 window', () => {
    expect(formatHourWindow(8, 10)).toBe('08:00–10:00');
  });
});
