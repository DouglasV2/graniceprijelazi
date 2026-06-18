#!/usr/bin/env node
// Read-only post-deploy check: "did my baked ROIs land, and is YOLO counting inside them?"
// Hits ONLY admin GET endpoints (no writes, no reset, no refresh) so it is safe to run against
// production any time. For each camera-equipped crossing × direction it prints:
//   roiTrusted · vehiclesInQueueRoi (live count inside the queue polygon) · visualBand · cvStatus ·
//   wait-capable/mode (from camera audit) · calibration (samples → minutes).
// Then a summary: how many directions are roiTrusted / actively counting / calibrated, and the
// cv-detector (YOLO) health. Optionally folds in /roi-audit (config-level: which static ROI version
// loaded) when a debug token is supplied — useful to confirm a commit deployed even before YOLO runs.
//
// Usage:
//   SMOKE_BASE_URL=https://your-app.up.railway.app \
//   SMOKE_ADMIN_TOKEN=<admin bearer token> \
//   [SMOKE_DEBUG_TOKEN=<x-debug-token, enables config-level roi-audit>] \
//   [SMOKE_CROSSINGS=maljevac,bijaca | all] \
//   node scripts/validate-roi-rollout.mjs
//
// Get an admin token in the browser console after logging in as admin:
//   JSON.parse(localStorage.getItem('bf_current_user_v2')).token

const BASE = (process.env.SMOKE_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.SMOKE_ADMIN_TOKEN || '';
const DEBUG_TOKEN = process.env.SMOKE_DEBUG_TOKEN || '';
const CROSSINGS_ENV = (process.env.SMOKE_CROSSINGS || 'all').trim();

if (!ADMIN_TOKEN) { console.error('FATAL: set SMOKE_ADMIN_TOKEN (admin bearer token).'); process.exit(2); }

const authHeaders = { Authorization: `Bearer ${ADMIN_TOKEN}`, ...(DEBUG_TOKEN ? { 'x-debug-token': DEBUG_TOKEN } : {}) };

async function api(path, headers = authHeaders) {
  const res = await fetch(`${BASE}${path}`, { headers });
  let json = null; try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

const pad = (v, n) => String(v ?? '').padEnd(n).slice(0, n);
const fmtCount = (v) => (v === null || v === undefined ? '·' : String(v));

(async () => {
  const cvr = await api(`/api/admin/cv-readiness${CROSSINGS_ENV.toLowerCase() === 'all' ? '' : `?crossingId=${encodeURIComponent(CROSSINGS_ENV.split(',')[0])}`}`);
  if (cvr.status !== 200 || !cvr.json?.ok) {
    console.error(`FATAL: cv-readiness ${cvr.status} — ${cvr.json?.error || 'auth?'} (check SMOKE_ADMIN_TOKEN / SMOKE_BASE_URL)`);
    process.exit(2);
  }
  // Camera audit: cameraId+direction → { mode, waitCapable, warnings } (best-effort; non-fatal).
  const audit = await api('/api/admin/camera/audit');
  const auditBy = new Map();
  for (const c of (audit.json?.cameras || [])) auditBy.set(`${c.cameraId}:${c.direction}`, c);

  // Optional config-level confirmation that the committed STATIC_ROI_CONFIGS deployed.
  let roiAudit = null;
  if (DEBUG_TOKEN) {
    const ra = await api('/api/internal/traffic-vision/roi-audit');
    if (ra.status === 200) roiAudit = ra.json;
  }

  const cv = cvr.json.cvDetector || {};
  console.log(`=== ROI rollout @ ${BASE} ===`);
  console.log(cv.configured === false
    ? 'cv-detector (YOLO): NOT configured → heuristic mode (counts will be heuristic, not model)'
    : `cv-detector (YOLO): healthy=${cv.healthy} reachable=${cv.reachable} model=${cv.model || '?'} mem=${cv.memoryMb ?? '?'}MB lastErr=${cv.lastError ?? 'none'}`);
  console.log(`inFlight=${cvr.json.cvInFlight} queued=${cvr.json.cvQueued}\n`);

  console.log(`${pad('CROSSING', 16)}${pad('DIR', 7)}${pad('CAMERA', 20)}${pad('roiTrust', 9)}${pad('inROI', 6)}${pad('band', 10)}${pad('cvStatus', 18)}${pad('calib', 12)}auditMode`);
  console.log('-'.repeat(110));

  let trusted = 0, counting = 0, calibrated = 0, rows = 0;
  for (const cr of cvr.json.crossings || []) {
    for (const dir of ['toBih', 'toHr']) {
      const d = cr.directions?.[dir]; if (!d) continue;
      rows++;
      const camId = d.expectedCameraId || '(none)';
      const a = auditBy.get(`${camId}:${dir}`);
      const cal = d.calibration || {};
      if (d.roiTrusted) trusted++;
      if (Number(d.vehiclesInQueueRoi) > 0) counting++;
      if (cal.calibrated) calibrated++;
      console.log(
        pad(cr.crossingId, 16) + pad(dir, 7) + pad(camId, 20) +
        pad(d.roiTrusted ? 'YES' : 'no', 9) + pad(fmtCount(d.vehiclesInQueueRoi), 6) +
        pad(d.visualBand || '·', 10) + pad(d.cvStatus || '·', 18) +
        pad(`${cal.calibrated ? 'YES' : 'no'}(${cal.sampleSize ?? 0})`, 12) +
        (a ? a.mode : '?'),
      );
    }
  }

  if (roiAudit?.cameras) {
    const withRoi = roiAudit.cameras.filter((c) => c.hasExplicitRoi);
    console.log(`\nConfig (roi-audit): ${withRoi.length}/${roiAudit.cameras.length} cameras have an explicit queue polygon`);
    for (const c of withRoi) console.log(`  ${pad(c.id || c.cameraId, 22)} ${pad(c.roiSource, 10)} v=${c.roiVersion || '-'}`);
  }

  console.log(`\nSummary: ${trusted}/${rows} dirs roiTrusted · ${counting} actively counting (inROI>0) · ${calibrated} calibrated · cv-detector ${cv.configured === false ? 'heuristic' : (cv.healthy ? 'healthy' : 'UNHEALTHY')}`);
  console.log('legend: roiTrust/inROI/band/calib = ROI-v2 path (baked polygons → drive band + congestion floor + calibration).');
  console.log('        auditMode = legacy hard-wait gate (rect calibration). A trusted ROI-v2 camera can read "missing-config" here — known gap, not a deploy failure.');
  if (!DEBUG_TOKEN) console.log('(tip: add SMOKE_DEBUG_TOKEN to also confirm which static ROI version loaded, independent of YOLO)');
})();
