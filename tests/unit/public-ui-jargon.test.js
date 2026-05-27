// Public UI must never expose internal pipeline jargon. This test scans
// src/App.jsx, extracts every string literal (",  ', `), and checks each
// extracted literal against a blocklist.
//
// Classifier contexts are exempted automatically:
//   - text.includes('gornja granica')     // classification, not display
//   - typeof window !== 'undefined'        // SSR guard
//   - someVar === 'undefined'              // type check
//
// Pure JS identifiers like `undefined` outside of a string literal are not
// flagged at all.

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.resolve(here, '..', '..', 'src', 'App.jsx');

const FORBIDDEN_PHRASES = [
  'sanity-check',
  'queue/flow',
  'route guard',
  'gornja granica',
  'calibrated',
  'Google promet normalan',
  'kamera ne potvrđuje kolonu',
  'public source upper bound',
  'BIHAMK + Kamera',
];

const FORBIDDEN_LITERAL_VALUES = ['undefined', 'NaN'];

function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

// Walk src, return list of { value, line, before }.
// `before` is up to 50 non-newline chars immediately preceding the opening quote.
function extractStringLiterals(src) {
  const out = [];
  let i = 0;
  let line = 1;
  // Skip // line comments naively
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { line += 1; i += 1; continue; }
    // line comment
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      // Capture preceding context for classifier exemption.
      const startCtx = Math.max(0, i - 50);
      let before = src.slice(startCtx, i).replace(/\n/g, ' ');
      const quote = ch;
      const startLine = line;
      let j = i + 1;
      let value = '';
      while (j < src.length) {
        const c = src[j];
        if (c === '\\') { value += src[j + 1] ?? ''; j += 2; continue; }
        if (c === '\n') line += 1;
        if (c === quote) break;
        if (quote === '`' && c === '$' && src[j + 1] === '{') {
          let depth = 1;
          j += 2;
          while (j < src.length && depth > 0) {
            if (src[j] === '{') depth += 1;
            else if (src[j] === '}') depth -= 1;
            else if (src[j] === '\n') line += 1;
            j += 1;
          }
          continue;
        }
        value += c;
        j += 1;
      }
      out.push({ value, line: startLine, before });
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

function isClassifierContext(before) {
  // Classifier / type-check / comparison contexts: the literal is never
  // shown to the user, it's only compared against other values.
  return (
    /\.(includes|indexOf|startsWith|endsWith|test|match)\s*\(\s*$/.test(before) ||
    /typeof\s+[\w.$]+\s*[!=]==?\s*$/.test(before) ||
    /[!=]==?\s*$/.test(before) ||
    /\bcase\s*$/.test(before) ||
    /\bswitch\s*\(\s*$/.test(before)
  );
}

let cachedLiteralsPromise = null;
function getLiterals() {
  if (!cachedLiteralsPromise) {
    cachedLiteralsPromise = readFile(appPath, 'utf8')
      .then(stripBlockComments)
      .then(extractStringLiterals)
      .then((literals) => literals.filter((lit) => !isClassifierContext(lit.before)));
  }
  return cachedLiteralsPromise;
}

describe('Public UI jargon scan (src/App.jsx string literals)', () => {
  for (const phrase of FORBIDDEN_PHRASES) {
    it(`must not contain "${phrase}" in any user-renderable string literal`, async () => {
      const literals = await getLiterals();
      const needle = phrase.toLowerCase();
      const hits = literals
        .filter((lit) => lit.value.toLowerCase().includes(needle))
        .map((lit) => `L${lit.line}: ${JSON.stringify(lit.value).slice(0, 200)}`);
      expect(
        hits,
        `Forbidden phrase "${phrase}" appears in user-renderable string literal(s):\n${hits.join('\n')}`,
      ).toEqual([]);
    });
  }

  for (const literal of FORBIDDEN_LITERAL_VALUES) {
    it(`must never embed the literal word "${literal}" inside a renderable string literal`, async () => {
      const literals = await getLiterals();
      const re = new RegExp(`\\b${literal}\\b`);
      const hits = literals
        .filter((lit) => re.test(lit.value))
        .map((lit) => `L${lit.line}: ${JSON.stringify(lit.value).slice(0, 200)}`);
      expect(
        hits,
        `Literal "${literal}" appears in renderable string-literal content:\n${hits.join('\n')}\n` +
        `Use a real human fallback (e.g. "Nema dovoljno podataka") instead.`,
      ).toEqual([]);
    });
  }
});

describe('Wait range labels are user-friendly', () => {
  it('source does not hard-code "0–15 min" anywhere', async () => {
    const src = await readFile(appPath, 'utf8');
    expect(src).not.toMatch(/['"`]\s*0\s*[–-]\s*15\s*min\s*['"`]/i);
  });
});
