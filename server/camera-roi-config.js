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
  // 'mal-hak-hr-exit': { crossingId: 'maljevac', direction: 'toBih', roiVersion: '2026-06-roi-1',
  //   queuePolygon: [...], ignorePolygons: [...], cameraReliability: 0.75, nightReliability: 0.45, isActive: true },
};

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

export function getRoiConfig(cameraId) {
  if (!cameraId) return null;
  const overrides = loadOverrides();
  if (overrides[cameraId]) return overrides[cameraId];
  if (STATIC_ROI_CONFIGS[cameraId]) return STATIC_ROI_CONFIGS[cameraId];
  return null;
}

export function listRoiConfigIds() {
  return [...new Set([...Object.keys(STATIC_ROI_CONFIGS), ...Object.keys(loadOverrides())])];
}

// Where a camera's effective config comes from: 'override' (runtime file) | 'static' (committed) | null.
export function getRoiConfigSource(cameraId) {
  if (!cameraId) return null;
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
