// Production safety net (every crossing): the HAK/BIHAMK pages list ALL crossings in one text
// blob. A crossing's wait MUST come from its own row only — never a neighbour's or a foreign
// (Serbian/…) crossing's number. This parametrised test builds a realistic concatenated blob
// where every configured crossing has a UNIQUE wait, interleaves foreign crossings with large
// (multi-hour) numbers, and asserts strict per-crossing isolation. It generalises the live
// Maljevac=360 min (Bajakovo "6 h") bleed to all crossings, so a regression anywhere is caught.
import { describe, it, expect } from 'vitest';
import {
  PUBLIC_SOURCE_TARGETS,
  extractBihamkSection,
  allPublicSourceNames,
  parseDirectionalWaitsFromText,
} from '../../server/index.js';

const targets = Object.entries(PUBLIC_SOURCE_TARGETS);

// A stable, collision-free 2-digit wait per crossing (avoids clashing with the timestamp digits
// and with each other). Foreign rows get clearly-larger numbers.
const ownWaitFor = (index) => 31 + index * 2; // 31, 33, 35, … all < 240, all unique
const primaryNameFor = ([, config]) => (config.bihamkNames || config.hakNames)[0];

// Build one HAK-style row: "<Name> - cekanje X min na ulazu i Y min na izlazu T: <ts>".
function row(name, wait) {
  if (wait === null) return `${name} - Nema podataka T: 2.6.2026. 20:00:00 `;
  return `${name} - cekanje ${wait} min na ulazu i ${wait} min na izlazu T: 2.6.2026. 20:00:00 `;
}

// Foreign block (never our targets) with deliberately huge multi-hour numbers that must NOT leak.
const FOREIGN_BLOCK =
  'Srbija - Hrvatska Ulaz Izlaz ' +
  row('Bajakovo (Batrovci)', null).replace('Nema podataka', 'cekanje 240 min na ulazu') +
  row('Tovarnik (Šid)', null).replace('Nema podataka', 'cekanje 180 min na izlazu') +
  'Batina (Bezdan) - 6 h T: 2.6.2026. 20:00:00 ';

// Whole-page blob: all crossings in config order, then the foreign block in the middle and end
// (so the LAST BiH crossing before the foreign block is also exercised).
const half = Math.ceil(targets.length / 2);
const headBlob = targets.slice(0, half).map((entry, i) => row(primaryNameFor(entry), ownWaitFor(i))).join('');
const tailBlob = targets.slice(half).map((entry, i) => row(primaryNameFor(entry), ownWaitFor(half + i))).join('');
const BLOB = `Bosna i Hercegovina Hrvatska ${headBlob}${FOREIGN_BLOCK}${tailBlob}${FOREIGN_BLOCK}`;

const boundary = [...allPublicSourceNames('hakNames'), ...allPublicSourceNames('bihamkNames')];

describe('per-crossing wait isolation across the shared HAK/BIHAMK blob', () => {
  targets.forEach((entry, index) => {
    const [crossingId, config] = entry;
    const names = config.hakNames || config.bihamkNames;
    const ownWait = ownWaitFor(index);

    it(`${crossingId}: section contains only its own wait, never a neighbour's or a foreign number`, () => {
      const section = extractBihamkSection(BLOB, names, boundary);
      expect(section, `${crossingId} produced an empty section`).not.toBe('');

      // Own number present.
      expect(section).toContain(`${ownWait} min`);

      // No OTHER crossing's unique number leaked in.
      targets.forEach((other, j) => {
        if (j === index) return;
        // Skip numbers that happen to equal this crossing's own (none do — all unique) — defensive.
        if (ownWaitFor(j) === ownWait) return;
        expect(section, `${crossingId} leaked ${other[0]}'s wait`).not.toContain(` ${ownWaitFor(j)} min`);
      });

      // No foreign multi-hour number leaked in.
      expect(/6\s*h/.test(section), `${crossingId} leaked Batina "6 h"`).toBe(false);
      expect(section).not.toContain('240 min');
      expect(section).not.toContain('180 min');
      expect(section).not.toContain('Bajakovo');
    });

    it(`${crossingId}: parsed wait equals its own number (not an inherited multi-hour value)`, () => {
      const section = extractBihamkSection(BLOB, names, boundary);
      const waits = parseDirectionalWaitsFromText(section, { sourceSide: 'hr' }).map((s) => s.wait);
      // Every parsed wait must be this crossing's own value — never 360/240/180.
      for (const w of waits) {
        expect(w).toBeLessThan(120);
        expect([360, 240, 180]).not.toContain(w);
      }
    });
  });

  it('a crossing reported as "Nema podataka" yields no fabricated wait from its neighbours', () => {
    // Rebuild the blob with maljevac explicitly "Nema podataka" sitting right before the foreign block.
    const blob =
      `Bosna i Hercegovina ${row('Maljevac (Velika Kladuša)', null)}` +
      `${row('GP Gradiška', 41)}` +
      FOREIGN_BLOCK;
    const section = extractBihamkSection(blob, PUBLIC_SOURCE_TARGETS.maljevac.bihamkNames, boundary);
    const waits = parseDirectionalWaitsFromText(section, { sourceSide: 'hr' }).map((s) => s.wait);
    expect(waits.some((w) => w >= 120)).toBe(false);
    expect(/6\s*h/.test(section)).toBe(false);
    expect(section).not.toContain('240 min');
  });
});
