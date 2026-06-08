import { describe, it, expect } from 'vitest';
import { detectVisualCongestionConflict, worstQueueBand, queueBandRank } from '../../server/intelligence.js';

describe('visual congestion conflict (Maljevac/Brod core fix)', () => {
  it('flags a conflict when the camera visually shows a big queue but the wait is low', () => {
    const r = detectVisualCongestionConflict({ visualBand: 'ekstremna', fusedWait: 11 });
    expect(r.conflict).toBe(true);
    expect(r.suggestedRangeMax).toBe(120);
  });

  it('velika band + low wait is also a conflict', () => {
    expect(detectVisualCongestionConflict({ visualBand: 'velika', fusedWait: 8 }).conflict).toBe(true);
  });

  it('no conflict when the wait already reflects congestion', () => {
    expect(detectVisualCongestionConflict({ visualBand: 'ekstremna', fusedWait: 70 }).conflict).toBe(false);
  });

  it('a MEDIUM (srednja) visual queue + low wait is also a conflict (prevents an optimistic "do 20")', () => {
    const r = detectVisualCongestionConflict({ visualBand: 'srednja', fusedWait: 8 });
    expect(r.conflict).toBe(true);
    expect(r.suggestedRangeMax).toBe(45); // smaller than velika(60)/ekstremna(120)
  });

  it('no conflict for an empty/small visual band (nema/mala)', () => {
    expect(detectVisualCongestionConflict({ visualBand: 'mala', fusedWait: 8 }).conflict).toBe(false);
    expect(detectVisualCongestionConflict({ visualBand: 'nema', fusedWait: 8 }).conflict).toBe(false);
  });

  it('no conflict without a numeric wait', () => {
    expect(detectVisualCongestionConflict({ visualBand: 'ekstremna', fusedWait: null }).conflict).toBe(false);
  });
});

describe('worstQueueBand / queueBandRank', () => {
  it('picks the most congested band', () => {
    expect(worstQueueBand(['nema', 'velika', 'mala'])).toBe('velika');
    expect(worstQueueBand(['mala', 'ekstremna'])).toBe('ekstremna');
  });
  it('ranks bands in order', () => {
    expect(queueBandRank('ekstremna')).toBeGreaterThan(queueBandRank('velika'));
    expect(queueBandRank('nema')).toBe(0);
  });
});
