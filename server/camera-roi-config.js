// Per-camera ROI v2 config store. Source of truth = STATIC_ROI_CONFIGS (committed here → survives
// redeploys). The editor saves runtime OVERRIDES to data/camera-roi-overrides.json (works in both
// file + postgres datastore modes since it's an independent file). IMPORTANT: on an ephemeral PaaS
// FS (Railway) the overrides file is lost on redeploy — the editor therefore also EXPORTS the JSON
// so a finalised ROI can be pasted into STATIC_ROI_CONFIGS below and committed.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateRoiConfig } from './traffic-vision-roi.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const OVERRIDES_PATH = join(__dir, '..', 'data', 'camera-roi-overrides.json');

// Committed ROI configs (cameraId → config). Add finalised polygons here after calibrating in the
// editor (Export JSON → paste). Coordinates are normalized 0..1.
export const STATIC_ROI_CONFIGS = {
  // Production seed ROIs for the key cameras visible in the app. These are conservative: queue
  // polygons cover the actual approach lanes, while parking/shoulder areas from the screenshots are
  // ignored so a parked car or opposite-side vehicle cannot inflate a wait. Operators can refine
  // them in /internal/roi-editor and commit the exported snippet here.
  'mal-hak-hr-entry': {
    cameraId: 'mal-hak-hr-entry', crossingId: 'maljevac', direction: 'toHr', roiVersion: '2026-06-production-seed-1',
    queuePolygon: [
      { x: 0.32, y: 0.28 }, { x: 0.72, y: 0.29 }, { x: 0.79, y: 0.93 }, { x: 0.39, y: 0.96 },
    ],
    ignorePolygons: [
      [{ x: 0.00, y: 0.55 }, { x: 0.28, y: 0.55 }, { x: 0.33, y: 1.00 }, { x: 0.00, y: 1.00 }],
      [{ x: 0.74, y: 0.30 }, { x: 1.00, y: 0.28 }, { x: 1.00, y: 0.75 }, { x: 0.82, y: 0.68 }],
    ],
    lanePolygons: [], cameraReliability: 0.62, nightReliability: 0.42, isActive: true, metadata: { reviewedFrom: '2026-06-18 live frame — toHr queue confirmed in central lane' },
  },
  'mal-hak-hr-exit': {
    cameraId: 'mal-hak-hr-exit', crossingId: 'maljevac', direction: 'toBih', roiVersion: '2026-06-20-reviewed',
    queuePolygon: [
      { x: 0.28, y: 0.18 }, { x: 0.58, y: 0.17 }, { x: 0.78, y: 0.95 }, { x: 0.40, y: 0.98 },
    ],
    ignorePolygons: [
      [{ x: 0.70, y: 0.18 }, { x: 1.00, y: 0.15 }, { x: 1.00, y: 0.55 }, { x: 0.76, y: 0.50 }],
      [{ x: 0.00, y: 0.00 }, { x: 0.18, y: 0.00 }, { x: 0.26, y: 0.60 }, { x: 0.00, y: 0.75 }],
    ],
    lanePolygons: [], cameraReliability: 0.64, nightReliability: 0.43, isActive: true, metadata: { reviewedFrom: '2026-06-20 live frame — toBih exit queue confirmed in the central lane' },
  },
  'gv-hak-queue-9': {
    cameraId: 'gv-hak-queue-9', crossingId: 'gornji-varos', direction: 'toHr', roiVersion: '2026-06-18-left-lane-estimate',
    queuePolygon: [
      { x: 0.06, y: 0.22 }, { x: 0.46, y: 0.22 }, { x: 0.40, y: 0.86 }, { x: 0.04, y: 0.86 },
    ],
    ignorePolygons: [],
    lanePolygons: [],
    cameraReliability: 0.72, nightReliability: 0.48, isActive: true, metadata: { seededFrom: 'legacy whole-frame rect replaced with toHr left-lane estimate 2026-06-18', needsEditorReview: true },
  },
  'gv-hak-plaza-4': {
    cameraId: 'gv-hak-plaza-4', crossingId: 'gornji-varos', direction: 'toHr', roiVersion: '2026-06-18-reviewed',
    queuePolygon: [
      { x: 0.05, y: 0.25 }, { x: 0.42, y: 0.23 }, { x: 0.30, y: 0.90 }, { x: 0.00, y: 0.84 },
    ],
    ignorePolygons: [],
    lanePolygons: [],
    cameraReliability: 0.72, nightReliability: 0.48, isActive: true, metadata: { reviewedFrom: '2026-06-18 live frame — toHr queue in LEFT lanes (legacy whole-frame rect replaced)' },
  },
  'gra-rs-in': {
    cameraId: 'gra-rs-in', crossingId: 'gradiska', direction: 'toBih', roiVersion: '2026-06-18-reviewed',
    queuePolygon: [
      { x: 0.55, y: 0.10 }, { x: 0.85, y: 0.10 }, { x: 0.96, y: 0.98 }, { x: 0.60, y: 1.00 },
    ],
    ignorePolygons: [], lanePolygons: [], cameraReliability: 0.66, nightReliability: 0.45, isActive: true,
    metadata: { reviewedFrom: '2026-06-18 live frame — toBih queue in RIGHT lane' },
  },
  'gra-rs-out': {
    cameraId: 'gra-rs-out', crossingId: 'gradiska', direction: 'toHr', roiVersion: '2026-06-18-estimate',
    queuePolygon: [
      { x: 0.45, y: 0.10 }, { x: 0.70, y: 0.10 }, { x: 0.80, y: 0.75 }, { x: 0.40, y: 0.78 },
    ],
    ignorePolygons: [], lanePolygons: [], cameraReliability: 0.66, nightReliability: 0.45, isActive: true,
    metadata: { seededFrom: '2026-06-18 estimate — through lanes empty at review; verify in editor', needsEditorReview: true },
  },
  // ── Bijača / GP Nova Sela (HAK 201/202) — reviewed against live daytime frames WITH a queue ───
  'bij-hak-ulaz-hr': {
    cameraId: 'bij-hak-ulaz-hr', crossingId: 'bijaca', direction: 'toHr', roiVersion: '2026-06-18-reviewed',
    queuePolygon: [
      { x: 0.28, y: 0.30 }, { x: 0.74, y: 0.29 }, { x: 0.90, y: 0.80 }, { x: 0.40, y: 0.84 },
    ],
    ignorePolygons: [
      [{ x: 0.00, y: 0.24 }, { x: 0.18, y: 0.24 }, { x: 0.20, y: 0.52 }, { x: 0.00, y: 0.54 }],
      [{ x: 0.86, y: 0.24 }, { x: 1.00, y: 0.24 }, { x: 1.00, y: 0.62 }, { x: 0.84, y: 0.56 }],
    ],
    lanePolygons: [], cameraReliability: 0.66, nightReliability: 0.45, isActive: true,
    metadata: { reviewedFrom: '2026-06-18 live frame — toHr queue in central lanes; left parking + right shoulder ignored' },
  },
  'bij-hak-izlaz-hr': {
    cameraId: 'bij-hak-izlaz-hr', crossingId: 'bijaca', direction: 'toBih', roiVersion: '2026-06-18-reviewed',
    queuePolygon: [
      { x: 0.40, y: 0.30 }, { x: 0.60, y: 0.33 }, { x: 0.40, y: 0.85 }, { x: 0.08, y: 0.78 },
    ],
    ignorePolygons: [
      [{ x: 0.66, y: 0.10 }, { x: 1.00, y: 0.10 }, { x: 1.00, y: 0.70 }, { x: 0.66, y: 0.55 }],
    ],
    lanePolygons: [], cameraReliability: 0.64, nightReliability: 0.44, isActive: true,
    metadata: { reviewedFrom: '2026-06-18 live frame — toBih queue in left diagonal lane; right opposite-direction road ignored' },
  },
  // ── Slavonski Brod · ulaz u HR (HAK 195) — flagged: central approach lane, marked parking excluded ──
  'bro-hak-sb-ulaz-hr': {
    cameraId: 'bro-hak-sb-ulaz-hr', crossingId: 'brod', direction: 'toHr', roiVersion: '2026-06-18-estimate',
    queuePolygon: [
      { x: 0.34, y: 0.18 }, { x: 0.60, y: 0.16 }, { x: 0.72, y: 0.80 }, { x: 0.40, y: 0.86 },
    ],
    ignorePolygons: [
      [{ x: 0.00, y: 0.18 }, { x: 0.32, y: 0.18 }, { x: 0.30, y: 0.55 }, { x: 0.00, y: 0.58 }],
    ],
    lanePolygons: [], cameraReliability: 0.62, nightReliability: 0.42, isActive: true,
    metadata: { seededFrom: '2026-06-18 estimate — near lanes empty at review, marked parking excluded; verify in editor', needsEditorReview: true },
  },
  // ── Visual-only HAK frames (direction unprovable from label) — ROI only sharpens the visual count;
  //    these never drive a directional wait (validForDirections=[]), it just keeps parked / opposite
  //    vehicles out of the band so the camera does not over-report "gužva".
  'iza-hak-bih': {
    cameraId: 'iza-hak-bih', crossingId: 'izacic', direction: 'toBih', roiVersion: '2026-06-18-estimate',
    queuePolygon: [
      { x: 0.00, y: 0.28 }, { x: 0.60, y: 0.12 }, { x: 0.66, y: 0.20 }, { x: 0.05, y: 0.48 },
    ],
    ignorePolygons: [
      [{ x: 0.66, y: 0.15 }, { x: 1.00, y: 0.15 }, { x: 1.00, y: 0.70 }, { x: 0.66, y: 0.55 }],
    ],
    lanePolygons: [], cameraReliability: 0.55, nightReliability: 0.38, isActive: true,
    metadata: { seededFrom: '2026-06-18 live frame — queue band in left/centre lanes, empty right lanes ignored. Visual-only (direction unproven) → count signal only', needsEditorReview: true },
  },
  'cg-hak-bih': {
    cameraId: 'cg-hak-bih', crossingId: 'crveni-grm', direction: 'toBih', roiVersion: '2026-06-18-estimate',
    queuePolygon: [
      { x: 0.20, y: 0.95 }, { x: 0.64, y: 0.92 }, { x: 0.60, y: 0.28 }, { x: 0.30, y: 0.24 },
    ],
    ignorePolygons: [
      [{ x: 0.00, y: 0.20 }, { x: 0.18, y: 0.20 }, { x: 0.18, y: 0.62 }, { x: 0.00, y: 0.66 }],
    ],
    lanePolygons: [], cameraReliability: 0.55, nightReliability: 0.38, isActive: true,
    metadata: { seededFrom: '2026-06-18 estimate — road empty at review, left roadside parking excluded. Visual-only (direction unproven); verify in editor', needsEditorReview: true },
  },
  // ── P3 visual-only HAK frames (no provable direction → NEVER drive a directional wait). ROI here
  //    ONLY restricts the visual count to the queue lane so open/empty lanes + staging parking don't
  //    inflate the band. All needsEditorReview (single-frame estimate; kam/vd rotate frames).
  'ora-hak-bih': {
    cameraId: 'ora-hak-bih', crossingId: 'orasje', direction: 'toHr', roiVersion: '2026-06-18-estimate',
    queuePolygon: [
      { x: 0.05, y: 0.25 }, { x: 0.48, y: 0.25 }, { x: 0.30, y: 0.78 }, { x: 0.00, y: 0.68 },
    ],
    ignorePolygons: [
      [{ x: 0.52, y: 0.22 }, { x: 1.00, y: 0.22 }, { x: 1.00, y: 0.60 }, { x: 0.55, y: 0.50 }],
    ],
    lanePolygons: [], cameraReliability: 0.55, nightReliability: 0.38, isActive: true,
    metadata: { seededFrom: '2026-06-18 live frame — truck queue in left lane, open right lanes ignored. Visual-only', needsEditorReview: true },
  },
  'kam-hak': {
    cameraId: 'kam-hak', crossingId: 'kamensko', direction: 'toHr', roiVersion: '2026-06-18-estimate',
    queuePolygon: [
      { x: 0.00, y: 0.16 }, { x: 0.54, y: 0.10 }, { x: 0.56, y: 0.22 }, { x: 0.00, y: 0.36 },
    ],
    ignorePolygons: [
      [{ x: 0.58, y: 0.10 }, { x: 1.00, y: 0.10 }, { x: 1.00, y: 0.45 }, { x: 0.60, y: 0.30 }],
    ],
    lanePolygons: [], cameraReliability: 0.52, nightReliability: 0.36, isActive: true,
    metadata: { seededFrom: '2026-06-18 live frame — truck queue along left lane, open centre/right ignored. Visual-only, multi-image (primary 317.jpg)', needsEditorReview: true },
  },
  'vd-hak': {
    cameraId: 'vd-hak', crossingId: 'vinjani-donji', direction: 'toBih', roiVersion: '2026-06-18-estimate',
    queuePolygon: [
      { x: 0.56, y: 0.08 }, { x: 0.85, y: 0.06 }, { x: 1.00, y: 0.65 }, { x: 0.66, y: 0.80 },
    ],
    ignorePolygons: [
      [{ x: 0.00, y: 0.10 }, { x: 0.52, y: 0.10 }, { x: 0.52, y: 0.85 }, { x: 0.00, y: 0.85 }],
    ],
    lanePolygons: [], cameraReliability: 0.55, nightReliability: 0.38, isActive: true,
    metadata: { seededFrom: '2026-06-18 live frame — toBih car queue in right lane, empty left lanes ignored. Visual-only, multi-image (primary 302.jpg)', needsEditorReview: true },
  },
  'svi-hak': {
    cameraId: 'svi-hak', crossingId: 'svilaj', direction: 'toBih', roiVersion: '2026-06-18-estimate',
    queuePolygon: [
      { x: 0.00, y: 0.42 }, { x: 0.45, y: 0.40 }, { x: 0.48, y: 0.96 }, { x: 0.00, y: 0.98 },
    ],
    ignorePolygons: [
      [{ x: 0.55, y: 0.10 }, { x: 1.00, y: 0.10 }, { x: 1.00, y: 0.95 }, { x: 0.58, y: 0.95 }],
    ],
    lanePolygons: [], cameraReliability: 0.55, nightReliability: 0.38, isActive: true,
    metadata: { seededFrom: '2026-06-18 live frame — short toBih queue in left lane, empty right side ignored. Visual-only', needsEditorReview: true },
  },
};

