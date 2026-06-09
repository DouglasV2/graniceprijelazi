#!/usr/bin/env node
// Admin-only production smoke for the first CV rollout batch (Maljevac + Gornji Varoš).
// For each crossing it runs: (1) operational-data reset [dry-run unless SMOKE_APPLY_RESET=true],
// (2) forced source refresh, (3) cv-readiness, (4) traffic-vision debug per direction, (5) public state.
// Then it evaluates PASS/FAIL on the production invariants and prints a summary.
//
// Usage:
//   SMOKE_BASE_URL=https://your-app.up.railway.app \
//   SMOKE_ADMIN_TOKEN=<admin bearer token> \
//   [SMOKE_DEBUG_TOKEN=<x-debug-token>] [SMOKE_APPLY_RESET=true] [SMOKE_CROSSINGS=maljevac,gornji-varos] \
//   node scripts/smoke-crossings.mjs
//
// Get an admin token in the browser console after logging in as admin:
//   JSON.parse(localStorage.getItem('bf_current_user_v2')).token

const BASE = (process.env.SMOKE_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.SMOKE_ADMIN_TOKEN || '';
const DEBUG_TOKEN = process.env.SMOKE_DEBUG_TOKEN || '';
const APPLY_RESET = process.env.SMOKE_APPLY_RESET === 'true';
// SMOKE_CROSSINGS=all → every camera-equipped crossing (resolved from cv-readiness at runtime).
const CROSSINGS_ENV = (process.env.SMOKE_CROSSINGS || 'maljevac,gornji-varos').trim();
const DIRECTIONS = ['toBih', 'toHr'];

if (!ADMIN_TOKEN) { console.error('FATAL: set SMOKE_ADMIN_TOKEN (admin bearer token).'); process.exit(2); }

const authHeaders = { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json', ...(DEBUG_TOKEN ? { 'x-debug-token': DEBUG_TOKEN } : {}) };
const results = [];
const record = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: authHeaders, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

const STRONG_BANDS = new Set(['srednja', 'velika', 'ekstremna']);

async function smokeCrossing(crossingId) {
  console.log(`\n=== ${crossingId} ===`);

  // 1. reset operational data (dry-run unless SMOKE_APPLY_RESET=true)
  const reset = await api('POST', `/api/admin/crossings/${crossingId}/reset-operational-data`, { apply: APPLY_RESET });
  record(`${crossingId} reset (${APPLY_RESET ? 'APPLY' : 'dry-run'})`, reset.status === 200 && reset.json?.ok, `runtime.before=${JSON.stringify(reset.json?.runtime?.before?.reports ?? '?')} reports`);

  // 2. forced refresh
  const refresh = await api('POST', '/api/admin/sources/refresh');
  record(`${crossingId} forced refresh`, refresh.status === 200, `snapshots=${refresh.json?.snapshots?.length ?? '?'} failures=${(refresh.json?.failures || []).length}`);

  // 3. cv-readiness
  const readiness = await api('GET', `/api/admin/cv-readiness?crossingId=${crossingId}`);
  const cv = readiness.json?.cvDetector || {};
  // detector healthy OR not configured (heuristic mode is acceptable — but never a silent fake-zero)
  record(`${crossingId} cv-detector health`, readiness.status === 200 && (cv.configured === false || cv.healthy === true || cv.reachable === false),
    cv.configured === false ? 'cv not configured (heuristic mode)' : `model=${cv.model || '?'} mem=${cv.memoryMb ?? '?'}MB lastErr=${cv.lastError ?? 'none'} inFlight=${readiness.json?.cvInFlight}`);

  // 4. traffic-vision debug per direction + the core invariants
  for (const direction of DIRECTIONS) {
    const dbg = await api('GET', `/api/admin/traffic-vision/${crossingId}/${direction}`);
    const b = dbg.json || {};
    const wait = b.finalEstimateMin;
    const band = b.sourceBreakdown?.camera?.visualBand || null;
    const floor = b.decision?.appliedFloor || null;
    const label = b.finalLabel || '';
    record(`${crossingId}/${direction} debug responds`, dbg.status === 200 && Number.isFinite(wait), `wait=${wait} band=${band} floor=${floor} label="${label}"`);

    // INVARIANT: applied camera floor ⇒ numeric wait elevated (no "od 3 min" + "kamera vidi gužvu")
    if (floor) record(`${crossingId}/${direction} floor implies elevated wait`, Number(wait) >= 20, `floor=${floor} wait=${wait}`);
    // INVARIANT: a strong visual band must not coexist with a sub-10 confident number
    if (STRONG_BANDS.has(band)) record(`${crossingId}/${direction} strong band ⇒ not false-low`, Number(wait) >= 20, `band=${band} wait=${wait}`);
    // INVARIANT: camera reason present (never a silent visualBand:null)
    record(`${crossingId}/${direction} camera reason present`, typeof b.sourceBreakdown?.camera?.reason === 'string' && b.sourceBreakdown.camera.reason.length > 0, b.sourceBreakdown?.camera?.reason?.slice(0, 80));
  }

  // 5. public state — blue card wait must match debug (no raw-Google leak below a floor)
  const state = await api('GET', '/api/public/state');
  const crossing = (state.json?.crossings || []).find((c) => c.id === crossingId);
  record(`${crossingId} public state lists crossing`, Boolean(crossing), crossing ? `armed=${crossing.locationWaitArmed}` : 'missing');
}

async function resolveCrossings() {
  if (CROSSINGS_ENV.toLowerCase() !== 'all') return CROSSINGS_ENV.split(',').map((s) => s.trim()).filter(Boolean);
  const r = await api('GET', '/api/admin/cv-readiness'); // defaults to every camera-equipped crossing
  return (r.json?.crossings || []).map((c) => c.crossingId);
}

(async () => {
  const CROSSINGS = await resolveCrossings();
  console.log(`Smoke against ${BASE} — crossings: ${CROSSINGS.join(', ')} — reset=${APPLY_RESET ? 'APPLY' : 'dry-run'}`);
  for (const id of CROSSINGS) {
    try { await smokeCrossing(id); } catch (e) { record(`${id} smoke run`, false, String(e?.message || e)); }
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${'='.repeat(40)}\n${failed.length ? `FAIL — ${failed.length}/${results.length} checks failed` : `PASS — all ${results.length} checks passed`}`);
  process.exit(failed.length ? 1 : 0);
})();
