// T3 regression — the "0 min vs do 5 min" mismatch. Every UI surface goes through the same
// shared formatter, and the formatter itself must be deterministic for identical inputs:
// "0 min" appears ONLY as a deliberate high-confidence no-wait; other near-zero estimates
// read "do 5 min" everywhere.
import { describe, it, expect } from 'vitest';
import { formatWaitDisplay, shapeWaitDisplay } from '../../src/utils/wait-format.js';

describe('small-value consistency rule', () => {
  it('0 with high confidence (deliberate no-wait) → "0 min"', () => {
    expect(formatWaitDisplay(0, { confidenceLevel: 'visoka' })).toBe('0 min');
    expect(formatWaitDisplay(0, {})).toBe('0 min'); // default confidence is high
  });

  it('0 with non-high confidence is NOT presented as a confident zero', () => {
    expect(formatWaitDisplay(0, { confidenceLevel: 'srednja' })).toBe('do 5 min');
    expect(formatWaitDisplay(0, { confidenceLevel: 'niska' })).toBe('do 5 min');
  });

  it('small positive estimates (1–5) read "do 5 min" — never a token "2 min"', () => {
    for (const wait of [1, 2, 3, 4, 5]) {
      for (const meta of [{}, { confidenceLevel: 'visoka' }, { confidenceLevel: 'srednja' }, { confidenceLevel: 'niska' }]) {
        expect(formatWaitDisplay(wait, meta), `wait=${wait} meta=${JSON.stringify(meta)}`).toBe('do 5 min');
      }
    }
  });

  it('the rule does not swallow real waits above 5 min', () => {
    expect(formatWaitDisplay(6, { confidenceLevel: 'visoka' })).toBe('6 min');
    expect(formatWaitDisplay(22, { confidenceHint: 'high' })).toBe('22 min');
  });

  it('conflict floors still win over the small-value rule', () => {
    expect(formatWaitDisplay(4, { conflictKind: 'camera-congestion' })).toBe('od 4 min');
  });

  it('same crossing+direction inputs produce the same display on every surface', () => {
    // Sidebar, marker, overlay, alerts and history all call the same function — feeding the
    // same (wait, meta) MUST give one string. Guard against future per-surface formatting.
    const cases = [
      [0, {}],
      [3, { confidenceLevel: 'srednja' }],
      [12, { confidenceLevel: 'visoka' }],
      [18, { confidenceHint: 'low' }],
      [25, { rangeMin: 20, rangeMax: 30, confidenceLevel: 'visoka' }],
    ];
    for (const [wait, meta] of cases) {
      const a = formatWaitDisplay(wait, meta);
      const b = formatWaitDisplay(wait, meta);
      const shaped = shapeWaitDisplay(wait, meta).primaryLabel;
      expect(a).toBe(b);
      expect(a).toBe(shaped);
    }
  });

  it('range starting at 0 still collapses to an upper bound, not "0–X"', () => {
    const out = formatWaitDisplay(2, { rangeMin: 0, rangeMax: 10, confidenceLevel: 'srednja' });
    expect(out).toMatch(/^do /);
    expect(out).not.toMatch(/0\s*[–-]/);
  });
});