// DB-backed configs (postgres mode) are loaded once at startup + after each save into this sync
// cache, so getRoiConfig() can stay synchronous on the hot path. index.js owns the SQL; it pushes
// the resolved map here via setDbRoiConfigs(). Empty in file mode.
let _dbConfigs = {};
export function setDbRoiConfigs(map) {
  _dbConfigs = (map && typeof map === 'object') ? map : {};
}
export function getDbRoiConfig(cameraId) {
  return (cameraId && _dbConfigs[cameraId]) || null;
}

let _overridesCache = null;
let _overridesMtime = 0;

function readOverrides() {
  try {
    if (!existsSync(OVERRIDES_PATH)) return {};
    const raw = readFileSync(OVERRIDES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function loadOverrides() {
  // Cheap cache; re-read when the file changes.
  try {
    const stat = existsSync(OVERRIDES_PATH) ? readFileSync(OVERRIDES_PATH, 'utf8').length : 0;
    if (_overridesCache && stat === _overridesMtime) return _overridesCache;
    _overridesCache = readOverrides();
    _overridesMtime = stat;
    return _overridesCache;
  } catch {
    return _overridesCache || {};
  }
}

// Resolution order (spec §1.1): DB config → runtime file override → committed static → null.
// (rect-derived legacy calibration is applied by the caller as the next fallback.)
export function getRoiConfig(cameraId) {
  if (!cameraId) return null;
  if (_dbConfigs[cameraId]) return _dbConfigs[cameraId];
  const overrides = loadOverrides();
  if (overrides[cameraId]) return overrides[cameraId];
  if (STATIC_ROI_CONFIGS[cameraId]) return STATIC_ROI_CONFIGS[cameraId];
  return null;
}

export function listRoiConfigIds() {
  return [...new Set([...Object.keys(STATIC_ROI_CONFIGS), ...Object.keys(loadOverrides()), ...Object.keys(_dbConfigs)])];
}

// Where a camera's effective config comes from: 'db' | 'override' (runtime file) | 'static' | null.
export function getRoiConfigSource(cameraId) {
  if (!cameraId) return null;
  if (_dbConfigs[cameraId]) return 'db';
  if (loadOverrides()[cameraId]) return 'override';
  if (STATIC_ROI_CONFIGS[cameraId]) return 'static';
  return null;
}

// Convert the legacy rect calibration ({x,y,w,h} in percent) into a normalized queue polygon so
// already-calibrated cameras get ROI v2 queue counting until a precise polygon is drawn.
export function rectCalibrationToRoiConfig(camera = {}, crossingId, direction) {
  const rect = camera?.calibration?.queueRoi || camera?.calibration?.roi;
  if (!rect || !Number.isFinite(Number(rect.x))) return null;
  const x = Math.max(0, Math.min(1, Number(rect.x) / 100));
  const y = Math.max(0, Math.min(1, Number(rect.y) / 100));
  const w = Math.max(0, Math.min(1, Number(rect.w ?? rect.width ?? 0) / 100));
  const h = Math.max(0, Math.min(1, Number(rect.h ?? rect.height ?? 0) / 100));
  if (w <= 0 || h <= 0) return null;
  return {
    cameraId: camera.id,
    crossingId,
    direction,
    roiVersion: 'rect-derived',
    queuePolygon: [
      { x, y }, { x: Math.min(1, x + w), y }, { x: Math.min(1, x + w), y: Math.min(1, y + h) }, { x, y: Math.min(1, y + h) },
    ],
    ignorePolygons: [],
    cameraReliability: 0.6,
    nightReliability: 0.4,
    isActive: true,
    derivedFromRect: true,
  };
}

// Save a runtime override (validated). Returns { ok, errors, config }. Never throws.
export function saveRoiConfig(cameraId, config = {}) {
  if (!cameraId) return { ok: false, errors: ['cameraId nedostaje'] };
  const merged = { ...config, cameraId, updatedAt: new Date().toISOString() };
  const { valid, errors } = validateRoiConfig(merged);
  if (!valid) return { ok: false, errors };
  try {
    const overrides = readOverrides();
    overrides[cameraId] = merged;
    if (!existsSync(dirname(OVERRIDES_PATH))) mkdirSync(dirname(OVERRIDES_PATH), { recursive: true });
    writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
    _overridesCache = overrides;
    _overridesMtime = JSON.stringify(overrides).length;
    return { ok: true, errors: [], config: merged };
  } catch (error) {
    return { ok: false, errors: [`spremanje nije uspjelo: ${error.message}`] };
  }
}

export const ROI_OVERRIDES_PATH = OVERRIDES_PATH;
