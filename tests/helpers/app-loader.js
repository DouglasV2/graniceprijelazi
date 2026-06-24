// Lazy loader for the Express app. Importing server/index.js triggers
// initializeDatastore() and registers all routes. We import once per
// test process and share the resulting app instance.

let cachedAppPromise = null;

export async function getApp() {
  if (!cachedAppPromise) {
    cachedAppPromise = (async () => {
      const mod = await import('../../server/index.js');
      await mod.initializeDatastore();
      return mod.app;
    })();
  }
  return cachedAppPromise;
}

export const ALL_CROSSING_IDS = [
  'maljevac',
  'gradiska',
  'gornji-varos',
  'bijaca',
  'orasje',
  'brod',
  'samac',
  'svilaj',
  'izacic',
  'kamensko',
  'prisika',
  'vinjani-donji',
  'vinjani-gornji',
  'crveni-grm',
  // Added 2026-06-23 (additional HR↔BiH crossings).
  'gunja',
  'dvor',
  'hrv-kostajnica',
  'metkovic',
  // batch 2 (2026-06-23): west/Dinara + Una valley.
  'strmica-bos-grahovo',
  'uzljebic-ripac',
  'hrvatska-dubica-kozarska-dubica',
  // batch 3 (2026-06-23): Neum corridor (south).
  'klek-neum',
  'zaton-doli-neum',
  'gabela-polje',
  // batch 4 (2026-06-23): Dubrovnik/Konavle + Popovo polje + Sava.
  'ivanica-brgat',
  'prud-zvirici',
  'cepikuce-trebimlja',
  'orah-orahovlje',
  'jasenovac-gradina',
];

export const DIRECTIONS = ['toBih', 'toHr'];

// Numeric-finite assertion used across route/trip-option tests.
export function expectFiniteNonNegative(value, label) {
  if (value === null || value === undefined) {
    throw new Error(`${label} is null/undefined, expected a finite non-negative number`);
  }
  if (typeof value === 'number' && Number.isNaN(value)) {
    throw new Error(`${label} is NaN`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${label} is not finite (got ${value})`);
  }
  if (n < 0) {
    throw new Error(`${label} is negative (${n})`);
  }
  return n;
}

// JSON-shape assertion: no NaN/Infinity/undefined leaks anywhere in the payload.
// Returns the offending path or null when clean.
export function findIllegalJsonValue(node, path = '$') {
  if (node === null) return null;
  if (typeof node === 'number') {
    if (!Number.isFinite(node)) return `${path} is non-finite (${node})`;
    return null;
  }
  if (typeof node === 'string') {
    if (node === 'NaN' || node === 'undefined') return `${path} contains literal "${node}" string`;
    return null;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const found = findIllegalJsonValue(node[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node)) {
      const found = findIllegalJsonValue(node[key], `${path}.${key}`);
      if (found) return found;
    }
    return null;
  }
  return null;
}
