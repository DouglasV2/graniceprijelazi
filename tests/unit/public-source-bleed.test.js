// Root-cause regression for the live "Maljevac = 3 h 23 min – 6 h" bug.
// HAK/BIHAMK status pages concatenate EVERY border crossing into one text blob using bare
// names ("Bajakovo (Batrovci)", no "GP " prefix). The per-crossing section extractor used a
// 760-char window that swallowed the NEXT crossing's row, so Bajakovo's "6 h" was parsed as
// Maljevac's "Eksplicitno čekanje 360 min" and dominated the fusion as an official lead source.
import { describe, it, expect } from 'vitest';
import { extractBihamkSection, allPublicSourceNames, parseDirectionalWaitsFromText } from '../../server/index.js';

// Real-shaped HAK blob captured live on 2026-06-02 (Maljevac has NO number; Bajakovo has "6 h").
const HAK_BLOB =
  'Nema podataka Višesatna čekanja T: 2.6.2026. 19:55:52 - Nema podataka - Nema podataka ' +
  'Maljevac (Velika Kladuša) - Nema podataka Višesatna čekanja T: 2.6.2026. 20:50:57 - Nema podataka - Nema podataka ' +
  'Slavonski Šamac (Bosanski Šamac) - Nema podataka 2 h T: 2.6.2026. 20:10:13 - Nema podataka - Nema podataka ' +
  'Svilaj - Nema podataka Višesatna čekanja T: 2.6.2026. 19:23:32 - Nema podataka - Nema podataka ' +
  'Srbija - Hrvatska Ulaz Izlaz Bajakovo (Batrovci) - Nema podataka 6 h T: 2.6.2026. 20:01:42 Tovarnik (Šid) - Nema podataka';

const MALJEVAC_NAMES = ['Velika Kladuša', 'GP Velika Kladuša', 'Maljevac', 'VELIKA KLADUŠA - MALJEVAC'];

describe('extractBihamkSection bounds one crossing at the next crossing name (no cross-crossing bleed)', () => {
  const boundary = [...allPublicSourceNames('hakNames'), ...allPublicSourceNames('bihamkNames')];

  it('the Maljevac section does NOT include the next crossing\'s "6 h"', () => {
    const section = extractBihamkSection(HAK_BLOB, MALJEVAC_NAMES, boundary);
    expect(section).toContain('Maljevac');
    expect(/6\s*h/.test(section)).toBe(false);
    expect(section).not.toContain('Bajakovo');
  });

  it('Maljevac (which HAK reports without a number) yields NO bogus explicit wait', () => {
    const section = extractBihamkSection(HAK_BLOB, MALJEVAC_NAMES, boundary);
    const waits = parseDirectionalWaitsFromText(section, { sourceSide: 'hr' }).map((s) => s.wait);
    expect(waits).not.toContain(360);
    // No neighbour's hour-value leaks in as a multi-hour Maljevac wait.
    expect(waits.some((w) => w >= 120)).toBe(false);
  });

  it('stays safe even when the caller passes NO target boundary names (built-in foreign + cap)', () => {
    // Defence in depth: the foreign section boundaries (Bajakovo, "Srbija - Hrvatska", …) and the
    // tight per-row cap are applied INSIDE extractBihamkSection, so even a caller that forgets the
    // boundary list can never inherit a neighbour/foreign multi-hour number.
    const section = extractBihamkSection(HAK_BLOB, MALJEVAC_NAMES);
    const waits = parseDirectionalWaitsFromText(section, { sourceSide: 'hr' }).map((s) => s.wait);
    expect(waits).not.toContain(360);
    expect(/6\s*h/.test(section)).toBe(false);
  });

  it('a crossing with its own number still keeps it (boundary does not over-trim)', () => {
    const section = extractBihamkSection(HAK_BLOB, ['Šamac', 'Bosanski Šamac', 'GP Šamac'], boundary);
    expect(section).toContain('Šamac');
    // "2 h" belongs to Slavonski Šamac and must survive inside its own section.
    expect(/2\s*h/.test(section)).toBe(true);
    expect(/6\s*h/.test(section)).toBe(false); // but still not Bajakovo's 6 h
  });
});
