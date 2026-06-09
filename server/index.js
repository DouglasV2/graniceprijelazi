import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import jpeg from 'jpeg-js';
import { fileURLToPath } from 'url';
import {
  CONFIDENCE_LEVELS,
  computeConfidenceProfile,
  computeSmartRange,
  buildSourceExplanation,
  classifyQueueBand,
  QUEUE_BANDS,
  applyRoiToDetections,
  detectVisualCongestionConflict,
  detectCameraClearConflict,
  resolveCameraClearOverride,
  resolveCameraCongestionOverride,
  estimateWaitFromCameraSignals,
  cameraYoloEligibility,
  worstQueueBand,
  computeAverageHash,
  detectStaleFrames,
  buildCameraAnalysis,
  cameraContributionMode,
  computeReportTrust,
  dedupeReports,
  detectReportAnomalies,
  computeAccuracyStats,
  evaluateWaitAlerts,
  rankBestCrossings,
  computeMeasuredWait,
  haversineMeters,
  locateInGeofence,
  computeBiasCorrection,
  buildEstimateExplanation,
} from './intelligence.js';
import {
  CALIBRATION_VERSION,
  CALIBRATION_THRESHOLDS,
  computeCalibrationModel,
  applyConfidenceDowngrades,
  computeConfidenceCalibrationStats,
  computeErrorHistogram,
  computeReliabilityReport,
  sourceMixClass,
} from './confidence-calibration.js';
import {
  TRAFFIC_VISION_MODEL_VERSION,
  computeGoogleTrafficV2,
  aggregateGoogleSamples,
  estimateCameraWaitV2,
  serviceRateFor,
  fuseTrafficVision,
} from './traffic-vision.js';
import {
  computeRoiCameraFeatures,
  classifyDetectionsByRoi,
  trackStoppedMoving,
  validateRoiConfig,
} from './traffic-vision-roi.js';
import {
  getRoiConfig,
  getRoiConfigSource,
  rectCalibrationToRoiConfig,
  saveRoiConfig,
  listRoiConfigIds,
  setDbRoiConfigs,
  STATIC_ROI_CONFIGS,
} from './camera-roi-config.js';
import { ROI_EDITOR_HTML } from './roi-editor-page.js';
import { buildMeasurementZone, pathCrossesBorder, buildCalibratedCorridor, validateDisplayPathQuality, pointAlongBearing } from './map-display-geometry.js';
import { classifyLocationPing, aggregateVerifiedLocation } from './location-wait.js';
import { buildLocationWaitAnchors, hasLocationWaitAnchors } from './location-wait-anchors.js';
import { applyCalibratedWait, buildCalibrationModels, calibrationKey } from './camera-calibration.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env.local'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const app = express();
const port = Number(process.env.PORT || 5050);
const serverKey = process.env.GOOGLE_MAPS_SERVER_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
const cameraIngestApiKey = process.env.CAMERA_INGEST_API_KEY || '';
const configuredCorsOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  // CSP: allow Google Maps JS/Tiles, Google Fonts, self scripts/styles/images.
  // 'unsafe-inline' for styles is required by Google Maps SDK.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://maps.googleapis.com https://maps.gstatic.com 'unsafe-inline'",
      "style-src 'self' https://fonts.googleapis.com https://maps.googleapis.com 'unsafe-inline'",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.hak.hr https://*.bihamk.ba https://*.ams-rs.com https://*.satwork.net https://gpmaljevac.com",
      "connect-src 'self' https://maps.googleapis.com https://routes.googleapis.com",
      "frame-src 'self' https://*.hak.hr https://*.bihamk.ba https://*.ams-rs.com https://gpmaljevac.com",
      "frame-ancestors 'self'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; '),
  );
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(cors(configuredCorsOrigins.length ? {
  origin(origin, callback) {
    if (!origin || configuredCorsOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS origin is not allowed'));
  },
} : undefined));
app.use(express.json({ limit: '160kb' }));


const runtimeDir = path.resolve(__dirname, '..', 'data');
const storePath = path.join(runtimeDir, 'runtime-store.json');
const sqlSchemaPath = path.resolve(__dirname, '..', 'sql', '001_schema.sql');
const databaseUrl = process.env.DATABASE_URL || '';
const datastoreMode = databaseUrl ? 'postgres' : 'json-file';
const weakDefaultSecret = 'borderflow-local-dev-secret-change-me';
const sessionSecret = process.env.SESSION_SECRET || weakDefaultSecret;
const tokenTtlMs = Number(process.env.SESSION_TTL_HOURS || 24) * 60 * 60 * 1000;

function ensureRuntimeDir() {
  if (!fs.existsSync(runtimeDir)) fs.mkdirSync(runtimeDir, { recursive: true });
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromBase64url(input) {
  const padded = input + '='.repeat((4 - input.length % 4) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 130000, 32, 'sha256').toString('hex');
  return `pbkdf2_sha256$130000$${salt}$${hash}`;
}

function verifyPassword(password, storedHash = '') {
  const [algorithm, iterationsRaw, salt, expected] = String(storedHash).split('$');
  if (algorithm !== 'pbkdf2_sha256' || !salt || !expected) return false;
  const iterations = Number(iterationsRaw || 130000);
  const actual = crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function seedStore() {
  const now = new Date().toISOString();
  const adminEmail = process.env.BORDERFLOW_ADMIN_EMAIL || 'admin@borderflow.app';
  const adminPassword = process.env.BORDERFLOW_ADMIN_PASSWORD || 'change-this-admin-password';
  const demoUserEmail = process.env.BORDERFLOW_DEMO_USER_EMAIL || 'user@borderflow.app';
  const demoUserPassword = process.env.BORDERFLOW_DEMO_USER_PASSWORD || 'change-this-user-password';
  return {
    version: 2,
    users: [
      { id: 'admin-access', name: 'Admin', email: adminEmail.toLowerCase(), role: 'admin', passwordHash: hashPassword(adminPassword), createdAt: now },
      { id: 'user-access', name: 'Korisnik', email: demoUserEmail.toLowerCase(), role: 'user', passwordHash: hashPassword(demoUserPassword), createdAt: now },
    ],
    overrides: {},
    statusOverrides: {},
    reports: [],
    audit: [{ id: crypto.randomUUID(), type: 'store_seeded', createdAt: now }],
    routeSearches: [],
    historySnapshots: [],
    sourceSnapshots: [],
  };
}

function readStore() {
  ensureRuntimeDir();
  if (!fs.existsSync(storePath)) {
    const seeded = seedStore();
    writeStore(seeded);
    return seeded;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return {
      version: parsed.version || 2,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      overrides: parsed.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {},
      statusOverrides: parsed.statusOverrides && typeof parsed.statusOverrides === 'object' ? parsed.statusOverrides : {},
      reports: Array.isArray(parsed.reports) ? parsed.reports : [],
      audit: Array.isArray(parsed.audit) ? parsed.audit : [],
      routeSearches: Array.isArray(parsed.routeSearches) ? parsed.routeSearches : [],
      historySnapshots: Array.isArray(parsed.historySnapshots) ? parsed.historySnapshots : [],
      sourceSnapshots: Array.isArray(parsed.sourceSnapshots) ? parsed.sourceSnapshots : [],
    };
  } catch (error) {
    const fallback = seedStore();
    fallback.audit.push({ id: crypto.randomUUID(), type: 'store_recovered', message: error.message, createdAt: new Date().toISOString() });
    writeStore(fallback);
    return fallback;
  }
}

function writeStore(store) {
  ensureRuntimeDir();
  const tmpPath = `${storePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  fs.renameSync(tmpPath, storePath);
}

let pgPoolPromise = null;

async function getPgPool() {
  if (!databaseUrl) return null;
  if (!pgPoolPromise) {
    pgPoolPromise = import('pg').then(({ Pool }) => new Pool({
      connectionString: databaseUrl,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    }));
  }
  return pgPoolPromise;
}

async function dbQuery(text, params = []) {
  const pool = await getPgPool();
  if (!pool) throw new Error('DATABASE_URL nije postavljen.');
  return pool.query(text, params);
}

function isoDate(value) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    passwordHash: row.password_hash,
    createdAt: isoDate(row.created_at),
  };
}

function reportFromRow(row) {
  return {
    id: row.id,
    crossingId: row.crossing_id,
    direction: row.direction,
    wait: Number(row.wait_minutes || 0),
    message: row.message || '',
    type: row.report_type || 'ok',
    user: row.user_snapshot || null,
    createdAt: isoDate(row.created_at),
  };
}

function auditFromRow(row) {
  return {
    id: row.id,
    type: row.type,
    actor: row.actor_snapshot || null,
    details: row.details || {},
    createdAt: isoDate(row.created_at),
  };
}

function routeSearchFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    origin: row.origin,
    destination: row.destination,
    direction: row.direction,
    vehicle: row.vehicle,
    bestCrossingId: row.best_crossing_id,
    bestCrossingName: row.best_crossing_name,
    totalMinutes: Number(row.total_minutes || 0),
    live: Boolean(row.live),
    createdAt: isoDate(row.created_at),
  };
}

function dateOnly(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function historySnapshotFromRow(row) {
  return {
    id: row.id,
    date: dateOnly(row.snapshot_date),
    crossingId: row.crossing_id,
    direction: row.direction,
    hour: row.hour,
    cars: Number(row.cars || 0),
    vans: Number(row.vans || 0),
    trucks: Number(row.trucks || 0),
    buses: Number(row.buses || 0),
    totalDemand: Number(row.total_demand || 0),
    passed: Number(row.passed || 0),
    throughput: Number(row.throughput || row.passed || 0),
    rhythmSeconds: Number(row.rhythm_seconds || 0),
    queueVehicles: Number(row.queue_vehicles || 0),
    wait: Number(row.wait_minutes || 0),
    source: row.source || 'camera-model',
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  };
}


function sourceSnapshotFromRow(row) {
  return {
    id: row.id,
    crossingId: row.crossing_id,
    direction: row.direction,
    sourceName: row.source_name,
    sourceType: row.source_type || 'public-source',
    sourceUrl: row.source_url || '',
    rawStatus: row.raw_status || '',
    rawText: row.raw_text || '',
    rawWaitMin: row.raw_wait_min === null || row.raw_wait_min === undefined ? null : Number(row.raw_wait_min),
    normalizedWaitMin: row.normalized_wait_min === null || row.normalized_wait_min === undefined ? null : Number(row.normalized_wait_min),
    confidence: Number(row.confidence || 0),
    weight: Number(row.weight || 1),
    metadata: row.metadata || {},
    fetchedAt: isoDate(row.fetched_at),
    createdAt: isoDate(row.created_at),
  };
}

async function ensureSqlSchema() {
  if (!databaseUrl) return;
  const schema = fs.readFileSync(sqlSchemaPath, 'utf8');
  await dbQuery(schema);

  const count = await dbQuery('SELECT COUNT(*)::int AS count FROM borderflow_users');
  if (Number(count.rows[0]?.count || 0) === 0 && process.env.BORDERFLOW_ADMIN_PASSWORD) {
    const now = new Date().toISOString();
    const admin = {
      id: 'admin-access',
      name: process.env.BORDERFLOW_ADMIN_NAME || 'Admin',
      email: String(process.env.BORDERFLOW_ADMIN_EMAIL || 'admin@borderflow.app').toLowerCase(),
      role: 'admin',
      passwordHash: hashPassword(process.env.BORDERFLOW_ADMIN_PASSWORD),
      createdAt: now,
    };
    await dbQuery(
      'INSERT INTO borderflow_users (id, name, email, role, password_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (email) DO NOTHING',
      [admin.id, admin.name, admin.email, admin.role, admin.passwordHash, admin.createdAt]
    );
    await dbQuery(
      'INSERT INTO borderflow_audit (id, type, actor_snapshot, details, created_at) VALUES ($1,$2,$3,$4,$5)',
      [crypto.randomUUID(), 'admin_seeded_from_env', publicUser(admin), {}, now]
    );
  }
}

async function readSqlStore() {
  const [users, overrides, statusOverrides, reports, auditRows, routeRows, sourceRows] = await Promise.all([
    dbQuery('SELECT * FROM borderflow_users ORDER BY created_at ASC'),
    dbQuery('SELECT * FROM borderflow_admin_overrides ORDER BY updated_at DESC'),
    dbQuery('SELECT * FROM borderflow_status_overrides ORDER BY updated_at DESC'),
    dbQuery('SELECT * FROM borderflow_driver_reports ORDER BY created_at DESC LIMIT 1000'),
    dbQuery('SELECT * FROM borderflow_audit ORDER BY created_at DESC LIMIT 500'),
    dbQuery('SELECT * FROM borderflow_route_searches ORDER BY created_at DESC LIMIT 500'),
    dbQuery('SELECT DISTINCT ON (crossing_id, direction, source_name) * FROM borderflow_source_snapshots ORDER BY crossing_id, direction, source_name, fetched_at DESC LIMIT 1000'),
  ]);

  return {
    version: 3,
    users: users.rows.map(userFromRow),
    overrides: Object.fromEntries(overrides.rows.map((row) => [row.key, Number(row.wait_minutes || 0)])),
    statusOverrides: Object.fromEntries(statusOverrides.rows.map((row) => [row.key, {
      status: row.status,
      note: row.note || '',
      replacementCrossingId: row.replacement_crossing_id || '',
      updatedAt: isoDate(row.updated_at),
    }])),
    reports: reports.rows.map(reportFromRow),
    audit: auditRows.rows.map(auditFromRow),
    routeSearches: routeRows.rows.map(routeSearchFromRow),
    historySnapshots: [],
    sourceSnapshots: [],
  };
}

async function writeSqlStore(store) {
  const pool = await getPgPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const user of store.users || []) {
      await client.query(
        `INSERT INTO borderflow_users (id, name, email, role, password_hash, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, role=EXCLUDED.role, password_hash=EXCLUDED.password_hash`,
        [user.id, user.name, user.email, user.role, user.passwordHash, user.createdAt || new Date().toISOString()]
      );
    }

    await client.query('DELETE FROM borderflow_admin_overrides');
    for (const [key, wait] of Object.entries(store.overrides || {})) {
      const [crossingId, direction] = key.split(':');
      await client.query(
        `INSERT INTO borderflow_admin_overrides (key, crossing_id, direction, wait_minutes, updated_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [key, crossingId, direction, Math.round(Number(wait || 0))]
      );
    }

    await client.query('DELETE FROM borderflow_status_overrides');
    for (const [key, item] of Object.entries(store.statusOverrides || {})) {
      const [crossingId, direction] = key.split(':');
      const status = ['open', 'busy', 'closed', 'redirected', 'unknown'].includes(item?.status) ? item.status : 'unknown';
      if (status === 'open') continue;
      await client.query(
        `INSERT INTO borderflow_status_overrides (key, crossing_id, direction, status, note, replacement_crossing_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [key, crossingId, direction, status, String(item?.note || '').slice(0, 280), String(item?.replacementCrossingId || '').slice(0, 80)]
      );
    }

    await client.query('DELETE FROM borderflow_driver_reports');
    for (const report of store.reports || []) {
      await client.query(
        `INSERT INTO borderflow_driver_reports (id, crossing_id, direction, wait_minutes, message, report_type, user_id, user_snapshot, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [report.id, report.crossingId, report.direction, Number(report.wait || 0), report.message || '', report.type || 'ok', report.user?.id || null, report.user || null, report.createdAt || new Date().toISOString()]
      );
    }

    await client.query('DELETE FROM borderflow_audit');
    for (const item of store.audit || []) {
      await client.query(
        `INSERT INTO borderflow_audit (id, type, actor_user_id, actor_snapshot, details, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [item.id, item.type, item.actor?.id || null, item.actor || null, item.details || {}, item.createdAt || new Date().toISOString()]
      );
    }

    await client.query('DELETE FROM borderflow_route_searches');
    for (const item of store.routeSearches || []) {
      await client.query(
        `INSERT INTO borderflow_route_searches (id, user_id, origin, destination, direction, vehicle, best_crossing_id, best_crossing_name, total_minutes, live, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [item.id, item.userId || null, item.origin, item.destination, item.direction, item.vehicle, item.bestCrossingId || null, item.bestCrossingName || null, Number(item.totalMinutes || 0), Boolean(item.live), item.createdAt || new Date().toISOString()]
      );
    }

    for (const item of store.sourceSnapshots || []) {
      await client.query(
        `INSERT INTO borderflow_source_snapshots
           (id, crossing_id, direction, source_name, source_type, source_url, raw_status, raw_text, raw_wait_min, normalized_wait_min, confidence, weight, metadata, fetched_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO NOTHING`,
        [item.id, item.crossingId, item.direction, item.sourceName, item.sourceType || 'public-source', item.sourceUrl || '', item.rawStatus || '', item.rawText || '', item.rawWaitMin ?? null, item.normalizedWaitMin ?? null, Number(item.confidence || 50), Number(item.weight || 1), item.metadata || {}, item.fetchedAt || new Date().toISOString(), item.createdAt || item.fetchedAt || new Date().toISOString()]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ── ROI v2 configs in Postgres (production source of truth) ───────────────────────────────────
// Rows are mapped back to the same shape getRoiConfig() returns, then pushed into the sync cache in
// camera-roi-config.js so the hot path stays synchronous. Falls back silently to static/file config.
function roiRowToConfig(row) {
  if (!row) return null;
  return {
    cameraId: row.camera_id,
    crossingId: row.crossing_id || null,
    direction: row.direction || null,
    queuePolygon: Array.isArray(row.queue_polygon_json) ? row.queue_polygon_json : [],
    ignorePolygons: Array.isArray(row.ignore_polygons_json) ? row.ignore_polygons_json : [],
    lanePolygons: Array.isArray(row.lane_polygons_json) ? row.lane_polygons_json : [],
    boothLine: row.booth_line_json || null,
    borderLine: row.border_line_json || null,
    metersPerPixel: row.meters_per_pixel != null ? Number(row.meters_per_pixel) : null,
    cameraReliability: row.camera_reliability != null ? Number(row.camera_reliability) : 0.7,
    nightReliability: row.night_reliability != null ? Number(row.night_reliability) : 0.45,
    roiVersion: row.roi_version || 'db-1',
    isActive: row.is_active !== false,
    source: 'db',
    metadata: row.metadata_json || {},
    updatedAt: isoDate(row.updated_at),
  };
}

async function loadRoiConfigsFromDb() {
  if (datastoreMode !== 'postgres') { setDbRoiConfigs({}); return {}; }
  try {
    const result = await dbQuery('SELECT * FROM borderflow_camera_roi_configs WHERE is_active = TRUE');
    const map = {};
    for (const row of result.rows) {
      const cfg = roiRowToConfig(row);
      if (cfg && cfg.cameraId) map[cfg.cameraId] = cfg;
    }
    setDbRoiConfigs(map);
    return map;
  } catch (error) {
    console.warn('[roi] DB ROI load failed, falling back to static/file configs:', error.message);
    setDbRoiConfigs({});
    return {};
  }
}

async function saveRoiConfigToDb(cameraId, config) {
  const id = `roi-${cameraId}`;
  await dbQuery(
    `INSERT INTO borderflow_camera_roi_configs
       (id, camera_id, crossing_id, direction, queue_polygon_json, ignore_polygons_json, lane_polygons_json,
        booth_line_json, border_line_json, meters_per_pixel, camera_reliability, night_reliability,
        roi_version, is_active, metadata_json, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
     ON CONFLICT (camera_id) DO UPDATE SET
       crossing_id=EXCLUDED.crossing_id, direction=EXCLUDED.direction,
       queue_polygon_json=EXCLUDED.queue_polygon_json, ignore_polygons_json=EXCLUDED.ignore_polygons_json,
       lane_polygons_json=EXCLUDED.lane_polygons_json, booth_line_json=EXCLUDED.booth_line_json,
       border_line_json=EXCLUDED.border_line_json, meters_per_pixel=EXCLUDED.meters_per_pixel,
       camera_reliability=EXCLUDED.camera_reliability, night_reliability=EXCLUDED.night_reliability,
       roi_version=EXCLUDED.roi_version, is_active=EXCLUDED.is_active, metadata_json=EXCLUDED.metadata_json,
       updated_at=NOW()`,
    [
      id, cameraId, config.crossingId || null, config.direction || null,
      JSON.stringify(config.queuePolygon || []), JSON.stringify(config.ignorePolygons || []), JSON.stringify(config.lanePolygons || []),
      config.boothLine ? JSON.stringify(config.boothLine) : null, config.borderLine ? JSON.stringify(config.borderLine) : null,
      Number.isFinite(Number(config.metersPerPixel)) ? Number(config.metersPerPixel) : null,
      Number.isFinite(Number(config.cameraReliability)) ? Number(config.cameraReliability) : 0.7,
      Number.isFinite(Number(config.nightReliability)) ? Number(config.nightReliability) : 0.45,
      String(config.roiVersion || 'db-1').slice(0, 60), config.isActive !== false, config.metadata || {},
    ]
  );
  await loadRoiConfigsFromDb();
}

async function readAppStore() {
  if (datastoreMode === 'postgres') return readSqlStore();
  return readStore();
}

async function writeAppStore(store) {
  if (datastoreMode === 'postgres') return writeSqlStore(store);
  writeStore(store);
}

async function initializeDatastore() {
  if (datastoreMode === 'postgres') {
    await ensureSqlSchema();
    await loadPersistedIntelligenceState();
    await loadRoiConfigsFromDb();
  } else {
    readStore();
  }
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

function signToken(user) {
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    exp: Date.now() + tokenTtlMs,
  };
  const body = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${body}.${signature}`;
}

async function verifyToken(token) {
  try {
    const [body, signature] = String(token || '').split('.');
    if (!body || !signature) return null;
    const expected = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (signature.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const payload = JSON.parse(fromBase64url(body));
    if (!payload.exp || Date.now() > payload.exp) return null;
    const store = await readAppStore();
    const user = store.users.find((item) => item.id === payload.sub && item.email === payload.email);
    return publicUser(user);
  } catch {
    return null;
  }
}

async function authRequired(req, res, next) {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ ok: false, error: 'Prijava je potrebna.' });
    req.user = user;
    return next();
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Provjera prijave nije uspjela.' });
  }
}

function adminRequired(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin pristup je potreban.' });
  return next();
}

const rateBuckets = new Map();
const rateBucketsCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
}, 15 * 60 * 1000);
if (typeof rateBucketsCleanupTimer?.unref === 'function') rateBucketsCleanupTimer.unref();

function rateLimit({ windowMs = 60000, max = 60, keyPrefix = 'api' } = {}) {
  return (req, res, next) => {
    const key = `${keyPrefix}:${req.ip}:${req.path}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key) || { resetAt: now + windowMs, count: 0 };
    if (now > bucket.resetAt) {
      bucket.resetAt = now + windowMs;
      bucket.count = 0;
    }
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > max) return res.status(429).json({ ok: false, error: 'Previše zahtjeva. Pokušaj malo kasnije.' });
    return next();
  };
}

async function audit(type, actor, details = {}) {
  const store = await readAppStore();
  store.audit.unshift({ id: crypto.randomUUID(), type, actor: actor ? publicUser(actor) : null, details, createdAt: new Date().toISOString() });
  store.audit = store.audit.slice(0, 500);
  await writeAppStore(store);
}

function statusOverrideKey(crossingId, direction) {
  return `${crossingId}:${direction === 'toHr' ? 'toHr' : 'toBih'}`;
}

function normalizeOperationalStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['open', 'busy', 'closed', 'redirected', 'unknown'].includes(status)) return status;
  return 'unknown';
}

function getStoredStatusOverride(store, crossingId, direction) {
  const key = statusOverrideKey(crossingId, direction);
  return store?.statusOverrides?.[key] || null;
}

function statusOverrideRoutePayload(crossing, direction, override) {
  if (!override || override.status === 'open') return null;
  if (override.status === 'closed' || override.status === 'redirected') {
    const label = override.status === 'redirected' ? 'preusmjerena' : 'zatvorena';
    return routeClosedPayload(crossing, direction, override.note || `Ruta je ručno označena kao ${label}.`, {
      source: 'Admin status override',
      routeStatus: override.status === 'redirected' ? 'redirected' : 'closed_or_blocked',
      adminStatus: override,
    });
  }
  return null;
}

function envWarnings() {
  const warnings = [];
  if (!serverKey) warnings.push('GOOGLE_MAPS_SERVER_KEY nije postavljen pa se koriste fallback procjene ruta.');
  if (sessionSecret === weakDefaultSecret) warnings.push('SESSION_SECRET koristi razvojnu vrijednost; promijeni za produkciju.');
  if (!process.env.BORDERFLOW_ADMIN_PASSWORD) warnings.push('BORDERFLOW_ADMIN_PASSWORD nije postavljen; za produkciju kreiraj admina kroz SQL seed ili env varijable.');
  if (datastoreMode === 'json-file') warnings.push('DATABASE_URL nije postavljen pa se koristi lokalni JSON store; za produkciju koristi PostgreSQL tablice.');
  if (!cameraIngestApiKey) warnings.push('CAMERA_INGEST_API_KEY nije postavljen; camera ingest endpoint je zaključan dok se ne postavi ključ.');
  return warnings;
}

const BORDER_CROSSINGS = {
  maljevac: {
    id: 'maljevac',
    name: 'GP Maljevac',
    shortName: 'Maljevac',
    waits: {
      // Production fallback only. Real value should come from admin override, BIHAMK/AMS, camera snapshots or driver reports.
      toBih: { car: 23, truck: 55, bus: 32 },
      toHr: { car: 28, truck: 60, bus: 38 },
    },
    anchors: {
      // Production calibration: these are NOT the public marker coordinates.
      // They are short, drivable control-zone anchors placed on the D216/M4.2 road
      // immediately before/through/after GP Maljevac. The earlier anchors were too far
      // toward Velika Kladuša and Google drew a city loop; these keep the map focused
      // on the actual border approach while still forcing the route through the crossing.
      // Precise control anchors stay SHORT + ON the D216/M4.2 (route-guard pass-distance AND
      // live-location A→B use ONLY these). The display zone is the Google ROAD-FOLLOWING polyline
      // requested between these anchors, modestly extended (~1 km/side) along the road. The earlier
      // hardcoded 1.25 km display anchors overshot a road bend on the HR side → Google drew an
      // off-road spur to reach them; removed. displayCorridor.requestExtendMeters keeps the extension
      // modest + on-road, validateDisplayPathQuality rejects any spur/loop (clean fallback only then).
      toBih: {
        label: 'HR → BiH',
        fromLabel: 'Maljevac · HR prilaz kontroli',
        toLabel: 'Velika Kladuša · BiH izlaz iz kontrole',
        approachStart: { lat: 45.19985, lng: 15.79042 },
        borderPoint: { lat: 45.19583, lng: 15.79639 },
        exitPoint: { lat: 45.19295, lng: 15.80155 },
        routeGuard: { maxCrossingDistanceKm: 6, hardMaxCrossingDistanceKm: 14, passDistanceMeters: 600, validateApproachExit: true, displayMaxMeters: 3000, displayCorridor: { requestExtendMeters: 1000, sliceMeters: 1200, fallbackPerSideMeters: 1000, fallbackMaxPerSideMeters: 1300 } },
      },
      toHr: {
        label: 'BiH → HR',
        fromLabel: 'Velika Kladuša · BiH prilaz kontroli',
        toLabel: 'Maljevac · HR izlaz iz kontrole',
        approachStart: { lat: 45.19295, lng: 15.80155 },
        borderPoint: { lat: 45.19583, lng: 15.79639 },
        exitPoint: { lat: 45.19985, lng: 15.79042 },
        routeGuard: { maxCrossingDistanceKm: 6, hardMaxCrossingDistanceKm: 14, passDistanceMeters: 600, validateApproachExit: true, displayMaxMeters: 3000, displayCorridor: { requestExtendMeters: 1000, sliceMeters: 1200, fallbackPerSideMeters: 1000, fallbackMaxPerSideMeters: 1300 } },
      },
    },
  },
  gradiska: {
    id: 'gradiska',
    name: 'GP Gradiška',
    shortName: 'Gradiška',
    // NOTE: routeStatusHint.replacementCrossingId is intentionally removed.
    // Stara Gradiška is operational again; previously when Google returned
    // ZERO_RESULTS the API marked the crossing as closed and redirected users
    // to Gornji Varoš. With wider pass-distance + retryWithoutVia, Google now
    // returns a real route; on rare failures we fall through to a calibrated
    // zone polyline instead of a "closed" page.
    waits: {
      toBih: { car: 32, truck: 65, bus: 42 },
      toHr: { car: 40, truck: 80, bus: 55 },
    },
    anchors: {
      toBih: {
        label: 'HR → BiH',
        fromLabel: 'Stara Gradiška · HR prilaz',
        toLabel: 'Gradiška · BiH izlaz (M6)',
        // Anchors pulled tight to the Sava bridge: HR approach sits at the bridge entrance
        // (Stara Gradiška side) and the BiH exit sits south of Gradiška city centre near
        // the M6 highway, which is roughly where the current displayed polyline ends.
        approachStart: { lat: 45.14850, lng: 17.25100 },
        borderPoint: { lat: 45.14530, lng: 17.25210 },
        exitPoint: { lat: 45.13800, lng: 17.25750 },
        // Secondary approach via Vidovdanska street in Gradiška BiH — exposes traffic
        // information for vehicles that take the eastern through-town corridor instead of
        // the main southern Kozarskih brigada → M6 route.
        additionalRoutes: [
          {
            label: 'Preko Vidovdanske',
            description: 'Alternativni prilaz mostu kroz Vidovdansku ulicu (Gradiška BiH)',
            exitPoint: { lat: 45.14250, lng: 17.25900 },
          },
        ],
        // useViaIntermediate: false → skip the strict via waypoint that triggers
        // Google ZERO_RESULTS on this bridge. The free approach→exit route always
        // crosses the actual border zone. For this crossing we fail open so a guard mismatch
        // logs as a warning instead of dropping back to a straight calibrated line.
        routeGuard: { maxCrossingDistanceKm: 50, hardMaxCrossingDistanceKm: 100, passDistanceMeters: 10000, validateApproachExit: false, rejectOnFail: false, useViaIntermediate: false, displayBeforeMeters: 600, displayAfterMeters: 1100 },
      },
      toHr: {
        label: 'BiH → HR',
        fromLabel: 'Gradiška · BiH prilaz (M6)',
        toLabel: 'Stara Gradiška · HR izlaz',
        approachStart: { lat: 45.13800, lng: 17.25750 },
        borderPoint: { lat: 45.14530, lng: 17.25210 },
        exitPoint: { lat: 45.14850, lng: 17.25100 },
        additionalRoutes: [
          {
            label: 'Iz Vidovdanske',
            description: 'Alternativni prilaz mostu iz Vidovdanske ulice (Gradiška BiH)',
            approachStart: { lat: 45.14250, lng: 17.25900 },
          },
        ],
        routeGuard: { maxCrossingDistanceKm: 50, hardMaxCrossingDistanceKm: 100, passDistanceMeters: 10000, validateApproachExit: false, rejectOnFail: false, useViaIntermediate: false, displayBeforeMeters: 1100, displayAfterMeters: 600 },
      },
    },
  },

  'gornji-varos': {
    id: 'gornji-varos',
    name: 'GP Gornji Varoš',
    shortName: 'Gornji Varoš',
    waits: {
      toBih: { car: 42, truck: 74, bus: 48 },
      toHr: { car: 56, truck: 96, bus: 63 },
    },
    anchors: {
      // Re-calibrated for the new motorway Sava bridge (A5 BiH / D5 HR). Previous
      // borderPoint sat north of the river on the HR mainland which produced a
      // diagonal straight-line fallback because Google's bridge polyline never
      // came within the strict pass distance of an off-bridge anchor.
      toBih: {
        label: 'HR → BiH',
        fromLabel: 'Gornji Varoš · HR prilaz',
        toLabel: 'Gradiška Novi Most · BiH izlaz',
        approachStart: { lat: 45.15050, lng: 17.19700 },
        borderPoint: { lat: 45.14250, lng: 17.20650 },
        exitPoint: { lat: 45.13550, lng: 17.21620 },
        // Same treatment as Gradiška: skip via-intermediate and fail open so the UI
        // prefers Google's road-following polyline over the straight calibrated fallback.
        routeGuard: { maxCrossingDistanceKm: 50, hardMaxCrossingDistanceKm: 100, passDistanceMeters: 10000, validateApproachExit: false, rejectOnFail: false, useViaIntermediate: false, displayBeforeMeters: 2200, displayAfterMeters: 4900, displayCorridor: { requestExtendMeters: 1400, sliceMeters: 1500, fallbackPerSideMeters: 1300, fallbackMaxPerSideMeters: 1700 } },
      },
      toHr: {
        label: 'BiH → HR',
        fromLabel: 'Gradiška Novi Most · BiH prilaz',
        toLabel: 'Gornji Varoš · HR izlaz',
        approachStart: { lat: 45.13550, lng: 17.21620 },
        borderPoint: { lat: 45.14250, lng: 17.20650 },
        exitPoint: { lat: 45.15050, lng: 17.19700 },
        routeGuard: { maxCrossingDistanceKm: 50, hardMaxCrossingDistanceKm: 100, passDistanceMeters: 10000, validateApproachExit: false, rejectOnFail: false, useViaIntermediate: false, displayBeforeMeters: 2200, displayAfterMeters: 4900, displayCorridor: { requestExtendMeters: 1400, sliceMeters: 1500, fallbackPerSideMeters: 1300, fallbackMaxPerSideMeters: 1700 } },
      },
    },
  },
  bijaca: {
    id: 'bijaca',
    name: 'GP Bijača',
    shortName: 'Bijača',
    waits: {
      toBih: { car: 18, truck: 35, bus: 20 },
      toHr: { car: 24, truck: 45, bus: 24 },
    },
    // Production calibration based on OpenStreetMap:
    //   GP Nova Sela (HR, OSM node 6942922065): 43.12359°N, 17.56060°E (border police building on A10)
    //   GP Bijača (BiH,  OSM node 2424868070): 43.12323°N, 17.57493°E (border police building on A1)
    // Both customs sit on the Corridor Vc motorway (A10 HR ↔ A1 BiH), which runs roughly west→east here.
    // Earlier guess anchors (43.08–43.09°N, 17.61–17.63°E) were ~5 km south-east of the real crossing,
    // which let Google snap to the parallel secondary road 6218 through Prudska Draga instead of the
    // motorway. Anchors below are placed on the actual motorway carriageway.
    anchors: {
      // Tighter exit anchors and shorter display windows keep the rendered zone
      // centred on the actual customs buildings, instead of stretching ~1.6 km
      // past the BiH GP marker (previous exitPoint at lng 17.582 was far east of
      // the customs zone, which produced an oversized blue polyline on the map).
      toBih: {
        label: 'HR → BiH',
        fromLabel: 'Nova Sela · HR prilaz',
        toLabel: 'Bijača · BiH izlaz',
        approachStart: { lat: 43.12376, lng: 17.55720 },
        borderPoint: { lat: 43.12340, lng: 17.56780 },
        exitPoint: { lat: 43.12300, lng: 17.57760 },
        // useViaIntermediate: false — Google A1 motorway via constraint produced ZERO_RESULTS,
        // which dropped Bijača into the straight-line calibrated fallback. The free A1 route
        // naturally passes through the border zone. Fail open here because the previous
        // strict guard caused a straight-line fallback that visibly missed the motorway.
        routeGuard: { maxCrossingDistanceKm: 50, hardMaxCrossingDistanceKm: 100, passDistanceMeters: 10000, validateApproachExit: false, rejectOnFail: false, useViaIntermediate: false, displayBeforeMeters: 1000, displayAfterMeters: 1400, displayCorridor: { requestExtendMeters: 1400, sliceMeters: 1500, fallbackPerSideMeters: 1300, fallbackMaxPerSideMeters: 1700 } },
      },
      toHr: {
        label: 'BiH → HR',
        fromLabel: 'Bijača · BiH prilaz',
        toLabel: 'Nova Sela · HR izlaz',
        approachStart: { lat: 43.12300, lng: 17.57760 },
        borderPoint: { lat: 43.12340, lng: 17.56780 },
        exitPoint: { lat: 43.12376, lng: 17.55720 },
        routeGuard: { maxCrossingDistanceKm: 50, hardMaxCrossingDistanceKm: 100, passDistanceMeters: 10000, validateApproachExit: false, rejectOnFail: false, useViaIntermediate: false, displayBeforeMeters: 1000, displayAfterMeters: 1400, displayCorridor: { requestExtendMeters: 1400, sliceMeters: 1500, fallbackPerSideMeters: 1300, fallbackMaxPerSideMeters: 1700 } },
      },
    },
  },
};

const CAMERA_FEEDS = {
  maljevac: [
    { id: 'mal-hak-hr-entry', label: 'Ulaz u HR iz BiH', source: 'HAK', url: 'https://www.hak.hr/info/kamere/429.jpg' },
    { id: 'mal-hak-hr-exit', label: 'Izlaz iz HR u BiH', source: 'HAK', url: 'https://www.hak.hr/info/kamere/430.jpg' },
    {
      id: 'mal-bihamk-kladusa',
      label: 'Velika Kladuša',
      source: 'BIHAMK',
      url: 'https://video-nadzor.bihamk.ba/videosurveillence/AUTOBHS.jpg',
      calibration: {
        roi: { x: 8, y: 9, w: 84, h: 78, rotate: -12 },
        queueAnchor: { x: 73, y: 61 },
        countLine: { x1: 15, y1: 72, x2: 86, y2: 40, label: 'linija prolaska' },
        baselineFrame: { cars: 4, vans: 0, trucks: 0, buses: 0 },
        detections: [
          { type: 'car', label: 'auto', x: 78, y: 63, w: 20, h: 22, confidence: 89, crossed: false },
          { type: 'car', label: 'auto', x: 57, y: 61, w: 18, h: 19, confidence: 91, crossed: true },
          { type: 'car', label: 'auto', x: 43, y: 48, w: 13, h: 14, confidence: 87, crossed: true },
          { type: 'car', label: 'auto', x: 29, y: 32, w: 8, h: 8, confidence: 82, crossed: false }
        ]
      }
    },
  ],
  gradiska: [
    // HAK page k=185 ("BIH Bosanska Gradiška") actually embeds cam.asp?id=404 and 405.
    // The old 185.jpg returned a valid JPEG but of a different camera (k != image id on HAK).
    { id: 'gra-hak-page', label: 'Bosanska Gradiška / HAK', source: 'HAK', url: 'https://m.hak.hr/kamera.asp?g=2&k=185',
      imageUrls: ['https://www.hak.hr/info/kamere/404.jpg', 'https://www.hak.hr/info/kamere/405.jpg'],
      externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=185' },
    { id: 'gra-rs-in', label: 'Ulaz u Republiku Srpsku', source: 'AMS RS', url: 'https://gp.satwork.net/AMSRS_17_GP_CA02/slika.jpg', calibration: {
      roi: { x: 10, y: 18, w: 78, h: 68, rotate: -8 },
      queueAnchor: { x: 62, y: 66 },
      countLine: { x1: 17, y1: 72, x2: 82, y2: 45, label: 'linija prolaska' },
      baselineFrame: { cars: 5, vans: 1, trucks: 1, buses: 0 },
      laneProfiles: { toBih: { eu: 0.5, nonEu: 0.5, euWait: 0.9, nonEuWait: 1.12 }, toHr: { eu: 0.38, nonEu: 0.62, euWait: 0.78, nonEuWait: 1.24 } }
    } },
    { id: 'gra-rs-out', label: 'Izlaz iz Republike Srpske', source: 'AMS RS', url: 'https://gp.satwork.net/AMSRS_17_GP_CA01/slika.jpg', calibration: {
      roi: { x: 9, y: 16, w: 80, h: 70, rotate: -9 },
      queueAnchor: { x: 58, y: 64 },
      countLine: { x1: 15, y1: 73, x2: 85, y2: 42, label: 'linija prolaska' },
      baselineFrame: { cars: 7, vans: 1, trucks: 2, buses: 0 },
      laneProfiles: { toBih: { eu: 0.48, nonEu: 0.52, euWait: 0.88, nonEuWait: 1.14 }, toHr: { eu: 0.34, nonEu: 0.66, euWait: 0.74, nonEuWait: 1.32 } }
    } },
  ],

  'gornji-varos': [
    {
      id: 'gv-hak-queue-9',
      label: 'Gornji Varoš · kamera 9',
      source: 'HAK',
      imageIndex: 0,
      url: 'https://m.hak.hr/kamera.asp?g=2&k=303',
      // FIX: k=303 page embeds cam.asp?id=1021 & 1022 (the real Gornji Varoš images).
      // The old 303.jpg was actually the Vinjani Donji camera (id 303) — wrong location.
      imageUrls: ['https://www.hak.hr/info/kamere/1021.jpg'],
      externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=303',
      calibration: {
        roi: { x: 6, y: 18, w: 82, h: 68, rotate: -11 },
        laneZones: [
          { key: 'nonEu', label: 'Non‑EU', x: 7, y: 25, w: 38, h: 56, rotate: -12 },
          { key: 'eu', label: 'EU', x: 42, y: 24, w: 30, h: 55, rotate: -9 },
        ],
        laneProfiles: {
          toBih: { eu: 0.44, nonEu: 0.56, euWait: 0.84, nonEuWait: 1.18 },
          toHr: { eu: 0.36, nonEu: 0.64, euWait: 0.76, nonEuWait: 1.29 },
        },
        queueAnchor: { x: 28, y: 63 },
        countLine: { x1: 12, y1: 74, x2: 76, y2: 44, label: 'linija prolaska' },
        baselineFrame: { cars: 7, vans: 2, trucks: 1, buses: 0 },
        detections: [
          { type: 'car', label: 'auto', x: 20, y: 71, w: 13, h: 10, confidence: 89, crossed: false },
          { type: 'car', label: 'auto', x: 31, y: 65, w: 12, h: 9, confidence: 88, crossed: false },
          { type: 'van', label: 'kombi', x: 42, y: 59, w: 13, h: 9, confidence: 84, crossed: true },
          { type: 'truck', label: 'kamion', x: 56, y: 52, w: 16, h: 10, confidence: 82, crossed: true },
          { type: 'car', label: 'auto', x: 64, y: 46, w: 10, h: 8, confidence: 86, crossed: true }
        ]
      }
    },
    {
      id: 'gv-hak-plaza-4',
      label: 'Gornji Varoš · zona kontrole',
      source: 'HAK',
      imageIndex: 1,
      url: 'https://m.hak.hr/kamera.asp?g=2&k=303',
      // FIX: second Gornji Varoš HAK frame is cam.asp?id=1022 (was wrongly the 303.jpg = Vinjani Donji).
      imageUrls: ['https://www.hak.hr/info/kamere/1022.jpg'],
      externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=303',
      calibration: {
        roi: { x: 8, y: 18, w: 82, h: 70, rotate: -10 },
        laneZones: [
          { key: 'nonEu', label: 'Non‑EU', x: 9, y: 28, w: 35, h: 54, rotate: -14 },
          { key: 'eu', label: 'EU', x: 44, y: 22, w: 28, h: 58, rotate: -8 },
        ],
        laneProfiles: {
          toBih: { eu: 0.47, nonEu: 0.53, euWait: 0.88, nonEuWait: 1.14 },
          toHr: { eu: 0.34, nonEu: 0.66, euWait: 0.74, nonEuWait: 1.32 },
        },
        queueAnchor: { x: 33, y: 64 },
        countLine: { x1: 15, y1: 74, x2: 82, y2: 38, label: 'linija prolaska' },
        baselineFrame: { cars: 9, vans: 2, trucks: 2, buses: 0 },
      }
    },
  ],
  bijaca: [
    // Nova Sela/Bijača is a grouped HAK page (`k=137`), but the actual
    // still-image IDs are 201 and 202. Using 137/138 returns HAK's red
    // "invalid webcam" placeholder, so keep the public page as the external
    // source and proxy the real JPEG endpoints.
    { id: 'bij-hak-ulaz-hr', label: 'Nova Sela / Bijača · ulaz u HR', source: 'HAK', url: 'https://m.hak.hr/kamera.asp?g=2&k=137', imageIndex: 0,
      imageUrls: ['https://www.hak.hr/info/kamere/201.jpg'],
      externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=137' },
    { id: 'bij-hak-izlaz-hr', label: 'Nova Sela / Bijača · izlaz iz HR', source: 'HAK', url: 'https://m.hak.hr/kamera.asp?g=2&k=137', imageIndex: 1,
      imageUrls: ['https://www.hak.hr/info/kamere/202.jpg'],
      externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=137' },
    { id: 'bij-bihamk-page', label: 'Bijača / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere', matchTexts: ['GP Bijača', 'Bijača', 'Bijaca'] },
  ],
};
// NOTE: server-side CAMERA_FEEDS only contains crossings with a calibrated direct-image
// URL (snapshot counter can run on them). The 10 remaining crossings have HAK iframe
// pages registered in the frontend (src/App.jsx · `externalCamera`) and are shown via
// the camera panel, but they don't feed the wait estimator because there is no
// machine-readable image at those URLs.


function routeAnchors(lat, lng, hrLabel, bihLabel, crossingName) {
  return {
    toBih: {
      label: 'HR → BiH',
      fromLabel: `${hrLabel} · HR prilaz`,
      toLabel: `${bihLabel} · BiH izlaz`,
      approachStart: { lat: lat + 0.009, lng: lng - 0.018 },
      borderPoint: { lat, lng },
      exitPoint: { lat: lat - 0.009, lng: lng + 0.018 },
    },
    toHr: {
      label: 'BiH → HR',
      fromLabel: `${bihLabel} · BiH prilaz`,
      toLabel: `${hrLabel} · HR izlaz`,
      approachStart: { lat: lat - 0.009, lng: lng + 0.018 },
      borderPoint: { lat, lng },
      exitPoint: { lat: lat + 0.009, lng: lng - 0.018 },
    },
  };
}

const DEFAULT_CALIBRATED_ROUTE_GUARD = {
  // Production observation: many crossings (Bijača, Brod, Svilaj, Gornji Varoš, Gradiška,
  // Orašje, etc.) sit on bridges or motorway approaches where Google's chosen
  // origin→border→exit polyline is naturally longer than the calibrated zone — once you
  // include the obligatory exit-ramp loops or town approaches the route can easily run
  // 12–20 km. The route guard's primary safety check is the per-anchor pass-distance
  // (route must pass within `passDistanceMeters` of each calibrated point), so we can
  // safely allow much longer total routes without permitting Google to detour through a
  // wrong parallel road.
  maxCrossingDistanceKm: 10,
  hardMaxCrossingDistanceKm: 26,
  passDistanceMeters: 900,
  validateApproachExit: true,
  displayBeforeMeters: 900,
  displayAfterMeters: 1100,
};

function calibratedRouteGuard(overrides = {}) {
  return { ...DEFAULT_CALIBRATED_ROUTE_GUARD, ...overrides };
}

function calibratedAnchors({ hrLabel, bihLabel, approachHr, borderPoint, exitBih, guard = {}, labels = {} }) {
  const routeGuard = calibratedRouteGuard(guard);
  return {
    toBih: {
      label: labels.toBih || 'HR → BiH',
      fromLabel: labels.hrFrom || `${hrLabel} · HR prilaz kontroli`,
      toLabel: labels.bihTo || `${bihLabel} · BiH izlaz iz kontrole`,
      approachStart: approachHr,
      borderPoint,
      exitPoint: exitBih,
      routeGuard,
    },
    toHr: {
      label: labels.toHr || 'BiH → HR',
      fromLabel: labels.bihFrom || `${bihLabel} · BiH prilaz kontroli`,
      toLabel: labels.hrTo || `${hrLabel} · HR izlaz iz kontrole`,
      approachStart: exitBih,
      borderPoint,
      exitPoint: approachHr,
      routeGuard,
    },
  };
}

// HAK mobile page URLs follow `https://m.hak.hr/kamera.asp?g=2&k=NNN`. IMPORTANT:
// the `k` value is the *page group* id, NOT the still-image id. Each page embeds one
// or more `cam.asp?id=NNN` images, and the matching direct still is
// `https://www.hak.hr/info/kamere/{imageId}.jpg`. Deriving the URL from `k` is therefore
// usually WRONG — `info/kamere/{k}.jpg` returns either HAK's red "invalid webcam"
// placeholder (a ~22.8 kB PNG) or, worse, a valid image of a different crossing.
// We keep the k-derived guess only as a LAST-RESORT fallback (appended, never first),
// so the explicit per-camera imageUrls (the verified image ids) always win.
function hakDirectImageFromPageUrl(url = '') {
  const match = /[?&]k=(\d+)/i.exec(String(url || ''));
  if (!match) return '';
  return `https://www.hak.hr/info/kamere/${match[1]}.jpg`;
}

function withHakImageFallbacks(camera = {}) {
  const url = String(camera.url || '');
  if (!/m\.hak\.hr\/kamera\.asp/i.test(url)) return camera;
  const direct = hakDirectImageFromPageUrl(url);
  if (!direct) return camera;
  const existing = Array.isArray(camera.imageUrls) ? camera.imageUrls : [];
  if (existing.includes(direct)) return camera;
  return {
    ...camera,
    // Append (not prepend): explicit verified imageUrls take priority; the k-derived
    // guess is a final fallback only used when every real image id fails.
    imageUrls: [...existing, direct],
    externalUrl: camera.externalUrl || url,
  };
}

function addCrossing({ id, name, shortName, lat, lng, waits, hrLabel, bihLabel, cameras, anchors }) {
  BORDER_CROSSINGS[id] = {
    id,
    name,
    shortName,
    waits,
    anchors: anchors || routeAnchors(lat, lng, hrLabel, bihLabel, name),
  };
  CAMERA_FEEDS[id] = cameras.map((rawCamera) => {
    const camera = withHakImageFallbacks({ source: 'HAK', ...rawCamera });
    return {
      ...camera,
      calibration: camera.calibration || {
        roi: { x: 14, y: 18, w: 74, h: 66, rotate: -10 },
        queueAnchor: { x: 58, y: 62 },
        countLine: { x1: 14, y1: 74, x2: 86, y2: 40, label: 'linija prolaska' },
        baselineFrame: { cars: 5, vans: 1, trucks: 1, buses: 0 },
      },
    };
  });
}

[
  {
    id: 'orasje', name: 'GP Orašje', shortName: 'Orašje', lat: 45.0434, lng: 18.7030, hrLabel: 'Županja', bihLabel: 'Orašje',
    waits: { toBih: { car: 34, truck: 68, bus: 42 }, toHr: { car: 38, truck: 75, bus: 48 } },
    // Production calibration based on yuga.at/granicni_prelazi (verified against OSM):
    //   GP Županja (HR customs at south edge of Županja, on D7 at the bridge head): 45.04339°N, 18.70299°E
    // The road bridge over Sava runs roughly north→south here. Sava midline (border) lies ~400 m
    // south of HR customs; BiH customs (Orašje) sits ~500 m further south on M1.8.
    // Old anchors had lat 45.066–45.083, which placed everything 2–3 km too far north (inside
    // Županja town), so Google trimmed the polyline to city streets and never showed the bridge.
    anchors: {
      toBih: {
        label: 'HR → BiH',
        fromLabel: 'Županja · HR prilaz kontroli',
        toLabel: 'Orašje · BiH izlaz iz kontrole',
        approachStart: { lat: 45.0508, lng: 18.7028 },
        borderPoint: { lat: 45.0405, lng: 18.7030 },
        exitPoint: { lat: 45.0315, lng: 18.7028 },
        routeGuard: { maxCrossingDistanceKm: 10, hardMaxCrossingDistanceKm: 26, passDistanceMeters: 900, validateApproachExit: true, displayBeforeMeters: 900, displayAfterMeters: 1100, displayCorridor: { requestExtendMeters: 1400, sliceMeters: 1500, fallbackPerSideMeters: 1300, fallbackMaxPerSideMeters: 1700 } },
      },
      toHr: {
        label: 'BiH → HR',
        fromLabel: 'Orašje · BiH prilaz kontroli',
        toLabel: 'Županja · HR izlaz iz kontrole',
        approachStart: { lat: 45.0315, lng: 18.7028 },
        borderPoint: { lat: 45.0405, lng: 18.7030 },
        exitPoint: { lat: 45.0508, lng: 18.7028 },
        routeGuard: { maxCrossingDistanceKm: 10, hardMaxCrossingDistanceKm: 26, passDistanceMeters: 900, validateApproachExit: true, displayBeforeMeters: 900, displayAfterMeters: 1100, displayCorridor: { requestExtendMeters: 1400, sliceMeters: 1500, fallbackPerSideMeters: 1300, fallbackMaxPerSideMeters: 1700 } },
      },
    },
    cameras: [
      // NEEDS VERIFICATION: HAK page k=44 ("Županja") currently embeds no cam.asp image
      // (camera appears offline). 79.jpg returns a valid live JPEG but its framing is unconfirmed
      // as the Županja crossing — verify visually before relying on it for queue detection.
      { id: 'ora-hak-zupanja', label: 'Županja · HR strana', source: 'HAK', url: 'https://www.hak.hr/info/kamere/79.jpg', externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=44' },
      { id: 'ora-hak-bih', label: 'Orašje · BiH strana', source: 'HAK/BIHAMK', url: 'https://www.hak.hr/info/kamere/401.jpg', externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=183' },
      { id: 'ora-amsbih', label: 'Orašje · AMSBiH', source: 'AMSBiH', url: 'https://www.amsbih.ba/amsbih.ba/kamere/kamere/Lokacija20/0Orasje.jpg', externalUrl: 'https://bihamk.ba/spi/kamere' },
    ],
  },
  {
    id: 'brod', name: 'GP Brod', shortName: 'Brod', lat: 45.1529, lng: 18.0034, hrLabel: 'Slavonski Brod', bihLabel: 'Brod',
    waits: { toBih: { car: 30, truck: 72, bus: 40 }, toHr: { car: 46, truck: 88, bus: 58 } },
    // Production calibration based on yuga.at/granicni_prelazi (verified against OSM node 78468446):
    //   GP Slavonski Brod (HR customs at south edge of Slavonski Brod, on the Sava bridge):
    //     45.15286°N, 18.00341°E
    // The road bridge over Sava runs roughly north→south. Sava midline (border) lies ~400 m south
    // of HR customs; BiH customs (Brod) sits ~600 m further south on M17.
    // Old anchors used lng 17.99–18.00 (~700 m too far west), so Google routed via Ulica
    // Pavla Štoosa / Luke Botića through Slavonski Brod city streets instead of crossing the bridge.
    anchors: {
      toBih: {
        label: 'HR → BiH',
        fromLabel: 'Slavonski Brod · HR prilaz kontroli',
        toLabel: 'Brod · BiH izlaz iz kontrole',
        approachStart: { lat: 45.1597, lng: 18.0035 },
        borderPoint: { lat: 45.1497, lng: 18.0033 },
        exitPoint: { lat: 45.1395, lng: 18.0028 },
        routeGuard: { maxCrossingDistanceKm: 10, hardMaxCrossingDistanceKm: 26, passDistanceMeters: 900, validateApproachExit: true, displayBeforeMeters: 950, displayAfterMeters: 1150, displayCorridor: { requestExtendMeters: 1400, sliceMeters: 1500, fallbackPerSideMeters: 1300, fallbackMaxPerSideMeters: 1700 } },
      },
      toHr: {
        label: 'BiH → HR',
        fromLabel: 'Brod · BiH prilaz kontroli',
        toLabel: 'Slavonski Brod · HR izlaz iz kontrole',
        approachStart: { lat: 45.1395, lng: 18.0028 },
        borderPoint: { lat: 45.1497, lng: 18.0033 },
        exitPoint: { lat: 45.1597, lng: 18.0035 },
        routeGuard: { maxCrossingDistanceKm: 10, hardMaxCrossingDistanceKm: 26, passDistanceMeters: 900, validateApproachExit: true, displayBeforeMeters: 950, displayAfterMeters: 1150, displayCorridor: { requestExtendMeters: 1400, sliceMeters: 1500, fallbackPerSideMeters: 1300, fallbackMaxPerSideMeters: 1700 } },
      },
    },
    cameras: [
      // FIX: k=140 ("Slavonski Brod") → cam.asp?id=195/196; k=184 ("BIH Bosanski Brod") → 402/403.
      // The old 140/141/184/185.jpg ids were the page-group ids, not the still-image ids.
      // Ulaz/izlaz direction split is best-effort (needs visual verification on HAK).
      { id: 'bro-hak-sb-ulaz-hr', label: 'Slavonski Brod · ulaz u HR', source: 'HAK', url: 'https://m.hak.hr/kamera.asp?g=2&k=140', imageIndex: 0,
        imageUrls: ['https://www.hak.hr/info/kamere/195.jpg'],
        externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=140' },
      { id: 'bro-hak-sb-izlaz-hr', label: 'Slavonski Brod · izlaz iz HR', source: 'HAK', url: 'https://m.hak.hr/kamera.asp?g=2&k=140', imageIndex: 1,
        imageUrls: ['https://www.hak.hr/info/kamere/196.jpg'],
        externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=140' },
      { id: 'bro-hak-bb-izlaz-hr', label: 'Bosanski Brod · izlaz iz HR u BiH', source: 'HAK/BIHAMK', url: 'https://m.hak.hr/kamera.asp?g=2&k=184', imageIndex: 0,
        imageUrls: ['https://www.hak.hr/info/kamere/402.jpg'],
        externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=184' },
      { id: 'bro-hak-bb-ulaz-hr', label: 'Bosanski Brod · ulaz u HR', source: 'HAK/BIHAMK', url: 'https://m.hak.hr/kamera.asp?g=2&k=184', imageIndex: 1,
        imageUrls: ['https://www.hak.hr/info/kamere/403.jpg'],
        externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=184' },
      { id: 'bro-bihamk', label: 'Brod / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere', matchTexts: ['GP Brod - Izlaz iz BiH', 'GP Brod - Ulaz u BiH', 'GP Brod', 'Bosanski Brod'] },
    ],
  },
  {
    id: 'samac', name: 'GP Šamac', shortName: 'Šamac', lat: 45.06630, lng: 18.49659, hrLabel: 'Slavonski Šamac', bihLabel: 'Šamac',
    waits: { toBih: { car: 22, truck: 44, bus: 26 }, toHr: { car: 28, truck: 54, bus: 32 } },
    // OSM/Mapcarta calibration: Slavonski Šamac HR checkpoint ≈ 45.06630,18.49659; Šamac BiH side ≈ 45.05647,18.49083.
    anchors: calibratedAnchors({
      hrLabel: 'Slavonski Šamac', bihLabel: 'Šamac',
      approachHr: { lat: 45.06630, lng: 18.49659 },
      borderPoint: { lat: 45.06135, lng: 18.49385 },
      exitBih: { lat: 45.05647, lng: 18.49083 },
      guard: { maxCrossingDistanceKm: 9, hardMaxCrossingDistanceKm: 22, passDistanceMeters: 850, displayBeforeMeters: 800, displayAfterMeters: 1000, displayCorridor: { requestExtendMeters: 1400, sliceMeters: 1500, fallbackPerSideMeters: 1300, fallbackMaxPerSideMeters: 1700 } },
    }),
    // FIX: k=300 ("Slavonski Šamac") embeds cam.asp?id=1015/1016. The k-derived 300.jpg was wrong.
    cameras: [{ id: 'sam-hak', label: 'Slavonski Šamac', url: 'https://m.hak.hr/kamera.asp?g=2&k=300', imageUrls: ['https://www.hak.hr/info/kamere/1015.jpg', 'https://www.hak.hr/info/kamere/1016.jpg'] }],
  },
  {
    id: 'svilaj', name: 'GP Svilaj', shortName: 'Svilaj', lat: 45.10810, lng: 18.31310, hrLabel: 'Svilaj', bihLabel: 'Odžak',
    waits: { toBih: { car: 20, truck: 50, bus: 25 }, toHr: { car: 26, truck: 58, bus: 30 } },
    // Corridor Vc bridge calibration: Svilaj HR checkpoint ≈ 45.11475,18.32206; Svilaj/Odžak BiH checkpoint ≈ 45.10147,18.30414.
    // Route extended further along the (straight) Corridor Vc / Sava-bridge axis on BOTH sides so
    // Google draws a route that actually crosses the border instead of stopping at the checkpoint.
    // Endpoints are kept COLLINEAR with the booth so the route guard's pass-distance check holds.
    anchors: calibratedAnchors({
      hrLabel: 'Svilaj', bihLabel: 'Odžak',
      approachHr: { lat: 45.12273, lng: 18.33281 },
      borderPoint: { lat: 45.10810, lng: 18.31310 },
      exitBih: { lat: 45.09351, lng: 18.29339 },
      guard: { maxCrossingDistanceKm: 16, hardMaxCrossingDistanceKm: 34, passDistanceMeters: 1200, displayBeforeMeters: 1600, displayAfterMeters: 1900, displayCorridor: { requestExtendMeters: 1700, sliceMeters: 1800, fallbackPerSideMeters: 1500, fallbackMaxPerSideMeters: 1900 } },
    }),
    cameras: [{
      id: 'svi-hak', label: 'Svilaj',
      url: 'https://m.hak.hr/kamera.asp?g=2&k=211',
      // FIX: k=211 ("Svilaj") embeds cam.asp?id=461/462/463. Old 211.jpg = invalid-webcam placeholder.
      imageUrls: ['https://www.hak.hr/info/kamere/461.jpg', 'https://www.hak.hr/info/kamere/462.jpg', 'https://www.hak.hr/info/kamere/463.jpg'],
      externalUrl: 'https://m.hak.hr/kamera.asp?g=2&k=211',
    }],
  },
  {
    id: 'izacic', name: 'GP Izačić', shortName: 'Izačić', lat: 44.87558, lng: 15.76418, hrLabel: 'Ličko Petrovo Selo', bihLabel: 'Izačić',
    waits: { toBih: { car: 36, truck: 62, bus: 44 }, toHr: { car: 78, truck: 115, bus: 86 } },
    anchors: calibratedAnchors({
      hrLabel: 'Ličko Petrovo Selo', bihLabel: 'Izačić',
      // Anchors extended ~3× out along the road bearing so the line is not a ~0.6 km stub.
      approachHr: { lat: 44.88194, lng: 15.75524 },
      borderPoint: { lat: 44.87558, lng: 15.76418 },
      exitBih: { lat: 44.86889, lng: 15.77159 },
      // FORCED manual corridor: Google's polyline here loops/wiggles off the main road, so we never
      // use it for the display geometry — only a clean calibrated corridor along the M5/Izačić road.
      guard: { maxCrossingDistanceKm: 8, hardMaxCrossingDistanceKm: 20, passDistanceMeters: 1000, displayBeforeMeters: 1500, displayAfterMeters: 1500, displayCorridor: { requestExtendMeters: 1400, sliceMeters: 1500, fallbackPerSideMeters: 1300, fallbackMaxPerSideMeters: 1700 } },
    }),
    cameras: [
      // FIX: k=179 ("BIH Izačić") embeds cam.asp?id=407. Old 179.jpg = invalid-webcam placeholder.
      { id: 'iza-hak-bih', label: 'BIH Izačić', url: 'https://m.hak.hr/kamera.asp?g=2&k=179', imageUrls: ['https://www.hak.hr/info/kamere/407.jpg'] },
      { id: 'iza-bihamk', label: 'Izačić / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere', matchTexts: ['GP Izačić', 'Izačić', 'Izacic'] },
    ],
  },
  {
    id: 'kamensko', name: 'GP Kamensko', shortName: 'Kamensko', lat: 43.61124, lng: 16.97619, hrLabel: 'Kamensko', bihLabel: 'Tomislavgrad',
    waits: { toBih: { car: 24, truck: 48, bus: 28 }, toHr: { car: 31, truck: 56, bus: 34 } },
    anchors: calibratedAnchors({
      hrLabel: 'Kamensko', bihLabel: 'Tomislavgrad',
      approachHr: { lat: 43.61440, lng: 16.96850 },
      borderPoint: { lat: 43.61124, lng: 16.97619 },
      exitBih: { lat: 43.60825, lng: 16.98440 },
      guard: { maxCrossingDistanceKm: 9, hardMaxCrossingDistanceKm: 22, passDistanceMeters: 900, displayBeforeMeters: 850, displayAfterMeters: 1050 },
    }),
    cameras: [
      // FIX: k=192 ("Kamensko") embeds cam.asp?id=317/318/408. The k-derived 192.jpg was wrong.
      { id: 'kam-hak', label: 'Kamensko', url: 'https://m.hak.hr/kamera.asp?g=2&k=192', imageUrls: ['https://www.hak.hr/info/kamere/317.jpg', 'https://www.hak.hr/info/kamere/318.jpg', 'https://www.hak.hr/info/kamere/408.jpg'] },
      { id: 'kam-bihamk', label: 'Kamensko / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere', matchTexts: ['GP Kamensko', 'Kamensko'] },
    ],
  },
  {
    id: 'prisika', name: 'GP Prisika', shortName: 'Prisika', lat: 43.59778, lng: 16.98480, hrLabel: 'Aržano', bihLabel: 'Prisika',
    waits: { toBih: { car: 18, truck: 38, bus: 20 }, toHr: { car: 21, truck: 42, bus: 24 } },
    anchors: calibratedAnchors({
      hrLabel: 'Aržano', bihLabel: 'Prisika',
      approachHr: { lat: 43.59778, lng: 16.98480 },
      borderPoint: { lat: 43.59485, lng: 16.98960 },
      exitBih: { lat: 43.59190, lng: 16.99455 },
      guard: { maxCrossingDistanceKm: 9, hardMaxCrossingDistanceKm: 22, passDistanceMeters: 900, displayBeforeMeters: 800, displayAfterMeters: 1050, displayCorridor: { requestExtendMeters: 1400, sliceMeters: 1500, fallbackPerSideMeters: 1300, fallbackMaxPerSideMeters: 1700 } },
    }),
    cameras: [
      // FIX: k=193 ("Aržano") → cam.asp?id=315/316; k=180 ("BIH Prisika") → cam.asp?id=409.
      // Old 193.jpg / 180.jpg returned the invalid-webcam placeholder.
      { id: 'pri-hak-arzano', label: 'Aržano', url: 'https://m.hak.hr/kamera.asp?g=2&k=193', imageUrls: ['https://www.hak.hr/info/kamere/315.jpg', 'https://www.hak.hr/info/kamere/316.jpg'] },
      { id: 'pri-hak-bih', label: 'BIH Prisika', url: 'https://m.hak.hr/kamera.asp?g=2&k=180', imageUrls: ['https://www.hak.hr/info/kamere/409.jpg'] },
      { id: 'pri-bihamk', label: 'Prisika / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere', matchTexts: ['GP Prisika (Aržano)', 'GP Prisika', 'Prisika', 'Aržano', 'Arzano'] },
    ],
  },
  {
    id: 'vinjani-donji', name: 'GP Vinjani Donji', shortName: 'Vinjani Donji', lat: 43.42261, lng: 17.27443, hrLabel: 'Vinjani Donji', bihLabel: 'Gorica',
    waits: { toBih: { car: 37, truck: 58, bus: 42 }, toHr: { car: 29, truck: 52, bus: 34 } },
    // ROUTE FIX (needs visual verification): the previous control zone was only ~110 m end-to-end,
    // far too short to capture the queue. Approach/exit anchors extended ~330 m along the road
    // bearing and the display window widened. Marker (lat/lng) unchanged.
    anchors: calibratedAnchors({
      hrLabel: 'Vinjani Donji', bihLabel: 'Gorica',
      // Anchors extended ~3× out along the road bearing so the line is not a ~0.9 km stub.
      approachHr: { lat: 43.42781, lng: 17.26285 },
      borderPoint: { lat: 43.42235, lng: 17.27500 },
      exitBih: { lat: 43.41692, lng: 17.28727 },
      guard: { maxCrossingDistanceKm: 7, hardMaxCrossingDistanceKm: 18, passDistanceMeters: 1000, displayBeforeMeters: 1500, displayAfterMeters: 1500 },
    }),
    // FIX: k=39 ("Vinjani Donji") embeds cam.asp?id=302/303. Old 39.jpg = invalid-webcam placeholder.
    cameras: [{ id: 'vd-hak', label: 'Vinjani Donji', url: 'https://m.hak.hr/kamera.asp?g=2&k=39', imageUrls: ['https://www.hak.hr/info/kamere/302.jpg', 'https://www.hak.hr/info/kamere/303.jpg'] }],
  },
  {
    id: 'vinjani-gornji', name: 'GP Vinjani Gornji', shortName: 'Vinjani Gornji', lat: 43.45998, lng: 17.28453, hrLabel: 'Vinjani Gornji', bihLabel: 'Orahovlje',
    waits: { toBih: { car: 24, truck: 42, bus: 28 }, toHr: { car: 27, truck: 46, bus: 30 } },
    // ROUTE FIX (needs visual verification): the previous control zone was only ~300 m end-to-end
    // (approach == marker), so Google often returned a too-short / straight-line polyline that did
    // not follow the road toward the crossing and missed the real queue. The approach (HR) and
    // exit (BiH) anchors below are extended ~350 m further out along the established road bearing
    // (NW→SE), and the display window is widened so the rendered "provjerena zona" captures the
    // column on both sides of the border. Marker (lat/lng) is unchanged.
    anchors: calibratedAnchors({
      hrLabel: 'Vinjani Gornji', bihLabel: 'Orahovlje',
      // Anchors extended ~2.2× further out along the established NW→SE road bearing so the Google
      // route is no longer a ~0.7 km stub that barely reaches the border. approachHr (HR) and
      // exitBih (BiH) are pushed out; the marker and borderPoint are unchanged. Verified live that
      // the route now threads the border and crosses into BiH like the other crossings.
      approachHr: { lat: 43.46348, lng: 17.27407 },
      borderPoint: { lat: 43.45945, lng: 17.28610 },
      exitBih: { lat: 43.45549, lng: 17.29809 },
      // FORCED manual corridor: Google often returns a one-sided / non-crossing polyline here, so the
      // clean calibrated corridor (HR approach → border → BiH exit) is always used for the display.
      guard: { maxCrossingDistanceKm: 8, hardMaxCrossingDistanceKm: 20, passDistanceMeters: 1000, displayBeforeMeters: 1600, displayAfterMeters: 1600, displayCorridor: { requestExtendMeters: 1400, sliceMeters: 1500, fallbackPerSideMeters: 1300, fallbackMaxPerSideMeters: 1700 } },
    }),
    // FIX: k=282 ("Vinjani Gornji") embeds cam.asp?id=994/995. Old 282.jpg = invalid-webcam placeholder.
    cameras: [{ id: 'vg-hak', label: 'Vinjani Gornji', url: 'https://m.hak.hr/kamera.asp?g=2&k=282', imageUrls: ['https://www.hak.hr/info/kamere/994.jpg', 'https://www.hak.hr/info/kamere/995.jpg'] }],
  },
  {
    id: 'crveni-grm', name: 'GP Crveni Grm', shortName: 'Crveni Grm', lat: 43.16035, lng: 17.47755, hrLabel: 'Prolog', bihLabel: 'Crveni Grm',
    waits: { toBih: { car: 26, truck: 48, bus: 30 }, toHr: { car: 33, truck: 54, bus: 36 } },
    anchors: calibratedAnchors({
      hrLabel: 'Prolog', bihLabel: 'Crveni Grm',
      // Anchors were extremely tight (~130 m each side → 0.3 km line); extended ~4× out along the
      // road bearing so the rendered route reaches well into HR and crosses into BiH.
      approachHr: { lat: 43.15575, lng: 17.47495 },
      borderPoint: { lat: 43.16035, lng: 17.47755 },
      exitBih: { lat: 43.16511, lng: 17.48119 },
      guard: { maxCrossingDistanceKm: 8, hardMaxCrossingDistanceKm: 20, passDistanceMeters: 1000, displayBeforeMeters: 1500, displayAfterMeters: 1500 },
    }),
    cameras: [
      // FIX: k=181 ("BIH Crveni Grm") embeds cam.asp?id=410. Old 181.jpg = invalid-webcam placeholder.
      { id: 'cg-hak-bih', label: 'BIH Crveni Grm', url: 'https://m.hak.hr/kamera.asp?g=2&k=181', imageUrls: ['https://www.hak.hr/info/kamere/410.jpg'] },
      { id: 'cg-bihamk', label: 'Crveni Grm / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere', matchTexts: ['GP Crveni Grm', 'Crveni Grm'] },
    ],
  },
].forEach(addCrossing);

// ── Camera direction safety (intelligence spec §2) ────────────────────────────
// A camera frame physically shows ONE side of the border. Feeding the same frame
// into BOTH directions contaminates the opposite direction's wait. We derive each
// camera's valid direction from its Croatian label ("ulaz u HR" = entering HR =
// toHr; "izlaz iz HR" / "ulaz u BiH/RS" = toBih). If the direction cannot be
// proven from the label (a wide/ambiguous shot) the camera becomes `visualOnly`
// and NEVER enters the hard wait calculation — it can still be shown to the user.
function inferCameraDirections(camera = {}) {
  if (Array.isArray(camera.validForDirections) && camera.validForDirections.length) return camera.validForDirections;
  const text = `${camera.id || ''} ${camera.label || ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const entersHr = /ulaz u hr|ulaz u hrv|izlaz iz bih|izlaz iz rs|izlaz iz republike|bih ?-> ?hr|bih ?→ ?hr/.test(text);
  const entersBih = /izlaz iz hr|ulaz u bih|ulaz u rs|ulaz u republik|hr ?-> ?bih|hr ?→ ?bih/.test(text);
  if (entersHr && !entersBih) return ['toHr'];
  if (entersBih && !entersHr) return ['toBih'];
  return null; // unprovable → visualOnly
}

// A camera is "wait-capable by configuration" only with an explicit calibrated queue ROI
// (a lane/queue region, anchor or zones) — NOT the default full-frame fallback (spec §5).
function cameraHasQueueRoi(camera = {}) {
  const cal = camera.calibration || {};
  return Boolean(cal.roi || cal.queueAnchor || (Array.isArray(cal.laneZones) && cal.laneZones.length));
}

// A camera is RELEVANT to a direction for DISPLAY (band, vehicle mix) when it either has no
// declared direction (ambiguous — could show either side) or is explicitly valid for it. A
// camera declared ONLY for the opposite direction must NOT bleed its queue into this direction
// (the Maljevac bug: the "izlaz iz HR" queue showing as "ekstremna kolona" on the BiH→HR card).
function cameraRelevantForDirection(camera = {}, direction = 'toBih', allCameras = []) {
  const v = camera.validForDirections;
  if (Array.isArray(v) && v.length > 0) return v.includes(direction);

  // Ambiguous visual-only cameras are useful only when we have no direction-specific camera
  // for this side. If a crossing has explicit entry/exit cameras, allowing a wide/unknown
  // frame into both display aggregates makes a queue from one side appear in BOTH directions.
  // This is display/fusion hygiene only; ambiguous cameras still show in the image grid/admin.
  const hasDirectionSpecificCamera = Array.isArray(allCameras) && allCameras.some((candidate) => {
    const dirs = candidate?.validForDirections;
    return Array.isArray(dirs) && dirs.includes(direction);
  });
  return !hasDirectionSpecificCamera;
}

function applyCameraDirectionSafety() {
  for (const feeds of Object.values(CAMERA_FEEDS)) {
    for (const camera of feeds) {
      const inferred = inferCameraDirections(camera);
      if (inferred) {
        camera.validForDirections = inferred;
        camera.queueDirection = camera.queueDirection || inferred[0];
        if (camera.visualOnly === undefined) camera.visualOnly = false;
      } else {
        // Cannot prove which side this camera shows → visual-only (no hard wait).
        camera.validForDirections = camera.validForDirections || [];
        camera.visualOnly = true;
      }
    }
  }
}
applyCameraDirectionSafety();

const cameraEvents = [];
const cameraSnapshotBuffer = [];
const cvEndpoint = process.env.CAMERA_CV_ENDPOINT || '';
const cvApiKey = process.env.CAMERA_CV_API_KEY || '';
// CV/YOLO is ENABLED by default whenever an endpoint is configured (set CAMERA_CV_ENABLED=false to
// force off). Timeout is short so a slow model never blocks the camera pipeline — on timeout/error
// we always fall back to the heuristic.
const CAMERA_CV_ENABLED = process.env.CAMERA_CV_ENABLED
  ? process.env.CAMERA_CV_ENABLED === 'true'
  : Boolean(cvEndpoint);
// On Railway/CPU the first YOLO inference is slow even with a pre-warmed model, so give it room
// before falling back to the heuristic. Once warm, inference is well under a second.
const CAMERA_CV_TIMEOUT_MS = Math.max(800, Number(process.env.CAMERA_CV_TIMEOUT_MS || 6000));
// ── Traffic + Vision prediction layer v2 (the differentiator) feature flags ─────────────────────
// PREDICTION_V2 OFF by default → v2 runs in SHADOW (computed + attached as signal.predictionV2 for
// admin/debug/UI breakdown) but the headline wait still uses the proven legacy fusion. Flip it on
// once validated. Any v2 failure is caught and falls back to legacy — never crashes the estimate.
const PREDICTION_V2_ENABLED = process.env.PREDICTION_V2_ENABLED === 'true';
const GOOGLE_TRAFFIC_V2_ENABLED = process.env.GOOGLE_TRAFFIC_V2_ENABLED !== 'false';
const YOLO_ROI_V2_ENABLED = process.env.YOLO_ROI_V2_ENABLED !== 'false';
const TRAFFIC_VISION_DEBUG = process.env.TRAFFIC_VISION_DEBUG === 'true';
const CAMERA_YOLO_MULTI_FRAME_ENABLED = process.env.CAMERA_YOLO_MULTI_FRAME_ENABLED === 'true';
const CAMERA_YOLO_FRAME_COUNT = Math.max(1, Math.min(5, Number(process.env.CAMERA_YOLO_FRAME_COUNT || 3)));
const CAMERA_YOLO_FRAME_GAP_MS = Math.max(500, Number(process.env.CAMERA_YOLO_FRAME_GAP_MS || 2500));
const CAMERA_YOLO_MULTI_FRAME_TIMEOUT_MS = Math.max(2000, Number(process.env.CAMERA_YOLO_MULTI_FRAME_TIMEOUT_MS || 12000));
// ROI v2 config + internal editor/debug tools (NOT user-facing). Editor endpoints answer 404/disabled
// unless TRAFFIC_VISION_DEBUG=true (+ optional x-debug-token). Reading ROI config is on by default.
const YOLO_ROI_CONFIG_ENABLED = process.env.YOLO_ROI_CONFIG_ENABLED !== 'false';
const YOLO_ROI_EDITOR_ENABLED = process.env.YOLO_ROI_EDITOR_ENABLED === 'true';
const TRAFFIC_VISION_DEBUG_TOKEN = process.env.TRAFFIC_VISION_DEBUG_TOKEN || '';
const TRAFFIC_VISION_MIN_ROI_COVERAGE_PERCENT = Math.max(0, Math.min(100, Number(process.env.TRAFFIC_VISION_MIN_ROI_COVERAGE_PERCENT || 70)));
const TRAFFIC_VISION_MAX_FALLBACK_RATE = Math.max(0, Math.min(1, Number(process.env.TRAFFIC_VISION_MAX_FALLBACK_RATE || 0.25)));
const TRAFFIC_VISION_MIN_SNAPSHOTS_24H = Math.max(0, Number(process.env.TRAFFIC_VISION_MIN_SNAPSHOTS_24H || 100));
const TRAFFIC_VISION_MAX_MEDIAN_ERROR_MIN = Math.max(0, Number(process.env.TRAFFIC_VISION_MAX_MEDIAN_ERROR_MIN || 7));
const TRAFFIC_VISION_MAX_P90_ERROR_MIN = Math.max(0, Number(process.env.TRAFFIC_VISION_MAX_P90_ERROR_MIN || 15));
// YOLO + ROI (V5 §6). OFF by default — must be explicitly enabled, and even then it only
// REPLACES the vehicle-detection step; the wait still flows through the same evidence-cap,
// direction/ROI gate and confidence calibration. If the model/runtime is unavailable the
// pipeline silently falls back to the existing heuristic (system must never crash).
// Turn-key: when a CV/YOLO endpoint is configured, YOLO is ON by default (its detections replace
// the pixel heuristic for counts + band). Set YOLO_ENABLED=false to force it off even with an
// endpoint, or =true to force on. (Driving the WAIT from YOLO additionally needs per-camera ROI +
// YOLO_FUSION_ENABLED + allowlist; without ROI, YOLO still improves the counts/band.)
const YOLO_ENABLED = process.env.YOLO_ENABLED
  ? process.env.YOLO_ENABLED === 'true'
  : Boolean(process.env.YOLO_ENDPOINT || process.env.CAMERA_CV_ENDPOINT);
// Shadow mode: run YOLO and record its result for comparison, but NEVER use it for the wait.
// Lets us validate YOLO against the heuristic in production with zero risk before enabling it.
// YOLO_SHADOW_ENABLED is the standardized name; YOLO_SHADOW_MODE kept as a back-compat alias.
const YOLO_SHADOW_MODE = process.env.YOLO_SHADOW_ENABLED === 'true' || process.env.YOLO_SHADOW_MODE === 'true';
// Controlled fusion (V6 §11): YOLO may drive the wait ONLY when explicitly enabled AND the
// camera is on the per-camera fusion allowlist AND eligible. Default OFF in production.
const YOLO_FUSION_ENABLED = process.env.YOLO_FUSION_ENABLED === 'true';
const parseList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const YOLO_SHADOW_ALLOWLIST = parseList(process.env.YOLO_SHADOW_CAMERA_ALLOWLIST);
const YOLO_FUSION_ALLOWLIST = parseList(process.env.YOLO_FUSION_CAMERA_ALLOWLIST);
const YOLO_MAX_LATENCY_MS = Math.max(500, Number(process.env.YOLO_MAX_LATENCY_MS || 8000));
const YOLO_REQUIRE_ROI = process.env.YOLO_REQUIRE_ROI !== 'false';
const YOLO_REQUIRE_DIRECTION = process.env.YOLO_REQUIRE_DIRECTION !== 'false';
const YOLO_REQUIRE_COUNTLINE = process.env.YOLO_REQUIRE_COUNTLINE !== 'false';
const yoloEndpoint = process.env.YOLO_ENDPOINT || process.env.CAMERA_CV_ENDPOINT || '';
const yoloApiKey = process.env.YOLO_API_KEY || process.env.CAMERA_CV_API_KEY || '';
const YOLO_TIMEOUT_MS = Math.max(1500, Number(process.env.YOLO_TIMEOUT_MS || 6000));
const YOLO_MIN_CONFIDENCE = Math.max(1, Math.min(99, Number(process.env.YOLO_MIN_CONFIDENCE || 35)));
const CAMERA_SNAPSHOT_COUNTING_ENABLED = process.env.CAMERA_SNAPSHOT_COUNTING_ENABLED !== 'false';
const CAMERA_SNAPSHOT_TIMEOUT_MS = Math.max(1500, Number(process.env.CAMERA_SNAPSHOT_TIMEOUT_MS || 4500));
const CAMERA_SNAPSHOT_MIN_CONFIDENCE = Math.max(35, Math.min(95, Number(process.env.CAMERA_SNAPSHOT_MIN_CONFIDENCE || 46)));
const CAMERA_SNAPSHOT_REFRESH_INTERVAL_MS = Math.max(2, Number(process.env.CAMERA_SNAPSHOT_REFRESH_INTERVAL_MINUTES || 5)) * 60 * 1000;

// ── BOUNDED CV/CAMERA CONCURRENCY (production scaling safety) ──────────────────────────────────
// As we add crossings/cameras, a full refresh must not fire every camera + YOLO call at once. Two
// limits: how many (crossing,direction) jobs a refresh runs in parallel, and a GLOBAL cap on how
// many YOLO inferences hit the cv-detector at once (so it never gets an inference storm / OOM).
const CAMERA_REFRESH_CONCURRENCY = Math.max(1, Number(process.env.CAMERA_REFRESH_CONCURRENCY || 3));
const CAMERA_CV_CONCURRENCY = Math.max(1, Number(process.env.CAMERA_CV_CONCURRENCY || 2));
// Minimal async semaphore: acquire() resolves when a slot is free; release() frees one. Tracks
// active/queued depth for the readiness/debug endpoints.
class AsyncSemaphore {
  constructor(max) { this.max = Math.max(1, max); this.active = 0; this._queue = []; }
  get queued() { return this._queue.length; }
  async acquire() {
    if (this.active < this.max) { this.active += 1; return; }
    await new Promise((resolve) => this._queue.push(resolve));
    this.active += 1;
  }
  release() { this.active -= 1; const next = this._queue.shift(); if (next) next(); }
  async run(fn) { await this.acquire(); try { return await fn(); } finally { this.release(); } }
}
const cvInferenceSemaphore = new AsyncSemaphore(CAMERA_CV_CONCURRENCY);

const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyPrefix: 'auth' });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 45, keyPrefix: 'write' });
// Anonymous measured-wait can be started without an account, so it gets its own,
// tighter public limiter (one device should not be able to open dozens of sessions).
const publicWriteLimiter = rateLimit({ windowMs: 60 * 1000, max: 12, keyPrefix: 'public-write' });

// ── Accuracy / measured-wait / alerts in-memory stores ────────────────────────
// In json-file mode these live in memory (and are the source of truth); in postgres
// mode they are mirrored to the borderflow_* tables added in 001_schema.sql.
const predictionAccuracyBuffer = []; // { id, crossingId, direction, predictedWait, actualWait, confidenceLevel, confidenceScore, sourceMix, predictedAt, resolvedAt, source }
const measuredSessionBuffer = [];    // { id, crossingId, direction, userId, anonymous, predictedWaitAtStart, actualWait, gpsVerified, startGps, endGps, status, startedAt, finishedAt }
// Live-location wait sessions (subtle "Moja lokacija" signal). NO raw GPS trail is stored — only the
// lifecycle status + the server-measured A→B wait. Capped buffer; persisted to DB in postgres mode.
const locationWaitSessionBuffer = [];
const VERIFIED_LOCATION_ENABLED = process.env.VERIFIED_LOCATION_ENABLED === 'true';
// Optional per-crossing allow-list. Empty/unset = all crossings (when globally enabled). When set
// (comma-separated ids, e.g. "maljevac"), verified A→B is armed ONLY for those crossings — the way
// to roll the feature out to the flagship crossing first without touching the others.
const VERIFIED_LOCATION_CROSSINGS = String(process.env.VERIFIED_LOCATION_CROSSINGS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
function verifiedLocationEnabledFor(crossingId) {
  if (!VERIFIED_LOCATION_ENABLED) return false;
  if (!VERIFIED_LOCATION_CROSSINGS.length) return true;
  return VERIFIED_LOCATION_CROSSINGS.includes(String(crossingId || '').trim().toLowerCase());
}
const LOCATION_WAIT_MAX_ACCURACY_M = Math.max(20, Number(process.env.LOCATION_WAIT_MAX_ACCURACY_M || 100));
const LOCATION_WAIT_PING_MIN_INTERVAL_MS = Math.max(0, Number(process.env.LOCATION_WAIT_PING_MIN_INTERVAL_SECONDS ?? 20)) * 1000;
const LOCATION_WAIT_SESSION_MAX_MS = Math.max(10, Number(process.env.LOCATION_WAIT_SESSION_MAX_MINUTES || 240)) * 60 * 1000;
const LOCATION_WAIT_SIGNAL_MAX_AGE_MINUTES = Math.max(5, Number(process.env.LOCATION_WAIT_SIGNAL_MAX_AGE_MINUTES || 45));
const LOCATION_WAIT_HASH_SALT = process.env.LOCATION_WAIT_HASH_SALT || sessionSecret || 'borderflow-loc-salt';
const alertSubscriptionBuffer = [];  // { id, userId, crossingId, direction, dropBelow, riseAbove, pushToken, active, createdAt }
const alertEventBuffer = [];         // recent alert events (push-ready payloads)
const lastWaitForAlerts = new Map(); // key → last displayed wait, for transition detection
const lastPredictionSampleAt = new Map(); // key → ms of last sampled prediction
const PREDICTION_SAMPLE_INTERVAL_MS = Math.max(2, Number(process.env.PREDICTION_SAMPLE_INTERVAL_MINUTES || 10)) * 60 * 1000;
const PREDICTION_MATCH_WINDOW_MS = 3 * 60 * 60 * 1000; // a measured wait can resolve a prediction up to 3h old

// Build a measured-wait geofence for a crossing/direction from its calibrated route
// anchors (approachStart = where you join the queue, borderPoint = the booth, exitPoint =
// just past it). Used to GPS-verify measured sessions and to auto start/stop from pings.
const GEOFENCE_APPROACH_RADIUS_M = Math.max(300, Number(process.env.GEOFENCE_APPROACH_RADIUS_M || 1300));
const GEOFENCE_BORDER_RADIUS_M = Math.max(120, Number(process.env.GEOFENCE_BORDER_RADIUS_M || 350));
const GEOFENCE_EXIT_RADIUS_M = Math.max(150, Number(process.env.GEOFENCE_EXIT_RADIUS_M || 500));

function geofenceForCrossing(crossing, direction = 'toBih') {
  const anchors = crossing?.anchors?.[direction];
  if (!anchors?.approachStart || !anchors?.borderPoint) return null;
  return {
    crossingId: crossing.id,
    direction,
    approach: anchors.approachStart,
    border: anchors.borderPoint,
    exit: anchors.exitPoint || anchors.borderPoint,
    approachRadiusM: GEOFENCE_APPROACH_RADIUS_M,
    borderRadiusM: GEOFENCE_BORDER_RADIUS_M,
    exitRadiusM: GEOFENCE_EXIT_RADIUS_M,
  };
}

// Find the crossing/direction whose approach or border geofence a GPS point falls in.
// Used by the auto start/stop ping endpoint. Returns the closest match by booth distance.
function locateCrossingForPoint(point) {
  let best = null;
  for (const crossing of Object.values(BORDER_CROSSINGS)) {
    for (const direction of ['toBih', 'toHr']) {
      const fence = geofenceForCrossing(crossing, direction);
      if (!fence) continue;
      const zone = locateInGeofence(point, fence);
      if (zone === 'far') continue;
      const dist = haversineMeters(point, fence.border);
      if (!best || (dist !== null && dist < best.dist)) best = { crossing, direction, fence, zone, dist: dist ?? Infinity };
    }
  }
  return best;
}

// Validate a {lat,lng} GPS payload; returns null when missing or out of range.
function sanitizeGps(gps) {
  if (!gps || typeof gps !== 'object') return null;
  const lat = Number(gps.lat);
  const lng = Number(gps.lng ?? gps.lon ?? gps.long);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

// Optional auth: populate req.user when a valid token is present, but never block.
// Used by measured-wait so both anonymous and logged-in drivers can contribute.
async function optionalAuth(req, _res, next) {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token) req.user = await verifyToken(token);
  } catch { /* ignore — anonymous */ }
  return next();
}

// Full prediction metadata (spec V5 §7 B) — enough to later PROVE which kinds of estimates,
// which sources and which confidence buckets were actually accurate.
function signalSourceMix(signal = {}) {
  return {
    sourceType: signal.sourceType,
    sourceAuthorityTier: signal.explanationPayload?.authorityTier || null,
    hasCamera: Boolean(signal.hasCameraSignal),
    hasGoogle: Boolean(signal.hasGoogleSignal),
    hasHardPublic: Boolean(signal.hasHardPublicSignal),
    hasMeasured: Boolean(signal.hasMeasuredSession),
    hasConflict: Boolean(signal.explanationPayload?.conflict?.detected),
    cameraStale: Boolean(signal.explanationPayload?.sources?.some((s) => s.kind === 'camera' && (s.flags || []).some((f) => /zastarjel/.test(f)))),
    googleOnly: signal.explanationPayload?.googleAsAuthority === true,
    sourceCount: signal.independentSources ?? null,
    calibrationVersion: CALIBRATION_VERSION,
    // ── Calibration debug fields (what each signal said, so evaluation can attribute error) ──────
    googleTrafficSeverity: signal.googleTrafficSeverity || signal.googleTraffic?.severity || null,
    googleDelayMin: Number.isFinite(Number(signal.googleTraffic?.delayMin)) ? Number(signal.googleTraffic.delayMin) : null,
    visualBand: signal.visualBand || null,
    conflictKind: signal.conflictKind || null,
    hasStrongCameraQueue: Boolean(signal.hasStrongCameraQueue),
    finalLabel: signal.label || null,
    confidenceLevel: signal.confidenceLevel || null,
    // Camera count + trust at prediction time → when this sample later resolves against a measured
    // ground truth, the (count → measuredWait) pair feeds the count→wait calibration.
    cameraVehiclesInQueueRoi: Number.isFinite(Number(signal.predictionV2?.sourceBreakdown?.yoloCamera?.vehiclesInQueueRoi))
      ? Number(signal.predictionV2.sourceBreakdown.yoloCamera.vehiclesInQueueRoi) : null,
    cameraRoiTrusted: Boolean(signal.predictionV2?.sourceBreakdown?.yoloCamera?.roiTrusted),
  };
}

// Record a sampled prediction (predicted wait + confidence + which sources fed it).
// Sampling avoids flooding: at most once per (crossing,direction) per interval.
function recordPredictionSample(crossingId, direction, signal) {
  const key = `${crossingId}:${direction}`;
  const now = Date.now();
  if (signal.displayReady === false || !Number.isFinite(Number(signal.wait))) return;
  if (now - (lastPredictionSampleAt.get(key) || 0) < PREDICTION_SAMPLE_INTERVAL_MS) return;
  lastPredictionSampleAt.set(key, now);
  predictionAccuracyBuffer.unshift({
    id: crypto.randomUUID(),
    crossingId,
    direction,
    predictedWait: Number(signal.wait),
    actualWait: null,
    confidenceLevel: signal.confidenceLevel || null,
    confidenceScore: signal.confidenceScore ?? signal.confidence ?? null,
    sourceMix: signalSourceMix(signal),
    predictedAt: new Date().toISOString(),
    resolvedAt: null,
    source: 'state-sample',
  });
  persistPredictionAccuracy(predictionAccuracyBuffer[0]).catch(() => {});
  while (predictionAccuracyBuffer.length > 20000) predictionAccuracyBuffer.pop();
}

// Close the loop: when a real (measured) wait arrives, store a resolved accuracy record.
// We compare the actual against the prediction captured when the driver JOINED the queue
// (the truest measure of "was our estimate right when it mattered").
function recordResolvedAccuracy({ crossingId, direction, predictedWait, actualWait, confidenceLevel = null, confidenceScore = null, sourceMix = {}, source = 'measured-session' }) {
  predictionAccuracyBuffer.unshift({
    id: crypto.randomUUID(),
    crossingId,
    direction,
    predictedWait: Number.isFinite(Number(predictedWait)) ? Number(predictedWait) : null,
    actualWait: Number.isFinite(Number(actualWait)) ? Number(actualWait) : null,
    confidenceLevel,
    confidenceScore,
    sourceMix: sourceMix || {},
    predictedAt: new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    source,
  });
  persistPredictionAccuracy(predictionAccuracyBuffer[0]).catch(() => {});
  while (predictionAccuracyBuffer.length > 20000) predictionAccuracyBuffer.pop();
  refreshBiasModel();
  refreshCalibrationModel();
}

function recentResolvedAccuracy(hours = 24 * 14) {
  const since = Date.now() - hours * 60 * 60 * 1000;
  return predictionAccuracyBuffer.filter((r) => r.actualWait !== null && new Date(r.predictedAt).getTime() >= since);
}

// ── COUNT → WAIT CALIBRATION (learned per crossing+direction; falls back to heuristic until ready) ──
// Samples come from resolved predictions that had a TRUSTED camera count at the time — when they
// resolve against a measured ground truth we get (count → measuredWait) pairs. Recomputed lazily +
// cached. Until a crossing has enough low-error samples it stays UNcalibrated → heuristic is used.
const CAMERA_CALIBRATION_MIN_SAMPLES = Math.max(4, Number(process.env.CAMERA_CALIBRATION_MIN_SAMPLES || 6));
const CAMERA_CALIBRATION_MAX_MAE = Math.max(5, Number(process.env.CAMERA_CALIBRATION_MAX_MAE || 18));
const CAMERA_CALIBRATION_WINDOW_HOURS = Math.max(24, Number(process.env.CAMERA_CALIBRATION_WINDOW_HOURS || 24 * 60));
let calibrationModelsCache = {};
let calibrationModelsAt = 0;
function recomputeCalibrationModels() {
  const records = recentResolvedAccuracy(CAMERA_CALIBRATION_WINDOW_HOURS)
    .filter((r) => r.sourceMix && r.sourceMix.cameraRoiTrusted && Number.isFinite(Number(r.sourceMix.cameraVehiclesInQueueRoi)))
    .map((r) => ({ crossingId: r.crossingId, direction: r.direction, cameraCount: Number(r.sourceMix.cameraVehiclesInQueueRoi), actualWait: Number(r.actualWait) }));
  calibrationModelsCache = buildCalibrationModels(records, { minSamples: CAMERA_CALIBRATION_MIN_SAMPLES, maxMae: CAMERA_CALIBRATION_MAX_MAE });
  calibrationModelsAt = Date.now();
  return calibrationModelsCache;
}
function getCalibrationModel(crossingId, direction) {
  if (Date.now() - calibrationModelsAt > 5 * 60 * 1000) recomputeCalibrationModels();
  return calibrationModelsCache[calibrationKey(crossingId, direction)] || null;
}

// Learned bias model (spec V5 §2). Recomputed from resolved accuracy. Application into the
// live estimate is OFF by default — it only kicks in once there is enough measured data and
// the operator explicitly enables it, so we never "correct" toward a handful of samples.
const BIAS_CORRECTION_ENABLED = process.env.BIAS_CORRECTION_ENABLED === 'true';
const BIAS_MIN_SAMPLE = Math.max(3, Number(process.env.BIAS_MIN_SAMPLE || 8));
const BIAS_MAX_ADJUST_MIN = Math.max(5, Number(process.env.BIAS_MAX_ADJUST_MIN || 20));
let biasModel = computeBiasCorrection([], { minSample: BIAS_MIN_SAMPLE });
function refreshBiasModel() {
  biasModel = computeBiasCorrection(recentResolvedAccuracy(), { minSample: BIAS_MIN_SAMPLE });
}

// Empirical confidence calibration model (spec V5 §7). Recomputed from resolved accuracy.
// Always "on": with no data it degrades gracefully (can never grant HIGH without proof).
let calibrationModel = computeCalibrationModel([]);
function refreshCalibrationModel() {
  calibrationModel = computeCalibrationModel(recentResolvedAccuracy());
}

// Resolve the FINAL confidence: start from the heuristic profile level, apply structural
// downgrade rules (§7 D), then let the empirical calibration model have the last word — it
// may only lower, never raise, and HIGH is impossible without proven historical accuracy.
const CONF_ORDER = ['nedovoljno', 'niska', 'srednja', 'visoka'];
function resolveCalibratedConfidence(profile, ctx) {
  const downgraded = applyConfidenceDowngrades(profile.level, ctx);
  const calibrated = calibrationModel.calibratedConfidence(downgraded.level, { crossingId: ctx.crossingId, direction: ctx.direction, sourceMix: ctx.sourceMix });
  const level = CONF_ORDER[Math.min(CONF_ORDER.indexOf(downgraded.level), CONF_ORDER.indexOf(calibrated.level))];
  const precision = level === 'visoka' ? 'exact' : 'range';
  // Score: empirical when calibration has data; otherwise reflect the heuristic profile
  // score (so finer signal differences — e.g. stale vs fresh camera — still show) but cap
  // it by the resolved level so a no-data confidence can never imply HIGH.
  let score = Math.round((calibrated.score ?? 0.5) * 100);
  if (!calibrated.hasData) {
    const levelCap = level === 'visoka' ? 95 : level === 'srednja' ? 69 : level === 'niska' ? 44 : 20;
    score = Math.min(levelCap, Math.round(Number(profile.score) || 0));
  }
  return {
    level,
    score,
    precision,
    basis: calibrated.basis,
    sampleSize: calibrated.sampleSize,
    bucketMetrics: calibrated.bucketMetrics,
    hasData: calibrated.hasData,
    reasons: [...downgraded.reasons, ...calibrated.reasons],
  };
}
// Apply a clamped, sufficient-sample correction to a live wait. Returns the (possibly
// unchanged) wait plus metadata for the explanation layer.
function applyBiasCorrection(crossingId, direction, wait) {
  if (!BIAS_CORRECTION_ENABLED || !Number.isFinite(Number(wait))) return { wait, applied: false };
  const corr = biasModel.correctionFor(crossingId, direction, new Date().getHours());
  if (!corr || corr.basis === 'insufficient' || corr.n < BIAS_MIN_SAMPLE || !corr.correctionMin) return { wait, applied: false };
  const adjust = clampWait(Math.max(-BIAS_MAX_ADJUST_MIN, Math.min(BIAS_MAX_ADJUST_MIN, corr.correctionMin)));
  return { wait: clampWait(Number(wait) + adjust), applied: true, adjustMin: adjust, basis: corr.basis, n: corr.n };
}

// ── POSTGRES PERSISTENCE (spec V5 §5) ─────────────────────────────────────────
// The in-memory buffers above are the runtime read source in BOTH modes; in postgres
// mode we additionally write-through to the borderflow_* tables (durability across
// restarts) and load recent rows back on startup. Write-through is best-effort and never
// blocks the request path. json-file mode is unchanged (no-op persistence).
async function persistPredictionAccuracy(record) {
  if (datastoreMode !== 'postgres') return;
  await dbQuery(
    `INSERT INTO borderflow_prediction_accuracy
       (id, crossing_id, direction, predicted_wait, actual_wait, confidence_level, confidence_score, source_mix, predicted_at, resolved_at, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET actual_wait=EXCLUDED.actual_wait, resolved_at=EXCLUDED.resolved_at`,
    [record.id, record.crossingId, record.direction, record.predictedWait, record.actualWait, record.confidenceLevel, record.confidenceScore, record.sourceMix || {}, record.predictedAt, record.resolvedAt, record.source]
  );
}

async function persistMeasuredSession(session) {
  if (datastoreMode !== 'postgres') return;
  await dbQuery(
    `INSERT INTO borderflow_measured_sessions
       (id, crossing_id, direction, user_id, anonymous, predicted_wait_at_start, actual_wait, gps_verified, start_gps, end_gps, status, started_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (id) DO UPDATE SET actual_wait=EXCLUDED.actual_wait, gps_verified=EXCLUDED.gps_verified,
       end_gps=EXCLUDED.end_gps, status=EXCLUDED.status, finished_at=EXCLUDED.finished_at`,
    [session.id, session.crossingId, session.direction, session.userId, session.anonymous, session.predictedWaitAtStart, session.actualWait, session.gpsVerified, session.startGps || null, session.endGps || null, session.status, session.startedAt, session.finishedAt]
  );
}

async function persistLocationWaitSession(session) {
  if (datastoreMode !== 'postgres') return;
  await dbQuery(
    `INSERT INTO borderflow_location_wait_sessions
       (id, session_id, crossing_id, direction, status, started_at, completed_at, measured_wait_min, start_anchor_id, end_anchor_id, location_accuracy_m, user_session_hash, metadata_json, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
     ON CONFLICT (session_id) DO UPDATE SET status=EXCLUDED.status, started_at=EXCLUDED.started_at,
       completed_at=EXCLUDED.completed_at, measured_wait_min=EXCLUDED.measured_wait_min,
       location_accuracy_m=EXCLUDED.location_accuracy_m, metadata_json=EXCLUDED.metadata_json, updated_at=NOW()`,
    [session.id, session.sessionId, session.crossingId, session.direction, session.status,
      session.serverStartedAt || null, session.serverCompletedAt || null, session.measuredWaitMin ?? null,
      session.startAnchorId || null, session.endAnchorId || null, Math.round(Number(session.lastAccuracyM || 0)) || null,
      session.userSessionHash || null, session.metadata || {}]
  );
}

async function persistAlertSubscription(sub) {
  if (datastoreMode !== 'postgres') return;
  await dbQuery(
    `INSERT INTO borderflow_alert_subscriptions
       (id, user_id, crossing_id, direction, drop_below, rise_above, push_token, active, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET active=EXCLUDED.active`,
    [sub.id, sub.userId, sub.crossingId, sub.direction, sub.dropBelow, sub.riseAbove, sub.pushToken, sub.active, sub.createdAt]
  );
}

// Load recent rows into the in-memory buffers on startup so bias correction / accuracy /
// telemetry have history immediately after a restart.
async function loadPersistedIntelligenceState() {
  if (datastoreMode !== 'postgres') return;
  try {
    const acc = await dbQuery('SELECT * FROM borderflow_prediction_accuracy ORDER BY predicted_at DESC LIMIT 20000');
    predictionAccuracyBuffer.splice(0, predictionAccuracyBuffer.length, ...acc.rows.map((r) => ({
      id: r.id, crossingId: r.crossing_id, direction: r.direction, predictedWait: r.predicted_wait, actualWait: r.actual_wait,
      confidenceLevel: r.confidence_level, confidenceScore: r.confidence_score, sourceMix: r.source_mix || {},
      predictedAt: isoDate(r.predicted_at), resolvedAt: r.resolved_at ? isoDate(r.resolved_at) : null, source: r.source,
    })));
    const ses = await dbQuery("SELECT * FROM borderflow_measured_sessions ORDER BY started_at DESC LIMIT 5000");
    measuredSessionBuffer.splice(0, measuredSessionBuffer.length, ...ses.rows.map((r) => ({
      id: r.id, crossingId: r.crossing_id, direction: r.direction, userId: r.user_id, anonymous: r.anonymous,
      predictedWaitAtStart: r.predicted_wait_at_start, actualWait: r.actual_wait, gpsVerified: r.gps_verified,
      startGps: r.start_gps, endGps: r.end_gps, status: r.status, startedAt: isoDate(r.started_at), finishedAt: r.finished_at ? isoDate(r.finished_at) : null,
    })));
    const subs = await dbQuery('SELECT * FROM borderflow_alert_subscriptions WHERE active = TRUE ORDER BY created_at DESC LIMIT 10000');
    alertSubscriptionBuffer.splice(0, alertSubscriptionBuffer.length, ...subs.rows.map((r) => ({
      id: r.id, userId: r.user_id, crossingId: r.crossing_id, direction: r.direction, dropBelow: r.drop_below,
      riseAbove: r.rise_above, pushToken: r.push_token, active: r.active, createdAt: isoDate(r.created_at),
    })));
    // Recent location-wait sessions (last 24h) so the verified-location signal survives a restart.
    const loc = await dbQuery("SELECT * FROM borderflow_location_wait_sessions WHERE created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 20000");
    locationWaitSessionBuffer.splice(0, locationWaitSessionBuffer.length, ...loc.rows.map((r) => ({
      id: r.id, sessionId: r.session_id, crossingId: r.crossing_id, direction: r.direction, status: r.status,
      serverStartedAt: r.started_at ? isoDate(r.started_at) : null, serverCompletedAt: r.completed_at ? isoDate(r.completed_at) : null,
      measuredWaitMin: r.measured_wait_min, startAnchorId: r.start_anchor_id, endAnchorId: r.end_anchor_id,
      userSessionHash: r.user_session_hash, metadata: r.metadata_json || {}, createdAt: isoDate(r.created_at),
    })));
    console.log(`[intelligence-state] loaded ${predictionAccuracyBuffer.length} accuracy / ${measuredSessionBuffer.length} sessions / ${alertSubscriptionBuffer.length} subs / ${locationWaitSessionBuffer.length} loc-sessions`);
    refreshBiasModel();
    refreshCalibrationModel();
  } catch (error) {
    console.warn('[intelligence-state] load failed:', error.message);
  }
}

const SOURCE_FETCH_ENABLED = process.env.SOURCE_FETCH_ENABLED !== 'false';
// Refresh public sources + cameras more often so the wait estimate tracks reality (users should
// not have to wait ~10 min for a cleared queue to disappear). Configurable; floored at 2 min to
// stay polite to HAK/BIHAMK/Google.
const SOURCE_REFRESH_INTERVAL_MS = Math.max(2, Number(process.env.SOURCE_REFRESH_INTERVAL_MINUTES || 4)) * 60 * 1000;
const SOURCE_FETCH_TIMEOUT_MS = Math.max(1500, Number(process.env.SOURCE_FETCH_TIMEOUT_MS || 4500));
// Scheduled Google near-border traffic estimate. This was REFERENCED in buildGoogleTrafficSnapshots
// but never defined → every refresh threw "GOOGLE_TRAFFIC_ESTIMATE_ENABLED is not defined", so the
// scheduler never built any Google snapshot. Crossings WITHOUT an official text source (e.g. Gornji
// Varoš) therefore showed "Nedovoljno podataka" and the near-border jam never reached the headline.
// Default ON (needs the server key); set GOOGLE_TRAFFIC_ESTIMATE_ENABLED=false to disable for cost.
const GOOGLE_TRAFFIC_ESTIMATE_ENABLED = process.env.GOOGLE_TRAFFIC_ESTIMATE_ENABLED !== 'false';
const GOOGLE_TRAFFIC_REFRESH_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.GOOGLE_TRAFFIC_REFRESH_CONCURRENCY || 3)));
// Automatic snapshot hygiene: prune source snapshots older than this on startup and on every
// refresh, so stale/legacy values self-clean without anyone running DELETE on production. Fresh
// data for active sources is re-inserted every refresh; only genuinely abandoned rows age out.
const SOURCE_SNAPSHOT_RETENTION_MS = Math.max(1, Number(process.env.SOURCE_SNAPSHOT_RETENTION_HOURS || 6)) * 60 * 60 * 1000;
// Legacy/suspicious public-text cleanup: the OLD parser (pre section-boundary fix) inserted bleed
// artifacts (120/180/240/360 min) that age-based pruning leaves alive for up to 6h and which can
// still drive the estimate. Every snapshot the NEW parser writes carries metadata.parserVersion +
// cleanupSafe; any public-text-status row with wait ≥ threshold and NO parserVersion is legacy and
// gets removed. We NEVER touch google/camera/routing snapshots — only public-text-status legacy.
const PUBLIC_PARSER_VERSION = 'public-text-v2-boundary-2026-06';
const PRUNE_SUSPICIOUS_PUBLIC_SNAPSHOTS = process.env.PRUNE_SUSPICIOUS_PUBLIC_SNAPSHOTS !== 'false';
const PUBLIC_SNAPSHOT_SUSPECT_WAIT_MIN = Math.max(30, Number(process.env.PUBLIC_SNAPSHOT_SUSPECT_WAIT_MIN || 120));
const PUBLIC_SNAPSHOT_CLEANUP_DRY_RUN = process.env.PUBLIC_SNAPSHOT_CLEANUP_DRY_RUN === 'true';
let sourceRefreshState = { lastRunAt: 0, running: null, lastError: '' };

// Stamp the new-parser provenance on a public-text snapshot so the suspicious cleanup can tell a
// freshly-parsed high wait (legitimate) from a legacy bleed artifact (no parserVersion).
function publicParserMeta(fullText, section, parserName) {
  const start = section ? String(fullText).indexOf(section) : -1;
  return {
    parserVersion: PUBLIC_PARSER_VERSION,
    parserName,
    extractedSectionStart: start,
    extractedSectionEnd: start >= 0 ? start + section.length : -1,
    cleanupSafe: true,
  };
}

const PUBLIC_SOURCE_TARGETS = {
  maljevac: {
    bihamkNames: ['Velika Kladuša', 'GP Velika Kladuša', 'Maljevac', 'VELIKA KLADUŠA - MALJEVAC'],
    preferred: ['BIHAMK', 'Google Routes', 'Kamera'],
  },
  gradiska: {
    // Keep Gradiška aliases tight to the OLD Sava bridge so they do NOT swallow the
    // separate "Gradiška novi most" entry, which belongs to gornji-varos below.
    bihamkNames: ['GP Gradiška', 'Gradiška', 'Gradiska', 'Gradina'],
    preferred: ['BIHAMK', 'AMS RS', 'Google Routes', 'Kamera'],
    amsRsUrl: 'https://ams-rs.com/granicni-prelaz-gradiska/',
  },
  'gornji-varos': {
    // GP Gornji Varoš sits on the NEW motorway Sava bridge ("Gradiška novi most").
    // HAK/MUP and BIHAMK list it under several names; match all of them but keep the
    // "novi most" qualifier so it is not confused with the old Gradiška crossing.
    hakNames: [
      'Gornji Varoš', 'Gornji Varos',
      'Gradiška novi most', 'Gradiska novi most',
      'Gradiška (novi most)', 'Gradiska (novi most)',
      'Gradiška - novi most', 'Gradiska - novi most',
    ],
    bihamkNames: [
      'Gornji Varoš', 'Gornji Varos',
      'Gradiška Novi Most', 'Gradiska Novi Most',
    ],
    preferred: ['HAK', 'MUP', 'BIHAMK', 'AMS RS', 'Kamera', 'Google Routes'],
  },
  orasje: {
    bihamkNames: ['Orašje', 'Orasje', 'GP Orašje'],
    preferred: ['BIHAMK', 'Google Routes', 'Kamera'],
  },
  brod: {
    bihamkNames: ['Brod', 'GP Brod', 'Bosanski Brod'],
    preferred: ['BIHAMK', 'AMS RS', 'Google Routes', 'Kamera'],
    amsRsUrl: 'https://ams-rs.com/granicni-prelaz-brod/',
  },
  samac: {
    bihamkNames: ['Šamac', 'Samac', 'GP Šamac', 'Bosanski Šamac'],
    preferred: ['BIHAMK', 'AMS RS', 'Google Routes', 'Kamera'],
    amsRsUrl: 'https://ams-rs.com/granicni-prelaz-samac/',
  },
  svilaj: {
    bihamkNames: ['Svilaj', 'GP Svilaj'],
    preferred: ['BIHAMK', 'AMS RS', 'Google Routes', 'Kamera'],
    amsRsUrl: 'https://ams-rs.com/granicni-prelaz-svilaj/',
  },
  izacic: {
    bihamkNames: ['Izačić', 'Izacic', 'GP Izačić'],
    preferred: ['BIHAMK', 'Google Routes', 'Kamera'],
  },
  kamensko: {
    bihamkNames: ['Kamensko', 'GP Kamensko'],
    preferred: ['BIHAMK', 'Google Routes', 'Kamera'],
  },
  prisika: {
    bihamkNames: ['Prisika', 'GP Prisika', 'Prisika-Aržano'],
    preferred: ['BIHAMK', 'Google Routes', 'Kamera'],
  },
  'crveni-grm': {
    bihamkNames: ['Crveni Grm', 'GP Crveni Grm'],
    preferred: ['BIHAMK', 'Google Routes', 'Kamera'],
  },
  bijaca: {
    bihamkNames: ['Bijača', 'Bijaca', 'GP Bijača'],
    preferred: ['BIHAMK', 'Google Routes', 'Kamera'],
  },
  'vinjani-donji': {
    bihamkNames: ['Gorica', 'GP Gorica', 'Donji Vinjani'],
    preferred: ['BIHAMK', 'Google Routes', 'Kamera'],
  },
  'vinjani-gornji': {
    bihamkNames: ['Orahovlje', 'GP Orahovlje', 'Vinjani Gornji'],
    preferred: ['BIHAMK', 'Google Routes', 'Kamera'],
  },
};

function stripHtml(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8211;|&ndash;/g, '-')
    .replace(/&#269;|&ccaron;/g, 'č')
    .replace(/&#263;|&cacute;/g, 'ć')
    .replace(/&#353;|&scaron;/g, 'š')
    .replace(/&#382;|&zcaron;/g, 'ž')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchTextWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': `PrijelazRadar/1.0 (+${process.env.SITE_URL || 'https://prijelazradar.hr'})`,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeAscii(value = '') {
  return String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function clampWait(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(360, n));
}

function extractBihamkSection(text, names = [], boundaryNames = []) {
  const normalized = normalizeAscii(text);
  const ownNames = names.map((name) => normalizeAscii(name)).filter(Boolean);
  const namePositions = ownNames
    .map((name) => normalized.indexOf(name))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  if (!namePositions.length) return '';
  const anchor = namePositions[0];
  const anchorName = ownNames.find((name) => normalized.indexOf(name) === anchor) || '';
  const ownEnd = anchor + Math.max(8, anchorName.length);

  // The HAK/BIHAMK status pages concatenate EVERY border crossing into one text blob, using
  // bare names like "Bajakovo (Batrovci)" (no "GP " prefix). The section for one crossing must
  // therefore be cut at the nearest OTHER crossing's name — before AND after — otherwise a
  // neighbour's number leaks in as this crossing's wait. This was the Maljevac=360 min bug:
  // the 760-char window swallowed "Bajakovo (Batrovci) - ... 6 h" → "Eksplicitno čekanje 360 min".
  // Boundaries = every OTHER configured crossing's name PLUS foreign crossings / country
  // section headers that appear on the same HAK/BIHAMK page (Serbian, Montenegrin, Hungarian
  // border lists, "Pomorski promet", etc.). Without the foreign boundaries the LAST BiH crossing
  // before a run of foreign rows would still swallow a foreign number.
  const others = [...boundaryNames, ...PUBLIC_SECTION_BOUNDARIES]
    .map((name) => normalizeAscii(name))
    .filter((name) => name && !ownNames.includes(name));
  let endCut = text.length;
  let startCut = 0;
  for (const other of others) {
    let idx = normalized.indexOf(other);
    while (idx >= 0) {
      if (idx >= ownEnd && idx < endCut) endCut = idx;
      if (idx < anchor && idx + other.length > startCut) startCut = idx + other.length;
      idx = normalized.indexOf(other, idx + 1);
    }
  }
  // Keep the legacy "next GP" boundary as a secondary tightener, and a tight hard cap as a
  // backstop for pages where no boundary name is found (so we never fall back to a window that
  // can span several crossings). A single crossing row — name + ulaz/izlaz status + timestamps —
  // comfortably fits in this many characters.
  const after = normalized.slice(ownEnd);
  const nextGpRelative = after.search(/\bgp\s+[a-z]/i);
  if (nextGpRelative >= 0) endCut = Math.min(endCut, ownEnd + nextGpRelative);
  // Start AT the crossing's own name. The HAK/BIHAMK row format is "<Name> - <ulaz/izlaz status>",
  // so a crossing's own waits always follow its name; reaching back (the old -80 lookback) only
  // pulled the PREVIOUS crossing's trailing number into this section (backward bleed).
  const start = Math.max(startCut, anchor, 0);
  const end = Math.min(endCut, anchor + 380, text.length);
  return text.slice(start, end).trim();
}

// Foreign border crossings and section headers that share the HAK/BIHAMK status pages with our
// BiH crossings. They are never our targets, but they MUST act as section boundaries so their
// (often multi-hour) numbers cannot bleed into the nearest BiH crossing's wait.
const PUBLIC_SECTION_BOUNDARIES = [
  // HR–Srbija
  'Bajakovo', 'Batrovci', 'Tovarnik', 'Šid', 'Sid', 'Batina', 'Bezdan', 'Ilok', 'Bačka Palanka', 'Backa Palanka', 'Erdut', 'Bogojevo',
  // HR–Crna Gora / Srbija-CG bleed guards
  'Crna Gora', 'Karasovići', 'Karasovici',
  // HR–Slovenija / HR–Mađarska section headers
  'Slovenija', 'Mađarska', 'Madarska', 'Goričan', 'Gorican', 'Bregana',
  // Country / mode section headers on the page
  'Srbija - Hrvatska', 'Hrvatska - Srbija', 'Bosna i Hercegovina', 'Pomorski promet', 'Granični prijelazi',
];

// Union of every configured crossing's public-source names — used to bound one crossing's
// text section at the next crossing's name (see extractBihamkSection).
function allPublicSourceNames(nameKey = 'bihamkNames') {
  const set = new Set();
  for (const config of Object.values(PUBLIC_SOURCE_TARGETS)) {
    for (const name of (config[nameKey] || config.bihamkNames || [])) set.add(name);
  }
  return [...set];
}

function waitTextHasStatusSignal(context = '') {
  return /(?:cek|zadrz|kolon|guzv|gran|prelaz|prijelaz|ulaz|izlaz|promet|vozil)/.test(context);
}

function directionFromContext(context = '', sourceSide = 'bih', pivotIndex = null) {
  const normalizedSourceSide = normalizeAscii(sourceSide || 'bih');
  const entryDirection = normalizedSourceSide === 'hr' ? 'toHr' : 'toBih';
  const exitDirection = normalizedSourceSide === 'hr' ? 'toBih' : 'toHr';
  const pivot = Number.isFinite(Number(pivotIndex)) ? Number(pivotIndex) : Math.floor(context.length / 2);

  const collectMatches = (rules) => {
    const matches = [];
    for (const rule of rules) {
      const regex = new RegExp(rule.regex.source, rule.regex.flags.includes('g') ? rule.regex.flags : `${rule.regex.flags}g`);
      let match;
      while ((match = regex.exec(context))) {
        const center = match.index + Math.max(1, match[0].length / 2);
        const before = center <= pivot + 6;
        const beforeBonus = before ? 0 : 35;
        matches.push({ direction: rule.direction, before, distance: Math.abs(center - pivot) + beforeBonus, index: match.index });
      }
    }
    return matches.sort((a, b) => Number(b.before) - Number(a.before) || a.distance - b.distance || b.index - a.index);
  };

  const countryMatches = collectMatches([
    { direction: 'toBih', regex: /\b(?:ulaz\w*\s+u\s+(?:bih|bosn\w*|republik\w*\s+srpsk\w*|rs)|izlaz\w*\s+iz\s+(?:rh|hrvatsk\w*|hr))\b/g },
    { direction: 'toHr', regex: /\b(?:izlaz\w*\s+iz\s+(?:bih|bosn\w*|republik\w*\s+srpsk\w*|rs)|ulaz\w*\s+u\s+(?:rh|hrvatsk\w*|hr))\b/g },
  ]);
  if (countryMatches.length) return countryMatches[0].direction;

  const genericMatches = collectMatches([
    { direction: entryDirection, regex: /\b(?:na\s+)?ulaz\w*\b/g },
    { direction: exitDirection, regex: /\b(?:na\s+)?izlaz\w*\b/g },
  ]);
  if (genericMatches.length) return genericMatches[0].direction;
  return null;
}

function extractExplicitWaitMentions(normalized = '') {
  const mentions = [];
  const covered = [];
  const overlapsCovered = (start, end) => covered.some((range) => start < range.end && end > range.start);

  const hourRe = /(\d{1,2})\s*(?:h|sat|sata|sati)\b(?:\s*(?:i|,)?\s*(\d{1,2})\s*(?:minuta|min|m)\b)?/g;
  let match;
  while ((match = hourRe.exec(normalized))) {
    const hours = Number(match[1]);
    const minutes = Number(match[2] || 0);
    if (!Number.isFinite(hours) || hours > 6 || minutes >= 60) continue;
    const wait = clampWait((hours * 60) + minutes);
    if (wait === null) continue;
    mentions.push({ wait, start: match.index, end: match.index + match[0].length, raw: match[0], kind: 'hour' });
    covered.push({ start: match.index, end: match.index + match[0].length });
  }

  const minuteRe = /(\d{1,3})\s*(?:minuta|min|m)\b/g;
  while ((match = minuteRe.exec(normalized))) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (overlapsCovered(start, end)) continue;
    const wait = clampWait(match[1]);
    if (wait === null || wait > 240) continue;
    mentions.push({ wait, start, end, raw: match[0], kind: 'minute' });
  }

  return mentions.sort((a, b) => a.start - b.start);
}

function parseDirectionalWaitsFromText(rawText = '', options = {}) {
  const normalized = normalizeAscii(rawText);
  const sourceSide = normalizeAscii(options.sourceSide || 'bih');
  const entryDirection = sourceSide === 'hr' ? 'toHr' : 'toBih';
  const exitDirection = sourceSide === 'hr' ? 'toBih' : 'toHr';
  const signals = [];
  const push = (direction, wait, rawStatus, confidence = 70, weight = 1, metadata = {}) => {
    const normalizedWait = clampWait(wait);
    if (!direction || normalizedWait === null) return;
    signals.push({ direction, wait: normalizedWait, rawStatus, confidence, weight, metadata });
  };

  const explicitMentions = extractExplicitWaitMentions(normalized);

  // Collect positions of soft-upper-bound phrases ("nije/nisu duže od X min", "čekanje do X min")
  // so their embedded numbers are NOT re-treated as hard explicit waits.
  const softUbRanges = [];
  const softUbPhraseRe = /ni(?:je|su)\s+duz\w*\s+od\s+\d{1,3}\s*(?:minuta|min|m)/g;
  let subM;
  while ((subM = softUbPhraseRe.exec(normalized))) {
    softUbRanges.push({ start: subM.index, end: subM.index + subM[0].length });
  }
  const doXPhraseRe = /(?:zadrzavanj\w+|cekanj\w+)\s+(?:\w+\s+)?do\s+(\d{1,3})\s*(?:minuta|min)\b/g;
  const doXMatches = [];
  let doXM;
  while ((doXM = doXPhraseRe.exec(normalized))) {
    softUbRanges.push({ start: doXM.index, end: doXM.index + doXM[0].length });
    const doXMax = Number(doXM[1]);
    if (doXMax && doXMax <= 60) doXMatches.push({ max: doXMax, pos: doXM.index, len: doXM[0].length });
  }
  const isInSoftUbRange = (start, end) => softUbRanges.some((r) => start >= r.start && end <= r.end);

  for (const mention of explicitMentions) {
    // Skip numbers that are part of "nije/nisu duže od X min" or "čekanje do X min" — those are soft upper bounds, not hard waits.
    if (isInSoftUbRange(mention.start, mention.end)) continue;
    const context = normalized.slice(Math.max(0, mention.start - 130), Math.min(normalized.length, mention.end + 130));
    if (!waitTextHasStatusSignal(context)) continue;
    const direction = directionFromContext(context, sourceSide, mention.start - Math.max(0, mention.start - 130));
    if (!direction) continue;
    const label = direction === 'toBih' ? 'HR → BiH' : 'BiH → HR';
    const confidence = mention.kind === 'hour' ? 92 : 90;
    push(direction, mention.wait, `Eksplicitno čekanje ${mention.wait} min (${label})`, confidence, 1.35);
  }

  const numberMatches = explicitMentions.map((mention) => mention.wait).filter(Number.isFinite);
  const minMention = numberMatches.length ? Math.min(...numberMatches) : null;

  if (/dug[aei]?\s+(?:su\s+)?kolon/.test(normalized) && /izlaz\w*\s+iz\s+(?:bosn|bih|republik\w*\s+srpsk\w*|rs)/.test(normalized)) {
    push('toHr', 75, 'Duga kolona na izlazu iz BiH/RS', 84, 1.3);
  }
  if (/dug[aei]?\s+(?:su\s+)?kolon/.test(normalized) && /ulaz\w*\s+u\s+(?:bosn|bih|republik\w*\s+srpsk\w*|rs)/.test(normalized)) {
    push('toBih', 75, 'Duga kolona na ulazu u BiH/RS', 84, 1.3);
  }
  if (/dug[aei]?\s+(?:su\s+)?kolon/.test(normalized) && /ulaz\w*\s+u\s+(?:rh|hrvatsk)/.test(normalized)) {
    push('toHr', 75, 'Duga kolona na ulazu u HR', 84, 1.3);
  }
  if (/dug[aei]?\s+(?:su\s+)?kolon/.test(normalized) && /izlaz\w*\s+iz\s+(?:rh|hrvatsk)/.test(normalized)) {
    push('toBih', 75, 'Duga kolona na izlazu iz HR', 84, 1.3);
  }
  // "Pojačan ulaz/izlaz" is a vague qualitative signal from HAK/BIHAMK — it says traffic
  // is elevated, NOT that the wait is 45 minutes. Treat it as a soft upper bound so it
  // can contribute to the estimate without dominating it when Google/camera disagree.
  if (/pojacan\w*\s+(?:je\s+)?izlaz/.test(normalized)) push(exitDirection, 15, sourceSide === 'hr' ? 'Pojačan izlaz iz HR' : 'Pojačan izlaz iz BiH/RS', 64, 0.5, { softUpperBound: true, softMaxMinutes: 30, parser: 'pojacan-izlaz' });
  if (/pojacan\w*\s+(?:je\s+)?ulaz/.test(normalized)) push(entryDirection, 15, sourceSide === 'hr' ? 'Pojačan ulaz u HR' : 'Pojačan ulaz u BiH/RS', 64, 0.5, { softUpperBound: true, softMaxMinutes: 30, parser: 'pojacan-ulaz' });

  // "nije/nisu duže od X min" — soft upper bound: treat as low/medium estimate, NOT literal X min.
  const under30 = minMention && minMention <= 35 && /ni(?:je|su)\s+duz\w*\s+od\s+\d{1,3}\s*(?:minuta|min|m)/.test(normalized);
  const softUpperBoundWait = under30 ? Math.max(6, Math.round(minMention * 0.35)) : null;
  const softUpperBoundMeta = under30 ? { softUpperBound: true, softMaxMinutes: minMention, parser: 'under-not-longer-than' } : {};
  if (under30 && /na\s+ulaz\w*/.test(normalized)) push(entryDirection, softUpperBoundWait, `Zadržavanja na ulazu nisu duža od ${minMention} min`, 62, 0.42, softUpperBoundMeta);
  if (under30 && /na\s+izlaz\w*/.test(normalized)) push(exitDirection, softUpperBoundWait, `Zadržavanja na izlazu nisu duža od ${minMention} min`, 62, 0.42, softUpperBoundMeta);
  if (under30 && !/na\s+ulaz\w*|na\s+izlaz\w*/.test(normalized)) {
    push('toBih', softUpperBoundWait, `Zadržavanja nisu duža od ${minMention} min`, 58, 0.35, softUpperBoundMeta);
    push('toHr', softUpperBoundWait, `Zadržavanja nisu duža od ${minMention} min`, 58, 0.35, softUpperBoundMeta);
  }

  // "čekanje/zadržavanja do X min" — another form of soft upper bound.
  for (const { max, pos, len } of doXMatches) {
    const doXWait = Math.max(6, Math.round(max * 0.35));
    const doXMeta = { softUpperBound: true, softMaxMinutes: max, parser: 'do-x-min' };
    const doXCtx = normalized.slice(Math.max(0, pos - 60), Math.min(normalized.length, pos + len + 60));
    if (/na\s+ulaz\w*/.test(doXCtx)) push(entryDirection, doXWait, `Zadržavanja na ulazu do ${max} min`, 62, 0.42, doXMeta);
    else if (/na\s+izlaz\w*/.test(doXCtx)) push(exitDirection, doXWait, `Zadržavanja na izlazu do ${max} min`, 62, 0.42, doXMeta);
    else {
      push('toBih', doXWait, `Zadržavanja do ${max} min`, 58, 0.35, doXMeta);
      push('toHr', doXWait, `Zadržavanja do ${max} min`, 58, 0.35, doXMeta);
    }
  }

  if (/nema\s+duz\w*\s+zadrzavanja|bez\s+duz\w*\s+zadrzavanja/.test(normalized)) {
    push('toBih', 12, 'Nema dužih zadržavanja', 76, 0.9);
    push('toHr', 12, 'Nema dužih zadržavanja', 76, 0.9);
  }

  const bestByDirection = new Map();
  for (const signal of signals) {
    const current = bestByDirection.get(signal.direction);
    if (!current || signal.confidence > current.confidence || (signal.confidence === current.confidence && signal.weight > current.weight) || (signal.confidence === current.confidence && signal.wait > current.wait)) {
      bestByDirection.set(signal.direction, signal);
    }
  }
  return [...bestByDirection.values()];
}

function sourceSnapshotId(snapshot) {
  const bucket = new Date(snapshot.fetchedAt || Date.now()).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const source = normalizeAscii(snapshot.sourceName || 'source').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${bucket}:${snapshot.crossingId}:${snapshot.direction}:${source}`;
}

function normalizeSourceSnapshot(snapshot) {
  const normalized = {
    id: snapshot.id || sourceSnapshotId(snapshot),
    crossingId: snapshot.crossingId,
    direction: snapshot.direction === 'toHr' ? 'toHr' : 'toBih',
    sourceName: snapshot.sourceName || 'Public source',
    sourceType: snapshot.sourceType || 'public-source',
    sourceUrl: snapshot.sourceUrl || '',
    rawStatus: String(snapshot.rawStatus || '').slice(0, 180),
    rawText: String(snapshot.rawText || '').slice(0, 1600),
    rawWaitMin: clampWait(snapshot.rawWaitMin),
    normalizedWaitMin: clampWait(snapshot.normalizedWaitMin ?? snapshot.rawWaitMin),
    confidence: Math.max(0, Math.min(100, Math.round(Number(snapshot.confidence || 50)))),
    weight: Math.max(0.1, Math.min(3, Number(snapshot.weight || 1))),
    metadata: snapshot.metadata || {},
    fetchedAt: snapshot.fetchedAt || new Date().toISOString(),
    createdAt: snapshot.createdAt || new Date().toISOString(),
  };
  normalized.id = normalized.id || sourceSnapshotId(normalized);
  return normalized;
}

async function insertSourceSnapshots(snapshots = []) {
  const rows = snapshots.map(normalizeSourceSnapshot).filter((item) => BORDER_CROSSINGS[item.crossingId]);
  if (!rows.length) return [];
  if (datastoreMode === 'postgres') {
    const pool = await getPgPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of rows) {
        await client.query(
          `INSERT INTO borderflow_source_snapshots
             (id, crossing_id, direction, source_name, source_type, source_url, raw_status, raw_text, raw_wait_min, normalized_wait_min, confidence, weight, metadata, fetched_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (id) DO UPDATE SET raw_status=EXCLUDED.raw_status, raw_text=EXCLUDED.raw_text,
             raw_wait_min=EXCLUDED.raw_wait_min, normalized_wait_min=EXCLUDED.normalized_wait_min,
             confidence=EXCLUDED.confidence, weight=EXCLUDED.weight, metadata=EXCLUDED.metadata, fetched_at=EXCLUDED.fetched_at`,
          [item.id, item.crossingId, item.direction, item.sourceName, item.sourceType, item.sourceUrl, item.rawStatus, item.rawText, item.rawWaitMin, item.normalizedWaitMin, item.confidence, item.weight, item.metadata, item.fetchedAt, item.createdAt]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } else {
    const store = readStore();
    const byId = new Map((store.sourceSnapshots || []).map((item) => [item.id, item]));
    rows.forEach((item) => byId.set(item.id, item));
    store.sourceSnapshots = [...byId.values()]
      .sort((a, b) => String(b.fetchedAt).localeCompare(String(a.fetchedAt)))
      .slice(0, 4000);
    writeStore(store);
  }
  await Promise.all(rows.map((row) => upsertHistoryFromSourceSnapshot(row)).map((promise) => promise.catch(() => null)));
  return rows;
}

// Delete source snapshots older than the retention window (both datastores). Runs automatically
// on startup + each refresh so production never needs a manual DELETE to shed stale/bogus rows.
async function pruneStaleSourceSnapshots() {
  const cutoff = new Date(Date.now() - SOURCE_SNAPSHOT_RETENTION_MS).toISOString();
  try {
    if (datastoreMode === 'postgres') {
      const res = await dbQuery('DELETE FROM borderflow_source_snapshots WHERE fetched_at < $1', [cutoff]);
      return res.rowCount || 0;
    }
    const store = readStore();
    const before = (store.sourceSnapshots || []).length;
    store.sourceSnapshots = (store.sourceSnapshots || []).filter((item) => String(item.fetchedAt || '') >= cutoff);
    const removed = before - store.sourceSnapshots.length;
    if (removed) writeStore(store);
    return removed;
  } catch (error) {
    console.warn('[prune-source-snapshots]', error.message);
    return 0;
  }
}

// Remove LEGACY/SUSPICIOUS public-text-status snapshots: high waits (≥ threshold) written by the
// OLD parser (no metadata.parserVersion), which age-based pruning leaves alive for hours and which
// can still drive the estimate. STRICTLY scoped — only source_type='public-text-status' AND missing
// parserVersion AND wait ≥ threshold. Google/camera/routing snapshots are never touched, and fresh
// public snapshots from the new parser (which carry parserVersion + cleanupSafe) are kept. Returns
// { found, removed, dryRun, samples }.
// Pure predicate (exported for tests): a LEGACY/suspicious public-text snapshot is ONLY a
// public-text-status row with wait ≥ threshold and NO parserVersion (i.e. written by the old
// parser). Google/camera/routing snapshots and new-parser public rows are never suspicious.
function isSuspiciousLegacyPublicSnapshot(item = {}, threshold = PUBLIC_SNAPSHOT_SUSPECT_WAIT_MIN) {
  return item.sourceType === 'public-text-status'
    && Number(item.normalizedWaitMin || 0) >= threshold
    && !(item.metadata && item.metadata.parserVersion);
}

async function pruneSuspiciousPublicSourceSnapshots({ dryRun = PUBLIC_SNAPSHOT_CLEANUP_DRY_RUN } = {}) {
  const threshold = PUBLIC_SNAPSHOT_SUSPECT_WAIT_MIN;
  const result = { found: 0, removed: 0, dryRun: Boolean(dryRun), threshold, samples: [] };
  try {
    if (datastoreMode === 'postgres') {
      const sel = await dbQuery(
        `SELECT id, crossing_id, direction, source_name, normalized_wait_min
           FROM borderflow_source_snapshots
          WHERE source_type='public-text-status'
            AND normalized_wait_min >= $1
            AND (metadata->>'parserVersion') IS NULL`,
        [threshold]
      );
      result.found = sel.rows.length;
      result.samples = sel.rows.slice(0, 25).map((r) => ({ id: r.id, crossingId: r.crossing_id, direction: r.direction, sourceName: r.source_name, wait: r.normalized_wait_min }));
      if (!dryRun && result.found) {
        const del = await dbQuery(
          `DELETE FROM borderflow_source_snapshots
            WHERE source_type='public-text-status'
              AND normalized_wait_min >= $1
              AND (metadata->>'parserVersion') IS NULL`,
          [threshold]
        );
        result.removed = del.rowCount || 0;
      }
    } else {
      const store = readStore();
      const all = store.sourceSnapshots || [];
      const isSuspect = (item) => isSuspiciousLegacyPublicSnapshot(item, threshold);
      const suspects = all.filter(isSuspect);
      result.found = suspects.length;
      result.samples = suspects.slice(0, 25).map((s) => ({ id: s.id, crossingId: s.crossingId, direction: s.direction, sourceName: s.sourceName, wait: s.normalizedWaitMin }));
      if (!dryRun && result.found) {
        store.sourceSnapshots = all.filter((item) => !isSuspect(item));
        result.removed = result.found;
        writeStore(store);
      }
    }
    if (result.found) {
      console.log(`[prune-suspicious-public] threshold=${threshold} found=${result.found} removed=${result.removed}${result.dryRun ? ' (dry-run, nothing deleted)' : ''}`);
    }
  } catch (error) {
    console.warn('[prune-suspicious-public]', error.message);
  }
  return result;
}

async function readLatestSourceSnapshots(crossingId, direction, hours = 8) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  if (datastoreMode === 'postgres') {
    const rows = await dbQuery(
      `SELECT DISTINCT ON (source_name) * FROM borderflow_source_snapshots
       WHERE crossing_id=$1 AND direction=$2 AND fetched_at >= $3
       ORDER BY source_name, fetched_at DESC`,
      [crossingId, direction, since]
    );
    return rows.rows.map(sourceSnapshotFromRow);
  }
  const store = readStore();
  const seen = new Set();
  return (store.sourceSnapshots || [])
    .filter((item) => item.crossingId === crossingId && item.direction === direction && String(item.fetchedAt || '') >= since)
    .sort((a, b) => String(b.fetchedAt).localeCompare(String(a.fetchedAt)))
    .filter((item) => {
      if (seen.has(item.sourceName)) return false;
      seen.add(item.sourceName);
      return true;
    });
}

async function fetchBihamkSnapshots() {
  const url = 'https://bihamk.ba/spi/stanje-na-cesti-u-bih/granicni-prijelazi';
  const html = await fetchTextWithTimeout(url);
  const text = stripHtml(html);
  const snapshots = [];
  const boundaryNames = allPublicSourceNames('bihamkNames');
  Object.entries(PUBLIC_SOURCE_TARGETS).forEach(([crossingId, config]) => {
    const section = extractBihamkSection(text, config.bihamkNames || [], boundaryNames);
    if (!section) return;
    const parsed = parseDirectionalWaitsFromText(section);
    parsed.forEach((signal) => {
      snapshots.push({
        crossingId,
        direction: signal.direction,
        sourceName: 'BIHAMK',
        sourceType: 'public-text-status',
        sourceUrl: url,
        rawStatus: signal.rawStatus,
        rawText: section,
        rawWaitMin: signal.wait,
        normalizedWaitMin: signal.wait,
        confidence: signal.confidence,
        weight: signal.weight,
        metadata: { adapter: 'bihamk-border-status', crossingNames: config.bihamkNames || [], ...publicParserMeta(text, section, 'bihamk-border-status'), ...(signal.metadata || {}) },
        fetchedAt: new Date().toISOString(),
      });
    });
  });
  return snapshots;
}


async function fetchHakSnapshots() {
  const url = 'https://www.hak.hr/info/stanje-na-cestama/';
  const html = await fetchTextWithTimeout(url);
  const text = stripHtml(html);
  const snapshots = [];
  const boundaryNames = [...allPublicSourceNames('hakNames'), ...allPublicSourceNames('bihamkNames')];
  Object.entries(PUBLIC_SOURCE_TARGETS).forEach(([crossingId, config]) => {
    const names = config.hakNames || config.bihamkNames || [];
    const section = extractBihamkSection(text, names, boundaryNames);
    if (!section) return;
    const parsed = parseDirectionalWaitsFromText(section, { sourceSide: 'hr' });
    parsed.forEach((signal) => {
      snapshots.push({
        crossingId,
        direction: signal.direction,
        sourceName: 'HAK',
        sourceType: 'public-text-status',
        sourceUrl: url,
        rawStatus: signal.rawStatus,
        rawText: section,
        rawWaitMin: signal.wait,
        normalizedWaitMin: signal.wait,
        confidence: signal.confidence,
        weight: Math.max(1, signal.weight || 1),
        metadata: { adapter: 'hak-border-status', crossingNames: names, sourceSide: 'hr', ...publicParserMeta(text, section, 'hak-border-status'), ...(signal.metadata || {}) },
        fetchedAt: new Date().toISOString(),
      });
    });
  });
  return snapshots;
}

async function fetchAmsRsSnapshots() {
  const targets = Object.entries(PUBLIC_SOURCE_TARGETS).filter(([, config]) => config.amsRsUrl);
  const results = await Promise.allSettled(targets.map(async ([crossingId, config]) => {
    const html = await fetchTextWithTimeout(config.amsRsUrl);
    const text = stripHtml(html);
    const parsed = parseDirectionalWaitsFromText(text, { sourceSide: 'bih-rs' });
    const snapshots = parsed.length ? parsed.map((signal) => ({
      crossingId,
      direction: signal.direction,
      sourceName: 'AMS RS',
      sourceType: 'public-text-status',
      sourceUrl: config.amsRsUrl,
      rawStatus: `${signal.rawStatus} · AMS RS signal pokriva RS-stranu prijelaza`,
      rawText: text.slice(0, 1200),
      rawWaitMin: signal.wait,
      normalizedWaitMin: signal.wait,
      confidence: Math.max(70, signal.confidence),
      weight: Math.max(1.05, signal.weight),
      metadata: { adapter: 'ams-rs-border-status', crossingNames: config.bihamkNames || [], sourceSide: 'bih-rs', scopeNote: 'AMS RS signal is treated as RS-side only, not a full BiH-wide official status.', ...publicParserMeta(text, text.slice(0, 1200), 'ams-rs-border-status'), ...(signal.metadata || {}) },
      fetchedAt: new Date().toISOString(),
    })) : [];

    // AMS RS camera pages are useful even when the wait is embedded in the image and not readable from HTML.
    // We store page availability as a low-weight source signal; camera/Google estimates can still carry the wait.
    if (!snapshots.length) {
      ['toBih', 'toHr'].forEach((direction) => snapshots.push({
        crossingId,
        direction,
        sourceName: 'AMS RS',
        sourceType: 'public-camera-page',
        sourceUrl: config.amsRsUrl,
        rawStatus: 'AMS RS kamera/stranica dostupna za RS-stranu; čekanje nije strojno čitljivo u HTML-u',
        rawText: text.slice(0, 1200),
        rawWaitMin: null,
        normalizedWaitMin: null,
        confidence: 48,
        weight: 0.45,
        metadata: { adapter: 'ams-rs-camera-page', readableWait: false, sourceSide: 'bih-rs', scopeNote: 'AMS RS camera/page is treated as RS-side only.' },
        fetchedAt: new Date().toISOString(),
      }));
    }
    return snapshots;
  }));
  return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
}

async function buildCameraSourceSnapshots({ forceSnapshot = false } = {}) {
  const targets = Object.values(BORDER_CROSSINGS).filter((crossing) => (CAMERA_FEEDS[crossing.id] || []).length);
  const jobs = [];
  for (const crossing of targets) {
    for (const direction of ['toBih', 'toHr']) jobs.push({ crossingId: crossing.id, direction });
  }
  // Bounded fan-out: at most CAMERA_REFRESH_CONCURRENCY (crossing,direction) jobs at once, so adding
  // more crossings can't fire every camera+YOLO call simultaneously. The global cvInferenceSemaphore
  // further caps the actual detector load inside runYoloDetector.
  const results = await mapWithConcurrency(jobs, CAMERA_REFRESH_CONCURRENCY, async ({ crossingId, direction }) => {
    // forceSnapshot (from an admin/forced refresh) bypasses the cached camera frame and re-fetches.
    const payload = await buildCameraAnalyticsPayload(crossingId, direction, { storeScan: true, forceSnapshot });
    const analytics = payload.analytics || {};
    const actualSnapshots = analytics.cameraSnapshots || [];
    const hasActualSnapshot = actualSnapshots.some((item) => item?.method && String(item.method).includes('snapshot-counter'));
    const hasIngestOrCv = ['camera-ingest', 'cv-detector'].includes(String(analytics.source || ''));
    const out = [];

    // (1) Wait-driving camera signal — only when a provably-correct-direction, non-stale,
    // ROI-calibrated camera actually drove it (spec §1, §2, §6).
    if ((hasActualSnapshot && analytics.waitIsCameraDriven) || hasIngestOrCv) {
      out.push({
        crossingId,
        direction,
        sourceName: 'Kamera snapshot model',
        sourceType: 'camera-snapshot-model',
        sourceUrl: (CAMERA_FEEDS[crossingId] || [])[0]?.url || '',
        rawStatus: `${analytics.queueVehicles || 0} vidljivih/izvedenih vozila u zoni; protok ${analytics.flowVehicles15 ?? analytics.passed15 ?? 0} voz/15min (${analytics.throughputPerHour || 0} voz/h)`,
        rawText: analytics.message || '',
        rawWaitMin: analytics.wait,
        normalizedWaitMin: analytics.wait,
        confidence: Math.max(52, Math.min(78, Number(analytics.confidence || 60) - 10)),
        weight: 0.72,
        metadata: {
          adapter: 'calibrated-camera-snapshot',
          throughputPerHour: analytics.throughputPerHour,
          queueVehicles: analytics.queueVehicles,
          passed15: analytics.passed15,
          flowVehicles15: analytics.flowVehicles15 ?? analytics.passed15,
          queueTrend: analytics.queueTrend,
          queueBand: analytics.queueBand,
          waitRangeMin: analytics.waitRangeMin,
          waitRangeMax: analytics.waitRangeMax,
          vehicleMix15: analytics.vehicleMix15,
          visibleVehicles: analytics.roiFeatures?.visibleVehicleCount ?? analytics.queueVehicles,
          source: analytics.source,
          // ROI v2 + multi-frame features so the v2 fusion (effectiveBorderSignal) can consume them.
          roiFeatures: analytics.roiFeatures || null,
          multiFrame: analytics.multiFrame || null,
          snapshots: actualSnapshots.map((item) => ({ cameraId: item.cameraId, method: item.method, confidence: item.confidence, fetchedAt: item.fetchedAt })),
        },
        fetchedAt: new Date().toISOString(),
      });
    }

    // (2) VISUAL signal — the camera's qualitative band, emitted for ANY fresh frame that produced a
    // band, even when the wait is NOT camera-driven (visual-only / heuristic occupancy). This is the
    // signal that lets the fusion SEE a queue the detector couldn't count, so a visibly busy lane
    // can't collapse to a false-low estimate — and it no longer depends on a snapshot-counter/cv
    // frame (previously a heuristic occupancy band never reached effectiveBorderSignal → the live
    // "visualBand:null while camera-analytics shows a queue" bug). Carries NO wait (never drives the
    // number), only the band — so the fusion can flag a big queue while the wait is low (Maljevac)
    // and a small/no queue while the wait is very high (Šamac).
    const band = analytics.queueBand;
    const frameCount = (analytics.cameraSnapshots || []).length;
    if (band && frameCount > 0) {
      const occ = Math.max(0, ...(analytics.cameraSnapshots || []).map((s) => Number(s.occupancyPct ?? s.metadata?.occupancyPct ?? 0)));
      out.push({
        crossingId,
        direction,
        sourceName: 'Kamera vizualna provjera',
        sourceType: 'camera-visual',
        sourceUrl: (CAMERA_FEEDS[crossingId] || [])[0]?.url || '',
        rawStatus: `Kamera vizualno pokazuje ${analytics.queueBandLabel || band}`,
        rawText: '',
        rawWaitMin: null,
        normalizedWaitMin: null,
        confidence: 60,
        weight: 0,
        metadata: {
          queueBand: band,
          queueBandLabel: analytics.queueBandLabel,
          waitIsCameraDriven: Boolean(analytics.waitIsCameraDriven),
          occupancyPct: Number.isFinite(occ) ? occ : null,
          cameraIds: (analytics.cameraSnapshots || []).map((s) => s.cameraId).filter(Boolean),
          cameraAnalyticsWait: analytics.wait ?? null,
        },
        fetchedAt: new Date().toISOString(),
      });
    }
    return out;
  });
  return results
    .flatMap((result) => Array.isArray(result) ? result : [])
    .filter(Boolean);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index++;
      try {
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      } catch (error) {
        results[currentIndex] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}


function trafficMeta(signalOrRoute = {}) {
  const meta = signalOrRoute.metadata || signalOrRoute || {};
  const delayMinutes = Math.max(0, Number(meta.delayMinutes ?? signalOrRoute.delayMinutes ?? 0) || 0);
  const ratio = Math.max(0.1, Number(meta.ratio ?? signalOrRoute.ratio ?? 1) || 1);
  const level = String(meta.level || signalOrRoute.level || delayLevel(delayMinutes, ratio) || 'normal');
  return { delayMinutes, ratio, level };
}

function estimateWaitFromGoogleRoute(route = {}) {
  const { delayMinutes, ratio, level } = trafficMeta(route);
  // On very short border-control zones the ratio can look high even when the
  // absolute Google delay is only ~1–2 minutes. For wait estimation, absolute
  // delay is the safer signal: a 2 min approach delay + clear camera should not
  // keep a 30–45 min border wait alive.
  const lowAbsoluteDelay = delayMinutes <= 2.5;
  const clear = (level === 'normal' && delayMinutes <= 2 && ratio < 1.12) || (lowAbsoluteDelay && ratio < 1.6);
  const heavy = !clear && (level === 'heavy' || delayMinutes >= 8 || ratio >= 1.35);
  const slow = !clear && (level === 'slow' || delayMinutes > 2 || ratio >= 1.12);

  if (clear) {
    return {
      wait: 6,
      rangeMin: 0,
      rangeMax: 12,
      confidence: 62,
      weight: 0.84,
      level: 'normal',
      reason: 'Google promet u kontrolnoj zoni je normalan; to nije dokaz 0 min, nego cap protiv velikih procjena bez potvrde.',
    };
  }

  if (!heavy && slow) {
    const wait = clampWait(Math.round(9 + delayMinutes * 2.1 + Math.max(0, ratio - 1.08) * 28));
    return {
      wait,
      rangeMin: Math.max(5, wait - 6),
      rangeMax: wait + 10,
      confidence: 68,
      weight: 0.92,
      level: 'slow',
      reason: 'Google pokazuje usporenje kroz kontrolnu zonu.',
    };
  }

  const wait = clampWait(Math.round(18 + delayMinutes * 2.8 + Math.max(0, ratio - 1.25) * 48));
  return {
    wait,
    rangeMin: Math.max(12, wait - 8),
    rangeMax: wait + 16,
    confidence: 74,
    weight: 1.06,
    level: 'heavy',
    reason: 'Google pokazuje ozbiljno zagušenje kroz kontrolnu zonu.',
  };
}

function isSoftUpperBoundSource(item = {}) {
  if (item.metadata?.softUpperBound === true) return true;
  const text = normalizeAscii(`${item.rawStatus || ''} ${item.rawText || ''}`);
  // Soft-bound textual patterns: "nije/nisu duže od X min", "čekanje do X min".
  if (/ni(?:je|su)\s+duz\w*\s+od\s+\d{1,3}\s*(?:minuta|min|m)/.test(text)) return true;
  if (/(?:zadrzavanj\w+|cekanj\w+)\s+(?:\w+\s+)?do\s+\d{1,3}\s*(?:minuta|min)\b/.test(text)) return true;
  // "Pojačan ulaz/izlaz" is qualitative — no concrete minute count, treat as soft.
  // This also covers legacy snapshots persisted before the parser was fixed.
  if (/pojacan\w*\s+(?:je\s+)?(?:ulaz|izlaz)/.test(text)) return true;
  return false;
}

// Legacy snapshots persisted before the parser fix can still have raw 45-min values
// with hard confidence/weight. Re-normalize at read time so they cap correctly until
// the storage rolls them off.
function sanitizeLegacyPublicSignal(item) {
  if (!item) return item;
  if (item.metadata?.softUpperBound === true) return item;
  if (!isSoftUpperBoundSource(item)) return item;
  const originalWait = Number(item.normalizedWaitMin || 0);
  if (!Number.isFinite(originalWait) || originalWait <= 18) return item;
  return {
    ...item,
    normalizedWaitMin: Math.max(6, Math.round(originalWait * 0.35)),
    confidence: Math.min(Number(item.confidence || 70), 64),
    weight: Math.min(Number(item.weight || 1), 0.5),
    metadata: {
      ...(item.metadata || {}),
      softUpperBound: true,
      softMaxMinutes: originalWait,
      parser: item.metadata?.parser || 'legacy-rewrite',
      legacyOriginalWait: originalWait,
    },
  };
}

function googleLooksClear(signal = null) {
  if (!signal) return false;
  const { delayMinutes, ratio, level } = trafficMeta(signal);
  return (level === 'normal' && delayMinutes <= 2 && ratio < 1.12) || (delayMinutes <= 2.5 && ratio < 1.6);
}

function googleLooksSlow(signal = null) {
  if (!signal) return false;
  if (googleLooksClear(signal)) return false;
  const { delayMinutes, ratio, level } = trafficMeta(signal);
  return level === 'slow' || delayMinutes > 2 || ratio >= 1.12;
}

function googleLooksHeavy(signal = null) {
  if (!signal) return false;
  if (googleLooksClear(signal)) return false;
  const { delayMinutes, ratio, level } = trafficMeta(signal);
  return level === 'heavy' || delayMinutes >= 8 || ratio >= 1.35;
}

function cameraLooksClear(signal = null) {
  if (!signal) return false;
  const meta = signal.metadata || {};
  const wait = Number(signal.normalizedWaitMin || 0);
  const queue = Number(meta.queueVehicles ?? 0);
  const flow15 = Number(meta.flowVehicles15 ?? meta.passed15 ?? 0);
  return wait <= 12 && (queue <= 10 || flow15 >= 12);
}

function cameraShowsQueue(signal = null) {
  if (!signal) return false;
  const meta = signal.metadata || {};
  const wait = Number(signal.normalizedWaitMin || 0);
  const queue = Number(meta.queueVehicles ?? 0);
  const flow15 = Number(meta.flowVehicles15 ?? meta.passed15 ?? 0);

  // "Kolona vidljiva" is intentionally conservative. A few stopped cars in the
  // frame (for example Orašje HR→BiH) should not be presented as a full queue.
  // We only mark a strong camera queue when the camera-derived wait is clearly
  // high enough for a real delay, or when many vehicles are visible and flow is weak.
  return wait >= 25 || queue >= 22 || (queue >= 18 && flow15 <= 7);
}

// How long a camera reading may drive the band / wait. Kept SHORT so a queue that has since
// cleared cannot keep claiming "velika kolona": camera congestion is a real-time signal, not a
// 45-minute memory. A reading older than this is ignored by the fusion (the live camera-analytics
// card recomputes on every request, so the two stay consistent).
const CAMERA_SIGNAL_MAX_AGE_MS = Math.max(5, Number(process.env.CAMERA_SIGNAL_MAX_AGE_MINUTES || 18)) * 60 * 1000;

function isFreshCameraSourceSnapshot(item = {}) {
  const fetchedAt = item.fetchedAt || item.createdAt;
  const ageMs = fetchedAt ? Date.now() - new Date(fetchedAt).getTime() : Infinity;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= CAMERA_SIGNAL_MAX_AGE_MS;
}

function estimateRangeFromSignals(wait, { googleSignal = null, cameraSignal = null, publicSignals = [], reports = [] } = {}) {
  const finalWait = clampWait(wait);
  if (finalWait === null) return { rangeMin: null, rangeMax: null, confidenceHint: 'low' };
  let spread = 8;
  let confidenceHint = 'medium';
  if (reports.length >= 2) {
    spread = 6;
    confidenceHint = 'medium-high';
  } else if (googleLooksClear(googleSignal) && cameraLooksClear(cameraSignal)) {
    spread = 5;
    confidenceHint = 'medium-high';
  } else if (googleSignal && cameraSignal) {
    spread = 7;
    confidenceHint = 'medium';
  } else if (publicSignals.length && publicSignals.every(isSoftUpperBoundSource)) {
    spread = 10;
    confidenceHint = 'low-medium';
  } else if (!googleSignal && !cameraSignal) {
    spread = 12;
    confidenceHint = 'low';
  }
  return {
    rangeMin: Math.max(0, finalWait - spread),
    rangeMax: Math.min(360, finalWait + spread + (googleLooksHeavy(googleSignal) ? 8 : 0)),
    confidenceHint,
  };
}

// Source-fusion sanity caps. Core rule: a clear/blue Google route only means the APPROACH
// road is flowing — the queue AT the border booth is invisible to Google Routes. Google may
// therefore CAP a low estimate ONLY when no higher-priority source disagrees:
//   - admin override / hard official public number (HAK/MUP/BIHAMK/AMS) ≥ 20 min
//   - strong camera queue
//   - recent driver report ≥ 35 min
// When any of those "authoritative" signals is present, Google must NOT pull the wait down;
// the fused value (which already reflects the authoritative source) is kept and floored at the
// official hard number. Without any authoritative signal the Google-colour model applies:
//   - Google blue (clear, delay ≤ 2 min)     → wait ≤ 15 min
//   - Google yellow/orange (slow)            → wait ≤ 35 min
//   - Google red (heavy)                     → no cap
const GOOGLE_VS_OFFICIAL_NOTE = 'Google promet izgleda protočno na prilaznoj cesti, ali službeni izvor/kamera pokazuje čekanje na samoj graničnoj kontroli.';

function applyTrafficSanityCaps(wait, { googleSignal = null, cameraSignal = null, publicSignals = [], reportAvg = null } = {}) {
  let finalWait = clampWait(wait);
  if (finalWait === null) return { wait: null, adjusted: false, reason: '' };

  const hasDriverReports = reportAvg !== null;
  const strongReport = hasDriverReports && Number(reportAvg) >= 35;
  const softPublicOnly = publicSignals.length > 0 && publicSignals.every(isSoftUpperBoundSource);
  const hardPublicSignals = publicSignals.filter((item) => !isSoftUpperBoundSource(item) && Number(item.normalizedWaitMin || 0) >= 20);
  const hasHardPublic = hardPublicSignals.length > 0;
  const hardPublicMax = hasHardPublic ? Math.max(...hardPublicSignals.map((item) => Number(item.normalizedWaitMin || 0))) : 0;
  const clearGoogle = googleLooksClear(googleSignal);
  const slowGoogle = googleLooksSlow(googleSignal) && !googleLooksHeavy(googleSignal);
  const clearCamera = cameraLooksClear(cameraSignal);
  const strongCameraQueue = cameraShowsQueue(cameraSignal);

  // Heavy Google traffic = visible congestion → trust the fused value as-is.
  if (googleLooksHeavy(googleSignal)) return { wait: finalWait, adjusted: false, reason: '' };

  // === AUTHORITATIVE OVERRIDE — Google never caps a real booth queue ===
  // If an official hard number, a strong camera queue, or a recent strong driver report
  // exists, the booth wait is real even when the approach road is blue. Keep the fused
  // value and never let it fall below the official hard number.
  const hasAuthoritative = hasHardPublic || strongCameraQueue || strongReport;
  if (hasAuthoritative) {
    const floored = hasHardPublic ? Math.max(finalWait, clampWait(hardPublicMax)) : finalWait;
    return {
      wait: floored,
      adjusted: floored !== finalWait,
      reason: clearGoogle ? GOOGLE_VS_OFFICIAL_NOTE : '',
      googleVsOfficial: clearGoogle,
    };
  }

  // Soft official + clear/blue Google: Google is a HELPER, never a downward authority. It must not
  // pull the blended estimate BELOW the official's own number (now that scheduled Google snapshots
  // enter every fusion, a clear approach was dragging "do 30 → ~11" down to ~8). Keep ≥ the soft
  // official value so "Google normal ne spušta official". A jam/slow Google still raises elsewhere.
  if (softPublicOnly && !hasDriverReports && (clearGoogle || !googleSignal)) {
    const softMax = clampWait(Math.max(...publicSignals.map((item) => Number(item.normalizedWaitMin || 0))));
    if (softMax !== null && softMax > finalWait) {
      return { wait: softMax, adjusted: true, reason: '' };
    }
  }

  // Any (non-strong) driver report present but no authoritative signal → still trust it,
  // reports are first-hand evidence the road API can miss.
  if (hasDriverReports) return { wait: finalWait, adjusted: false, reason: '' };

  // === Google BLUE (clear road) → max 15 min ===
  if (clearGoogle && finalWait > 15) {
    return { wait: 15, adjusted: true, reason: 'Google promet je normalan (plava ruta) i nema službenog signala ni vidljive kolone na kameri; čekanje se zadržava na najviše 15 min.' };
  }

  // === Google YELLOW/ORANGE (slow road) → max 35 min ===
  if (slowGoogle && finalWait > 35) {
    return { wait: 35, adjusted: true, reason: 'Google promet je pojačan ali ne kritičan; bez tvrdog signala iz drugih izvora čekanje se zadržava ispod 35 min.' };
  }

  // === No Google snapshot at all (refresh failed / stale > 8h) ===
  // The route panel may still show fresh Google colour, but the wait pipeline does not.
  // Fall back to conservative caps based on camera + soft public.
  if (!googleSignal && clearCamera) {
    const capped = Math.min(finalWait, 18);
    return { wait: capped, adjusted: capped !== finalWait, reason: 'Live prometna provjera trenutno nedostaje, ali kamera ne pokazuje kolonu.' };
  }
  if (!googleSignal && cameraSignal && softPublicOnly) {
    const capped = Math.min(finalWait, 22);
    return { wait: capped, adjusted: capped !== finalWait, reason: 'Live prometna provjera nedostaje; kombiniramo soft procjene iz javnih izvora i kameru bez vidljive kolone.' };
  }
  if (!googleSignal && softPublicOnly) {
    const capped = Math.min(finalWait, 24);
    return { wait: capped, adjusted: capped !== finalWait, reason: 'Live prometna provjera nedostaje; oslanjamo se na soft procjene iz javnih izvora.' };
  }

  return { wait: finalWait, adjusted: false, reason: '' };
}

// Builds a single Google source snapshot from a freshly computed route payload.
// Extracted so the /api/routes/:crossingId handler can re-use the same shape when a
// user opens the detail view — we immediately persist that fresh signal so the wait
// estimator no longer relies on an aged scheduler snapshot.
function buildGoogleSnapshotFromRoute(crossing, direction, payload) {
  const route = payload?.routes?.[0];
  if (!route) return null;
  const googleDelay = Math.max(0, Number(route.delayMinutes || 0));
  const ratio = Math.max(0.1, Number(route.ratio || 1) || 1);
  const estimate = estimateWaitFromGoogleRoute(route);
  const estimatedWait = clampWait(estimate.wait);
  // Near-border traffic from the (control-zone-sliced) route's preserved speedReadingIntervals.
  const ts = route.trafficSummary || null;
  const worst = ts?.worstTrafficLevel || 'UNKNOWN';
  const googleTrafficSeverity = worst === 'TRAFFIC_JAM' ? 'jam' : worst === 'SLOW' ? 'slow' : worst === 'NORMAL' ? 'clear' : 'unknown';
  // ── GOOGLE TRAFFIC v2: border-SEGMENT delay, multi-sampled across the route variants ─────────
  // Compute the segment-delay model per available route (primary + variants) and aggregate so a
  // single mis-routed sample can't dominate. Stored on the snapshot for the v2 fusion + admin debug.
  let googleTrafficV2 = null;
  if (GOOGLE_TRAFFIC_V2_ENABLED) {
    try {
      const anchor = crossing.anchors?.[direction] || crossing.anchors?.toBih || {};
      const samples = (payload.routes || []).map((r) => computeGoogleTrafficV2(r, anchor));
      googleTrafficV2 = { ...aggregateGoogleSamples(samples), primary: samples[0] || null };
    } catch (error) {
      googleTrafficV2 = { fallbackReason: `v2-error:${error.message}`.slice(0, 80), confidence: 0 };
    }
  }
  return {
    crossingId: crossing.id,
    direction,
    sourceName: 'Google Routes',
    sourceType: 'google-traffic-estimate',
    sourceUrl: '',
    rawStatus: `Google traffic ${estimate.level}; delay ${googleDelay} min u kontrolnoj zoni; route ratio ${ratio}`,
    rawText: `${payload.source || 'Google Routes API'} · ${payload.note || ''}`.slice(0, 1200),
    rawWaitMin: estimatedWait,
    normalizedWaitMin: estimatedWait,
    confidence: Math.max(46, Math.min(78, estimate.confidence + (route.routeGuard?.ok ? 4 : 0))),
    weight: estimate.weight,
    metadata: {
      adapter: 'google-routes-zone-estimate',
      durationMinutes: route.durationMinutes,
      staticMinutes: route.staticMinutes,
      delayMinutes: route.delayMinutes,
      distanceKm: route.distanceKm,
      ratio,
      level: estimate.level,
      rangeMin: estimate.rangeMin,
      rangeMax: estimate.rangeMax,
      reason: estimate.reason,
      routeGuard: route.routeGuard || null,
      // Structured near-border traffic signal (helper only — never a booth-wait authority).
      googleTrafficSeverity,
      trafficSummary: ts,
      worstTrafficLevel: worst,
      slowMeters: ts?.slowMeters ?? 0,
      jamMeters: ts?.jamMeters ?? 0,
      affectedRatio: ts?.affectedRatio ?? 0,
      googleTrafficV2,
    },
    fetchedAt: new Date().toISOString(),
  };
}

async function buildGoogleTrafficSnapshots() {
  if (!GOOGLE_TRAFFIC_ESTIMATE_ENABLED || !serverKey) return [];
  const jobs = [];
  for (const crossing of Object.values(BORDER_CROSSINGS)) {
    for (const direction of ['toBih', 'toHr']) jobs.push({ crossing, direction });
  }
  const snapshots = await mapWithConcurrency(jobs, GOOGLE_TRAFFIC_REFRESH_CONCURRENCY, async ({ crossing, direction }) => {
    const payload = await computeCrossingRoutes(crossing.id, direction);
    return buildGoogleSnapshotFromRoute(crossing, direction, payload);
  });
  return snapshots.filter(Boolean);
}

async function refreshProductionSources({ force = false } = {}) {
  if (!SOURCE_FETCH_ENABLED) return { ok: true, skipped: true, reason: 'SOURCE_FETCH_ENABLED=false', snapshots: [] };
  const now = Date.now();
  // NEVER overlap a full refresh — if one is in flight, every caller (forced or not) joins it. This
  // is what stops the public-state poll + an admin forced refresh from running two camera/CV bursts
  // at once. `force` only bypasses the throttle interval below, not the in-flight guard.
  if (sourceRefreshState.running) return sourceRefreshState.running;
  if (!force && now - sourceRefreshState.lastRunAt < SOURCE_REFRESH_INTERVAL_MS) return { ok: true, skipped: true, reason: 'fresh-enough', snapshots: [] };

  sourceRefreshState.running = (async () => {
    const results = await Promise.allSettled([
      fetchHakSnapshots(),
      fetchBihamkSnapshots(),
      fetchAmsRsSnapshots(),
      // A forced refresh (admin button) must re-fetch the live camera frame, not reuse a cached one.
      buildCameraSourceSnapshots({ forceSnapshot: force }),
      buildGoogleTrafficSnapshots(),
    ]);
    const snapshots = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason?.message || String(result.reason));
    const stored = await insertSourceSnapshots(snapshots);
    // Auto-hygiene: shed stale snapshots (age) + legacy/suspicious public-text bleed artifacts
    // (content) every cycle, so nobody has to DELETE on production.
    await pruneStaleSourceSnapshots();
    if (PRUNE_SUSPICIOUS_PUBLIC_SNAPSHOTS) await pruneSuspiciousPublicSourceSnapshots();
    sourceRefreshState.lastRunAt = Date.now();
    sourceRefreshState.lastError = failures.join(' | ');
    return { ok: failures.length === 0, snapshots: stored, failures, refreshedAt: new Date().toISOString() };
  })().finally(() => {
    sourceRefreshState.running = null;
  });
  return sourceRefreshState.running;
}

function vehicleMultiplier(crossing, direction, vehicle) {
  const key = vehicleKey(vehicle);
  const car = Number(crossing.waits?.[direction]?.car || 1);
  const vehicleWait = Number(crossing.waits?.[direction]?.[key] || car);
  return Math.max(0.55, Math.min(2.4, vehicleWait / Math.max(car, 1)));
}

function reportSignals(store, crossingId, direction, hours = 2) {
  const since = Date.now() - hours * 60 * 60 * 1000;
  return (store.reports || [])
    .filter((report) => report.crossingId === crossingId && report.direction === direction && new Date(report.createdAt).getTime() >= since)
    .slice(0, 20);
}

function choosePublicSourceSignal(snapshots = []) {
  const candidates = snapshots
    .filter((item) => item.normalizedWaitMin !== null && item.normalizedWaitMin !== undefined)
    .map((item) => ({ ...item, score: Number(item.confidence || 0) * Number(item.weight || 1) }))
    .sort((a, b) => b.score - a.score || new Date(b.fetchedAt).getTime() - new Date(a.fetchedAt).getTime());
  return candidates[0] || null;
}

function sourceDisplayName(sourceName = '') {
  const name = String(sourceName || '').trim();
  if (!name) return 'Izvor';
  if (/kamera/i.test(name)) return 'Kamera';
  return name;
}

function waitForVehicle(wait, multiplier, vehicle = 'car') {
  return clampWait(Number(wait || 0) * (vehicleKey(vehicle) === 'car' ? 1 : multiplier));
}

function weightedWait(candidates = []) {
  const valid = candidates.filter((item) => Number.isFinite(Number(item.wait)) && Number.isFinite(Number(item.weight)) && Number(item.weight) > 0);
  if (!valid.length) return null;
  const totalWeight = valid.reduce((sum, item) => sum + Number(item.weight), 0);
  const total = valid.reduce((sum, item) => sum + Number(item.wait) * Number(item.weight), 0);
  return clampWait(Math.round(total / Math.max(totalWeight, 0.1)));
}

function uniqueSignalNames(candidates = []) {
  return [...new Set(candidates.map((item) => item.label).filter(Boolean))];
}

// Age decay: a signal's effective weight shrinks exponentially with its age in minutes.
// halfLifeMinutes=25 means a 25-min-old signal carries 50% weight, 50-min-old 25%, etc.
// This prevents stale snapshots from dragging the estimate when fresh data exists.
function ageDecayMultiplier(fetchedAt, halfLifeMinutes = 25) {
  if (!fetchedAt) return 0.5;
  const ageMs = Date.now() - new Date(fetchedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return 1;
  const ageMin = ageMs / 60000;
  return Math.pow(0.5, ageMin / halfLifeMinutes);
}

// Trimmed-mean wait from the last N camera snapshots within the freshness window.
// Drops the highest and lowest before averaging; resilient to a single bad frame
// (sun glare, truck blocking ROI, etc.). Falls back to single signal when N<3.
function trimmedMeanCameraSignal(snapshots = []) {
  const valid = snapshots
    .filter((item) => item && Number.isFinite(Number(item.normalizedWaitMin)))
    .sort((a, b) => new Date(b.fetchedAt).getTime() - new Date(a.fetchedAt).getTime())
    .slice(0, 5);
  if (!valid.length) return null;
  if (valid.length < 3) return valid[0];
  const sorted = [...valid].sort((a, b) => Number(a.normalizedWaitMin) - Number(b.normalizedWaitMin));
  const trimmed = sorted.slice(1, -1);
  const avgWait = Math.round(trimmed.reduce((sum, item) => sum + Number(item.normalizedWaitMin), 0) / trimmed.length);
  const avgConfidence = Math.round(trimmed.reduce((sum, item) => sum + Number(item.confidence || 60), 0) / trimmed.length);
  const totalQueue = trimmed.reduce((sum, item) => sum + Number(item.metadata?.queueVehicles || 0), 0) / trimmed.length;
  const totalFlow = trimmed.reduce((sum, item) => sum + Number(item.metadata?.flowVehicles15 ?? item.metadata?.passed15 ?? 0), 0) / trimmed.length;
  const newest = valid[0];
  return {
    ...newest,
    normalizedWaitMin: avgWait,
    confidence: avgConfidence,
    metadata: {
      ...(newest.metadata || {}),
      queueVehicles: Math.round(totalQueue),
      flowVehicles15: Math.round(totalFlow),
      passed15: Math.round(totalFlow),
      cameraSnapshotsAveraged: trimmed.length,
    },
  };
}

// Cross-source agreement: when independent public sources agree within ±5 min,
// boost confidence. When they disagree by >25 min, penalise.
function crossSourceAgreement(publicSignals = []) {
  const waits = publicSignals
    .filter((item) => Number.isFinite(Number(item.normalizedWaitMin)))
    .map((item) => Number(item.normalizedWaitMin));
  if (waits.length < 2) return { boost: 0, spread: 0, agreement: 'single-source' };
  const spread = Math.max(...waits) - Math.min(...waits);
  if (spread <= 5) return { boost: 15, spread, agreement: 'strong' };
  if (spread <= 12) return { boost: 6, spread, agreement: 'moderate' };
  if (spread > 25) return { boost: -10, spread, agreement: 'conflicting' };
  return { boost: 0, spread, agreement: 'weak' };
}

async function effectiveBorderSignal(crossing, direction = 'toBih', vehicle = 'car', storeInput = null, extraSourceSnapshots = []) {
  const store = storeInput || await readAppStore();
  const overrideKey = `${crossing.id}:${direction}`;
  const multiplier = vehicleMultiplier(crossing, direction, vehicle);
  const staticWait = borderDelay(crossing, direction, vehicle);

  if (Object.prototype.hasOwnProperty.call(store.overrides || {}, overrideKey)) {
    const wait = clampWait(Number(store.overrides[overrideKey]) * (vehicleKey(vehicle) === 'car' ? 1 : multiplier));
    return {
      wait,
      label: 'Admin potvrđeno',
      className: 'manual',
      sourceType: 'admin-override',
      confidence: 98,
      note: 'Ručna vrijednost operatera ima najveći prioritet.',
      signals: [],
      updatedAt: new Date().toISOString(),
    };
  }

  const storedSources = await readLatestSourceSnapshots(crossing.id, direction, 8);
  const requestSources = (Array.isArray(extraSourceSnapshots) ? extraSourceSnapshots : [])
    .map((item) => normalizeSourceSnapshot({ ...item, crossingId: item.crossingId || crossing.id, direction: item.direction || direction }))
    .filter((item) => item.crossingId === crossing.id && item.direction === direction);
  const latestSources = [...requestSources, ...storedSources];
  // Re-normalize any legacy public snapshots that pre-date the soft-bound parser fix
  // (e.g., a stored "Pojačan = 45 min HARD" entry from yesterday's run).
  const publicSignalsRaw = latestSources.filter((item) => !['camera-snapshot-model', 'google-traffic-estimate'].includes(item.sourceType) && item.normalizedWaitMin !== null && item.normalizedWaitMin !== undefined);
  const publicSignals = publicSignalsRaw.map(sanitizeLegacyPublicSignal);
  // Camera: use trimmed-mean of last 5 snapshots within the 8h window to reject outliers.
  const cameraSnapshots = latestSources
    .filter((item) => item.sourceType === 'camera-snapshot-model')
    .filter(isFreshCameraSourceSnapshot);
  const cameraSignal = trimmedMeanCameraSignal(cameraSnapshots) || choosePublicSourceSignal(cameraSnapshots);
  // Visual congestion: the worst queue band any camera VISUALLY shows for this direction —
  // even visual-only cameras (no wait). Used to flag a conflict when the wait is low but the
  // camera clearly shows a big queue (the Maljevac case). Carries no wait, never a candidate.
  const visualBand = worstQueueBand(
    latestSources
      .filter((item) => item.sourceType === 'camera-visual')
      .filter(isFreshCameraSourceSnapshot)
      .map((item) => item.metadata?.queueBand)
  );
  const googleSignal = choosePublicSourceSignal(latestSources.filter((item) => item.sourceType === 'google-traffic-estimate'));
  const rawReports = reportSignals(store, crossing.id, direction, 2);
  // ── TRUST ENGINE + ANTI-FAKE (spec §6, §12) ────────────────────────────────
  // 1) Collapse near-duplicate spam from a single user/device (one person must not
  //    be able to swing the wait by re-submitting). 2) Drop anomalies that sit far
  //    from the cohort consensus. 3) Average what remains by TRUST, not by count,
  //    so a GPS-verified measured session outweighs an anonymous tap.
  const dedupedReports = dedupeReports(rawReports.map((r) => ({ ...r, userId: r.user?.id })));
  const reportMeanRef = dedupedReports.length ? Math.round(dedupedReports.reduce((s, r) => s + Number(r.wait || 0), 0) / dedupedReports.length) : null;
  const { anomalies } = detectReportAnomalies(dedupedReports, reportMeanRef);
  const anomalyIds = new Set(anomalies.map((a) => a.id));
  const reports = dedupedReports.filter((r) => !anomalyIds.has(r.id));
  const ageMinutesOf = (ts) => ts ? (Date.now() - new Date(ts).getTime()) / 60000 : 0;
  const reportTrust = new Map();
  reports.forEach((r) => {
    const t = computeReportTrust(
      { wait: r.wait, measured: r.measured, gpsVerified: r.gpsVerified, userId: r.user?.id, anonymous: !r.user?.id, ageMinutes: ageMinutesOf(r.createdAt) },
      { referenceWait: reportMeanRef, userReportCount: 0 }
    );
    reportTrust.set(r.id, t.trust);
  });
  const trustTotal = reports.reduce((s, r) => s + (reportTrust.get(r.id) || 0), 0);
  const reportAvg = trustTotal > 0
    ? Math.round(reports.reduce((s, r) => s + Number(r.wait || 0) * (reportTrust.get(r.id) || 0), 0) / trustTotal)
    : (reports.length ? Math.round(reports.reduce((s, r) => s + Number(r.wait || 0), 0) / reports.length) : null);
  const avgReportTrust = reports.length ? trustTotal / reports.length : 0;
  const measuredCount = reports.filter((r) => r.measured).length;
  // Accept a single fresh driver report (<30 min) as a low-weight signal; previously we required ≥2.
  const freshReports = reports.filter((r) => Date.now() - new Date(r.createdAt).getTime() < 30 * 60 * 1000);
  const acceptReports = reports.length >= 2 || freshReports.length >= 1;

  // Source-fusion priority. Official hard numbers (HAK/MUP/BIHAMK/AMS ≥ 20 min), a strong
  // camera queue, or a recent strong driver report (≥ 35 min) are AUTHORITATIVE about the
  // booth wait. When any is present, Google Routes is demoted to a helper (heavy weight
  // penalty) so a blue/clear approach road cannot dilute or cap down the real wait.
  const hardPublicForFusion = publicSignals.filter((item) => !isSoftUpperBoundSource(item) && Number(item.normalizedWaitMin || 0) >= 20);
  const hasHardPublicSignal = hardPublicForFusion.length > 0;
  const strongCameraQueueSignal = cameraShowsQueue(cameraSignal);
  const strongRecentReport = acceptReports && reportAvg !== null && reportAvg >= 35;
  // A GPS-verified measured pass is ground truth — always authoritative regardless of value.
  const hasMeasuredSession = measuredCount > 0;
  const authoritativePresent = hasHardPublicSignal || strongCameraQueueSignal || strongRecentReport || hasMeasuredSession;

  const candidates = [];
  publicSignals.forEach((item) => {
    const softUpperBound = isSoftUpperBoundSource(item);
    const ageMult = ageDecayMultiplier(item.fetchedAt);
    candidates.push({
      wait: waitForVehicle(item.normalizedWaitMin, multiplier, vehicle),
      weight: Math.max(0.1, Number(item.weight || 1)) * Math.max(35, Number(item.confidence || 70)) * (softUpperBound ? 0.82 : 1.15) * ageMult,
      label: sourceDisplayName(item.sourceName),
      sourceType: item.sourceType,
      softUpperBound,
      updatedAt: item.fetchedAt,
      ageMultiplier: ageMult,
      kind: 'official',
      tier: 'official',
      confidence: Number(item.confidence || 70),
    });
  });
  if (cameraSignal) {
    const ageMult = ageDecayMultiplier(cameraSignal.fetchedAt);
    candidates.push({
      wait: waitForVehicle(cameraSignal.normalizedWaitMin ?? staticWait, multiplier, vehicle),
      weight: Math.max(0.1, Number(cameraSignal.weight || 0.72)) * Math.max(35, Number(cameraSignal.confidence || 58)) * (publicSignals.length ? 0.9 : 1.08) * (googleLooksClear(googleSignal) && cameraLooksClear(cameraSignal) ? 1.18 : 1) * ageMult,
      label: 'Kamera',
      sourceType: cameraSignal.sourceType,
      updatedAt: cameraSignal.fetchedAt,
      ageMultiplier: ageMult,
      kind: 'camera',
      tier: 'camera',
      confidence: Number(cameraSignal.confidence || 58),
      stale: Boolean(cameraSignal.metadata?.stale),
      directionVerified: true,
      heuristic: !cvEndpoint,
    });
  }
  if (googleSignal) {
    const ageMult = ageDecayMultiplier(googleSignal.fetchedAt, 18);
    // Google is a helper, never the lead when authoritative signals exist: drop its weight
    // to ~12% so the fused value stays close to the official/camera/report number.
    const googlePriorityFactor = authoritativePresent ? 0.12 : (publicSignals.length ? 0.86 : 1.02);
    candidates.push({
      wait: waitForVehicle(googleSignal.normalizedWaitMin ?? staticWait, multiplier, vehicle),
      weight: Math.max(0.1, Number(googleSignal.weight || 0.84)) * Math.max(35, Number(googleSignal.confidence || 62)) * googlePriorityFactor * ageMult,
      label: 'Google',
      sourceType: googleSignal.sourceType,
      updatedAt: googleSignal.fetchedAt,
      ageMultiplier: ageMult,
      kind: 'google',
      tier: 'google',
      confidence: Number(googleSignal.confidence || 62),
    });
  }
  if (reportAvg !== null && acceptReports) {
    // Single fresh report ≈ weight 38; two reports ≈ 50; saturates at 90. Then scaled by
    // average TRUST (measured/GPS pushes it up, low-trust anonymous taps pull it down) and
    // given a strong floor when a measured session is present (ground truth).
    const baseWeight = Math.min(90, 28 + reports.length * 11 + (freshReports.length ? 10 : 0));
    const trustScaled = baseWeight * (0.55 + avgReportTrust);
    const weight = hasMeasuredSession ? Math.min(140, Math.max(trustScaled, 110)) : Math.min(95, trustScaled);
    candidates.push({
      wait: waitForVehicle(reportAvg, multiplier, vehicle),
      weight,
      label: measuredCount > 0 ? 'Izmjereno' : 'Dojave',
      sourceType: measuredCount > 0 ? 'measured-wait' : 'driver-reports',
      updatedAt: reports[0]?.createdAt || new Date().toISOString(),
      kind: measuredCount > 0 ? 'measured' : 'report',
      tier: measuredCount > 0 ? 'measured' : 'report',
      confidence: measuredCount > 0 ? 88 : 60,
      trust: avgReportTrust,
      flags: (measuredCount > 0 && reports.some((r) => r.measured && r.gpsVerified)) ? ['gps'] : [],
    });
  }

  const blendedWait = weightedWait(candidates);
  if (blendedWait !== null) {
    const sanity = applyTrafficSanityCaps(blendedWait, { googleSignal, cameraSignal, publicSignals, reportAvg });
    // Learned bias correction (V5 §2): nudge the fused value toward what measured waits
    // historically showed for this crossing/direction/hour. OFF until enough data + operator opt-in.
    const biasResult = applyBiasCorrection(crossing.id, direction, sanity.wait);
    let finalWait = biasResult.wait;
    const signalNames = uniqueSignalNames(candidates);
    const hasMultipleOfficialSources = uniqueSignalNames(candidates.filter((item) => item.sourceType === 'public-text-status')).length > 1;
    const combined = signalNames.length > 1 || hasMultipleOfficialSources;
    const bestCandidate = [...candidates].sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0))[0];
    const agreement = crossSourceAgreement(publicSignals);

    // ── CONFIDENCE ENGINE (spec §3) ──────────────────────────────────────────
    // Assemble every contributing signal into the pure confidence engine. It returns a
    // level (visoka/srednja/niska/nedovoljno), a 0-99 score, a precision decision
    // (exact number vs range vs "ne znam"), and a transparent factor breakdown.
    const cameraStale = Boolean(cameraSignal?.metadata?.stale);
    const confidenceSignals = [];
    publicSignals.forEach((item) => confidenceSignals.push({ kind: 'official', wait: item.normalizedWaitMin, ageMinutes: ageMinutesOf(item.fetchedAt), confidence: item.confidence, soft: isSoftUpperBoundSource(item) }));
    if (cameraSignal) confidenceSignals.push({ kind: 'camera', wait: cameraSignal.normalizedWaitMin, ageMinutes: ageMinutesOf(cameraSignal.fetchedAt), confidence: cameraSignal.confidence, stale: cameraStale, queue: cameraSignal.metadata?.queueVehicles });
    if (googleSignal) confidenceSignals.push({ kind: 'google', wait: googleSignal.normalizedWaitMin, ageMinutes: ageMinutesOf(googleSignal.fetchedAt), confidence: googleSignal.confidence });
    reports.forEach((r) => confidenceSignals.push({ kind: r.measured ? 'measured' : 'report', wait: r.wait, ageMinutes: ageMinutesOf(r.createdAt), confidence: r.measured ? 88 : 60, trust: reportTrust.get(r.id) }));
    // Spread among "hard" (booth-truthful) sources for the agreement bonus/penalty.
    const hardWaits = [];
    publicSignals.filter((p) => !isSoftUpperBoundSource(p)).forEach((p) => hardWaits.push(Number(p.normalizedWaitMin)));
    if (cameraSignal && !cameraStale) hardWaits.push(Number(cameraSignal.normalizedWaitMin));
    reports.filter((r) => r.measured).forEach((r) => hardWaits.push(Number(r.wait)));
    const agreementSpread = hardWaits.length >= 2 ? Math.max(...hardWaits) - Math.min(...hardWaits) : undefined;
    const profile = computeConfidenceProfile({ signals: confidenceSignals, agreementSpread });

    // ── CONFIDENCE CALIBRATION (spec V5 §7) ──────────────────────────────────
    // Structural downgrades + empirical calibration have the LAST word. HIGH is granted
    // only when proven by historical measured accuracy; otherwise it is capped at MEDIUM.
    const cameraHeuristicOnly = Boolean(cameraSignal) && !cvEndpoint && !hasHardPublicSignal && !hasMeasuredSession;
    const googleOnly = Boolean(googleSignal) && !cameraSignal && publicSignals.length === 0 && !hasMeasuredSession;
    const calibrated = resolveCalibratedConfidence(profile, {
      crossingId: crossing.id,
      direction,
      sourceMix: { hasCamera: Boolean(cameraSignal), hasGoogle: Boolean(googleSignal), hasHardPublic: hasHardPublicSignal, hasMeasured: hasMeasuredSession },
      conflictSpread: Number.isFinite(agreementSpread) ? agreementSpread : 0,
      cameraStale,
      cameraHeuristicOnly,
      queueBand: cameraSignal?.metadata?.queueBand,
      googleOnly,
      singleSource: profile.independentSources <= 1,
      hasRecentMeasured: hasMeasuredSession,
    });
    const calibratedProfile = { level: calibrated.level, precision: calibrated.precision, score: calibrated.score };
    const confidenceHint = calibrated.level === 'visoka' ? 'high' : calibrated.level === 'srednja' ? 'medium' : 'low';

    // ── CAMERA-CLEAR LOW OVERRIDE (camera > google; also refines a SOFT official estimate) ──
    // When the direction-relevant camera frame is fresh and clearly EMPTY (band nema/mala) but
    // the number comes only from weak signals — Google, a SOFT public estimate ("zadržavanja
    // nisu duža od 30 min"), historical or driver reports — trust what the camera plainly shows
    // and lower the wait to the frame's own estimate. Honours the source priority: it NEVER
    // overrides a HARD official number, a measured session or an admin value (those outrank the
    // camera). This is the "kamera prazna → reci da je prazno" behaviour, instead of only warning.
    // HARD authority that outranks the camera: a hard (non-soft) official number OR a measured
    // session. Soft public estimates, Google, historical and reports do NOT block the camera.
    const hardAuthorityForCamera = hasMeasuredSession || !publicSignals.every(isSoftUpperBoundSource);
    const cameraDisplayWait = cameraSignal ? clampWait(waitForVehicle(cameraSignal.normalizedWaitMin ?? 0, multiplier, vehicle)) : null;
    const cameraClearResult = resolveCameraClearOverride({
      visualBand,
      cameraClear: Boolean(cameraSignal) && cameraLooksClear(cameraSignal),
      cameraStale,
      cameraWait: cameraDisplayWait,
      currentWait: finalWait,
      hardAuthorityPresent: hardAuthorityForCamera,
    });
    const cameraClearOverride = cameraClearResult.override;
    finalWait = cameraClearResult.wait;

    // ── CAMERA-CONGESTION HIGH OVERRIDE (commit to a number; symmetric to clear-low) ──────────
    // The app must give a real number, not "provjeri službene izvore". When the direction-relevant
    // camera VISUALLY shows a queue (velika/ekstremna) but the current number is low, raise it to a
    // camera-led estimate (camera's own wait, floored by the band). Same priority gate as above.
    const cameraCongestionResult = resolveCameraCongestionOverride({
      visualBand,
      cameraWait: cameraDisplayWait,
      currentWait: finalWait,
      // RAISING on a visibly extreme queue is blocked ONLY by truly authoritative LIVE ground truth —
      // a measured GPS session (admin overrides already short-circuit earlier). A coarse/lagging public
      // text estimate (BIHAMK/AMS) must NOT keep a low number when the live camera shows a packed border;
      // the fresh camera is the differentiator vs services that only echo the official figure.
      hardAuthorityPresent: hasMeasuredSession,
      // Google measures the APPROACH road; a jam there reinforces a camera-visible booth queue.
      googleHeavyNearBorder: googleLooksHeavy(googleSignal),
    });
    const cameraCongestionOverride = cameraCongestionResult.override;
    finalWait = cameraCongestionResult.wait;
    // The committed camera floor is a HARD MINIMUM for everything downstream (predictionV2, baseline,
    // smoothing, public state). Nothing may lower the number below what the camera-congestion
    // label/decision already promised — otherwise the UI shows "od 3 min" while saying "kamera vidi
    // gužvu" (the live NO-GO). Captured here so the invariant can be re-asserted after every later step.
    const cameraCongestionFloor = cameraCongestionOverride ? Number(finalWait) : null;

    // ── SMART RANGE (spec §8) ── never show false precision below high confidence.
    const range = computeSmartRange(finalWait, calibratedProfile, { agreementSpread, heavyGoogle: googleLooksHeavy(googleSignal) });

    // ── SOURCE EXPLANATION (spec §4) ── always say WHY.
    const explanation = buildSourceExplanation({
      official: publicSignals.length > 0,
      officialSoft: publicSignals.length > 0 && publicSignals.every(isSoftUpperBoundSource),
      cameraQueue: cameraShowsQueue(cameraSignal),
      cameraClear: Boolean(cameraSignal) && cameraLooksClear(cameraSignal),
      cameraStale,
      googleClear: googleLooksClear(googleSignal),
      googleHeavy: googleLooksHeavy(googleSignal),
      reportCount: reports.filter((r) => !r.measured).length,
      measuredCount,
      googleClearWhileQueue: Boolean(sanity.googleVsOfficial),
      disagreement: agreement.agreement === 'conflicting' || (Number.isFinite(agreementSpread) && agreementSpread > 28),
    });
    // The cap note (e.g. "Google clear → ≤15") is informative when it isn't already the
    // google-vs-official caveat the explanation engine added itself.
    const capReason = sanity.googleVsOfficial ? '' : (sanity.reason || '');

    // ── STRUCTURED EXPLANATION PAYLOAD (spec V5 §3/§4) ───────────────────────
    // Project each fusion candidate into a descriptor and build the "why this estimate?"
    // payload: per-source contribution %, trust, role, honest flags, conflict detection,
    // and whether Google acted as the wait authority (it must not when a booth signal exists).
    const explanationDescriptors = candidates.map((c) => ({
      kind: c.kind,
      tier: c.tier,
      label: c.label,
      value: c.wait,
      weight: c.weight,
      ageMinutes: ageMinutesOf(c.updatedAt),
      confidence: c.confidence,
      soft: c.softUpperBound,
      stale: c.stale,
      directionVerified: c.directionVerified,
      heuristic: c.heuristic,
      trust: c.trust,
      flags: c.flags,
    }));
    const explanationPayload = buildEstimateExplanation(explanationDescriptors, { summary: explanation });

    // ── CAMERA vs WAIT (always COMMIT to a number — never "provjeri službene izvore") ────────
    // The whole point of the app is to give a figure. When the camera has a clear read it LEADS:
    // it raised the number on a visible queue (cameraCongestionOverride) or lowered it on an empty
    // frame (cameraClearOverride) above. Here we only choose the wording + range; we never punt to
    // official sources. detectVisualCongestionConflict runs on the PRE-override (base) wait so the
    // visualCongestionConflict flag still tells the frontend the camera saw a queue.
    const baseFusedWait = biasResult.wait;
    const congestion = detectVisualCongestionConflict({ visualBand, fusedWait: baseFusedWait });
    const clearConflict = !congestion.conflict && detectCameraClearConflict({ visualBand, fusedWait: finalWait }).conflict;
    let outLevel = calibrated.level;
    let outPrecision = calibrated.precision;
    let outHint = confidenceHint;
    let outScore = calibrated.score;
    let outRangeMin = range.rangeMin;
    let outRangeMax = range.rangeMax;
    let note = capReason ? `${explanation} ${capReason}` : explanation;
    let conflictKind = null;
    const bandWord = visualBand === 'ekstremna' ? 'ekstremnu' : visualBand === 'srednja' ? 'moguću' : 'veliku';
    if (cameraCongestionOverride) {
      // Camera led: we COMMITTED to a higher, camera-based number. Confident estimate + tight
      // upward range. Keep the calibrated confidence (camera-heuristic, typically srednja/niska).
      conflictKind = 'camera-congestion';
      outPrecision = 'range';
      outRangeMin = Math.max(0, Math.min(finalWait, range.rangeMin ?? finalWait));
      outRangeMax = Math.max(range.rangeMax ?? finalWait, finalWait + (visualBand === 'ekstremna' ? 30 : 18));
      note = `${note} Kamera pokazuje ${bandWord} kolonu — procjenu smo podigli prema slici uživo.`;
    } else if (congestion.conflict) {
      // Camera shows a queue but a HARD official/measured number (which outranks the camera) is
      // low. Keep that authoritative figure, but say the camera sees more — committed number with
      // an upward range, never "check elsewhere".
      conflictKind = 'congestion';
      outPrecision = 'range';
      outRangeMin = Math.max(0, Math.min(finalWait, range.rangeMin ?? finalWait));
      outRangeMax = Math.max(range.rangeMax ?? finalWait, finalWait + 25, congestion.suggestedRangeMax);
      note = `${note} Kamera pokazuje ${bandWord} kolonu — stvarno čekanje može biti dulje od ${finalWait} min.`;
    } else if (clearConflict) {
      // A hard official/measured number is high but the camera is empty. Official outranks the
      // camera, so we keep the number — but say plainly the camera does not show that queue.
      conflictKind = 'clear-high';
      outPrecision = 'range';
      note = `${note} Kamera trenutno ne pokazuje kolonu koja bi objasnila ovako visoko čekanje.`;
    } else if (cameraClearOverride) {
      note = `${note} Kamera trenutno ne pokazuje kolonu ni vozila — procjenu smo snizili prema slici uživo.`;
    }

    // ── GOOGLE TRAFFIC helper signal (never authority; spec Google task §7) ──
    // Google measures the APPROACH road, not the booth. It may RAISE a conflict when the wait
    // looks low but Google shows a jam near the border, widen the range, lower confidence and
    // add an explanation — but it must never override admin/measured/official/camera.
    const googleTrafficSeverity = googleSignal?.metadata?.googleTrafficSeverity || 'unknown';
    const googleJamNearBorder = googleTrafficSeverity === 'jam';
    const googleSlowNearBorder = googleTrafficSeverity === 'slow';
    const googleJamMeters = Number(googleSignal?.metadata?.jamMeters || 0);
    const googleJamConflict = !congestion.conflict && !clearConflict && !cameraClearOverride && !cameraCongestionOverride && googleJamNearBorder && Number.isFinite(Number(finalWait)) && Number(finalWait) < 20;
    if (googleJamConflict) {
      conflictKind = 'google-jam';
      // A genuine red jam near the booth must NOT headline a tiny number ("od 6 min" next to a
      // visible column). Google's own time-delay averages the whole zone and is unreliable here, so
      // we floor the estimate by the LENGTH of the jam (a queue this long is minutes). Applied only
      // when no HARD official/measured value governs the wait and the booth camera isn't shown clear,
      // so an open road (jamMeters 0 → no jam severity) is never affected.
      if (!hardAuthorityForCamera) {
        const jamFloor = googleJamMeters >= 600 ? 22 : googleJamMeters >= 300 ? 16 : googleJamMeters >= 120 ? 12 : Number(finalWait);
        finalWait = Math.max(Number(finalWait), jamFloor);
      }
      outLevel = 'niska';
      outPrecision = 'range';
      outHint = 'low';
      outScore = Math.min(outScore, 36);
      outRangeMin = Math.max(0, Math.min(finalWait, range.rangeMin ?? finalWait));
      outRangeMax = Math.max(range.rangeMax ?? finalWait, finalWait + 20, 45);
      note = `${note} Google promet pokazuje gužvu na prilaznoj cesti (~${Math.round(googleJamMeters)} m kolone) — čekanje je vjerojatno ${finalWait} min ili više.`;
    }
    const visualConflict = congestion.conflict || clearConflict;

    // Structured Google-traffic explanation (helper signal, never authority).
    const cameraQueuePresent = cameraShowsQueue(cameraSignal) || congestion.conflict;
    const googleTraffic = {
      available: Boolean(googleSignal) && googleTrafficSeverity !== 'unknown',
      severity: googleTrafficSeverity,
      worstTrafficLevel: googleSignal?.metadata?.worstTrafficLevel || 'UNKNOWN',
      slowMeters: googleSignal?.metadata?.slowMeters ?? 0,
      jamMeters: googleSignal?.metadata?.jamMeters ?? 0,
      affectedRatio: googleSignal?.metadata?.affectedRatio ?? 0,
      usedAsFusionSignal: googleJamConflict,
      usedAsAuthority: false,
      note: !googleSignal
        ? 'Google promet nije dostupan za ovu rutu.'
        : googleJamNearBorder && cameraQueuePresent
          ? 'Kamera i Google promet zajedno upućuju na gužvu na prilazu.'
          : googleJamNearBorder
            ? 'Google promet pokazuje gužvu na prilazu (mjeri prilaznu cestu, ne nužno čekanje na kućici).'
            : googleSlowNearBorder
              ? 'Google promet pokazuje usporenje na prilazu.'
              : googleTrafficSeverity === 'clear'
                ? 'Google promet mjeri prilaznu cestu, ne nužno čekanje na samoj graničnoj kućici.'
                : 'Google promet nije dostupan za ovu rutu.',
    };
    explanationPayload.googleTraffic = googleTraffic;

    // ── TRAFFIC + VISION PREDICTION v2 (the differentiator) ──────────────────────────────────
    // Compute our OWN estimate from Google border-segment delay + YOLO queue model + chat/verified
    // ground truth, public only as fallback. SHADOW by default (attached for UI/admin); leads when
    // PREDICTION_V2_ENABLED. Fully wrapped — any failure keeps the legacy estimate.
    let predictionV2 = null;
    try {
      const gV2 = googleSignal?.metadata?.googleTrafficV2 || null;
      const allDirCams = CAMERA_FEEDS[crossing.id] || [];
      const dirCameras = allDirCams.filter((cam) => cameraRelevantForDirection(cam, direction, allDirCams));
      const roiFeatures = cameraSignal?.metadata?.roiFeatures || null;
      const multiFrame = cameraSignal?.metadata?.multiFrame || null;
      const roiCalibrated = YOLO_ROI_V2_ENABLED && (Boolean(roiFeatures?.roiCalibrated) || dirCameras.some((cam) => cameraHasQueueRoi(cam)));
      const mix = roiFeatures?.vehicleCountByClass || cameraSignal?.metadata?.vehicleMix15 || {};
      const heavy = Number(mix.trucks || 0) + Number(mix.buses || 0);
      const truckRatio = heavy / Math.max(1, heavy + Number(mix.cars || 0) + Number(mix.vans || 0));
      const cameraV2base = cameraSignal && !cameraStale ? estimateCameraWaitV2({
        vehiclesInQueueRoi: roiFeatures?.roiCalibrated ? roiFeatures.vehiclesInQueueRoi : (roiCalibrated ? cameraSignal.metadata?.queueVehicles : null),
        queueVehicles: roiFeatures?.vehiclesInQueueRoi ?? cameraSignal.metadata?.queueVehicles,
        visibleVehicleCount: roiFeatures?.visibleVehicleCount ?? cameraSignal.metadata?.visibleVehicles ?? cameraSignal.metadata?.queueVehicles,
        vehicleCountByClass: mix,
        roiCalibrated: Boolean(roiFeatures?.roiCalibrated || roiCalibrated),
        averageDetectionConfidence: roiFeatures?.averageDetectionConfidence != null ? roiFeatures.averageDetectionConfidence * 100 : cameraSignal.confidence,
        isNightOrLowLight: Boolean(roiFeatures?.isNightOrLowLight || cameraSignal.metadata?.isNightOrLowLight),
        multiFrame,
      }, { crossingId: crossing.id, direction, truckRatio }) : null;
      // Rich camera object for the source breakdown = ROI features + wait estimate + multi-frame.
      const cameraV2 = cameraV2base ? {
        ...(roiFeatures || {}),
        ...cameraV2base,
        ...(multiFrame ? {
          multiFrameUsed: multiFrame.multiFrameUsed,
          stoppedVehicleRatio: multiFrame.stoppedVehicleRatio,
          movingVehicleRatio: multiFrame.movingVehicleRatio,
          queueMovingSlowly: multiFrame.queueMovingSlowly,
          flowDirectionValid: multiFrame.flowDirectionValid,
          multiFrameFallbackReason: multiFrame.multiFrameFallbackReason,
        } : {}),
      } : null;
      const measuredReport = reports.filter((r) => r.measured && r.gpsVerified).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      const chatReports = reports.filter((r) => !r.measured);
      const chatAvg = chatReports.length ? Math.round(chatReports.reduce((s, r) => s + Number(r.wait || 0), 0) / chatReports.length) : null;
      const bestPublic = publicSignals.length ? choosePublicSourceSignal(publicSignals) : null;
      // Anonymous live-location passes → verifiedLocation. Outlier-safe (trimmed median), age-aware.
      const verifiedAggregate = aggregateVerifiedLocation(
        recentLocationWaitSessions(crossing.id, direction, LOCATION_WAIT_SIGNAL_MAX_AGE_MINUTES),
        { now: Date.now(), maxAgeMin: LOCATION_WAIT_SIGNAL_MAX_AGE_MINUTES }
      );
      // Prefer a FRESH live-location aggregate; else fall back to a measured driver report.
      const verifiedForFusion = (verifiedAggregate.available && verifiedAggregate.freshSampleCount >= 1)
        ? { waitMin: verifiedAggregate.medianWaitMin, ageMin: Math.round(verifiedAggregate.latestAgeSeconds / 60), sampleCount: verifiedAggregate.sampleCount, confidence: verifiedAggregate.confidence }
        : (measuredReport ? { waitMin: measuredReport.wait, ageMin: ageMinutesOf(measuredReport.createdAt) } : null);
      predictionV2 = fuseTrafficVision({
        google: gV2,
        camera: cameraV2,
        publicSig: bestPublic ? { waitMin: bestPublic.normalizedWaitMin, soft: isSoftUpperBoundSource(bestPublic), confidence: bestPublic.confidence } : null,
        chat: chatReports.length ? { waitMin: chatAvg, count: chatReports.length, ageMin: ageMinutesOf(chatReports[0].createdAt), withLocation: chatReports.some((r) => r.gpsVerified) } : null,
        verified: verifiedForFusion,
        baselineWaitMin: clampWait(staticWait) ?? 10,
      });
      // Always surface the rich verifiedLocation aggregate in the breakdown (available:false when none).
      if (predictionV2 && predictionV2.sourceBreakdown) {
        predictionV2.sourceBreakdown.verifiedLocation = verifiedAggregate.available
          ? verifiedAggregate
          : (measuredReport ? { available: true, sampleCount: 1, freshSampleCount: ageMinutesOf(measuredReport.createdAt) <= LOCATION_WAIT_SIGNAL_MAX_AGE_MINUTES ? 1 : 0, medianWaitMin: measuredReport.wait, minWaitMin: measuredReport.wait, maxWaitMin: measuredReport.wait, latestAgeSeconds: Math.round(ageMinutesOf(measuredReport.createdAt) * 60), confidence: 80, source: 'measured-report' } : { available: false, sampleCount: 0 });
      }
    } catch (error) {
      predictionV2 = { error: String(error.message).slice(0, 120), modelVersion: TRAFFIC_VISION_MODEL_VERSION };
    }
    // PredictionV2 may lead the number — UNLESS a camera-congestion floor was committed. A low
    // prediction must NOT overwrite the camera floor (Scenario M): that produced the "appliedFloor:
    // visual-band:srednja" + "finalEstimateMin: 3" contradiction. The v2 object is still returned for
    // shadow analysis; it just can't pull the committed camera number down.
    if (PREDICTION_V2_ENABLED && predictionV2 && !predictionV2.error && predictionV2.lead && predictionV2.lead !== 'baseline' && !cameraCongestionOverride) {
      finalWait = predictionV2.expectedWaitMin;
      outRangeMin = predictionV2.rangeMin;
      outRangeMax = predictionV2.rangeMax;
      outScore = predictionV2.confidenceScore;
      outLevel = predictionV2.confidenceLabel === 'high' ? 'visoka' : predictionV2.confidenceLabel === 'medium' ? 'srednja' : 'niska';
      outHint = predictionV2.confidenceLabel;
      outPrecision = predictionV2.rangeMax - predictionV2.rangeMin > 4 ? 'range' : 'exact';
      note = predictionV2.explanation;
      conflictKind = predictionV2.lead.includes('conflict') ? 'prediction-conflict' : conflictKind;
    } else if (cameraCongestionOverride && PREDICTION_V2_ENABLED && predictionV2 && !predictionV2.error && predictionV2.lead && predictionV2.lead !== 'baseline') {
      predictionV2 = { ...predictionV2, demotedBy: 'camera-congestion-floor' };
    }

    // FINAL CONSISTENCY CLAMP — the number can never contradict the camera-congestion floor the
    // label/decision already promised, no matter what ran in between. Range is widened to bracket it.
    if (cameraCongestionFloor != null && Number(finalWait) < cameraCongestionFloor) {
      finalWait = cameraCongestionFloor;
      outRangeMin = Math.max(0, Math.min(Number(outRangeMin ?? finalWait), finalWait));
      outRangeMax = Math.max(Number(outRangeMax ?? finalWait), finalWait);
      conflictKind = 'camera-congestion';
    }

    return {
      wait: finalWait,
      predictionV2,
      modelVersion: TRAFFIC_VISION_MODEL_VERSION,
      rangeMin: outRangeMin,
      rangeMax: outRangeMax,
      confidenceHint: outHint,
      confidenceLevel: outLevel,
      confidenceScore: outScore,
      heuristicConfidenceLevel: profile.level,
      precision: outPrecision,
      confidenceFactors: profile.factors,
      confidenceDowngradeReasons: calibrated.reasons,
      calibration: { basis: calibrated.basis, sampleSize: calibrated.sampleSize, hasData: calibrated.hasData, version: CALIBRATION_VERSION, bucketMae: calibrated.bucketMetrics?.mae ?? null, bucketP90: calibrated.bucketMetrics?.p90Error ?? null, bucketWithin15: calibrated.bucketMetrics?.within15 ?? null },
      independentSources: profile.independentSources,
      biasApplied: biasResult.applied,
      biasAdjustMin: biasResult.adjustMin,
      explanation,
      explanationPayload,
      // Camera-vs-wait conflict (either a big queue with a low wait, or no queue with a high wait).
      visualBand: visualBand || null,
      visualCongestionConflict: congestion.conflict,
      visualConflict,
      conflictKind,
      googleTraffic,
      googleTrafficSeverity,
      googleTrafficConflict: googleJamConflict,
      label: cameraCongestionOverride ? 'Gužva — prema kameri'
        : congestion.conflict ? 'Veća gužva (kamera)'
        : googleJamConflict ? 'Moguća gužva na prilazu'
        : clearConflict ? 'Kamera ne pokazuje kolonu'
        : cameraClearOverride ? 'Kamera — nema kolone'
        : combined ? 'Okvirna procjena'
        : (bestCandidate.label === 'Google' ? 'Google procjena' : bestCandidate.label === 'Kamera' ? 'Kamera procjena' : `${bestCandidate.label} procjena`),
      className: (cameraClearOverride || cameraCongestionOverride) ? 'camera' : combined ? 'combined' : (bestCandidate.label === 'Google' ? 'google' : bestCandidate.label === 'Kamera' ? 'camera' : 'official'),
      sourceType: cameraCongestionOverride ? 'camera-congestion-override' : cameraClearOverride ? 'camera-clear-override' : combined ? 'combined-estimate' : bestCandidate.sourceType,
      cameraClearOverride,
      cameraCongestionOverride,
      confidence: outScore,
      hasGoogleSignal: Boolean(googleSignal),
      hasCameraSignal: Boolean(cameraSignal),
      hasStrongCameraQueue: cameraShowsQueue(cameraSignal),
      hasHardPublicSignal,
      hasMeasuredSession,
      hasSoftUpperBoundPublic: publicSignals.length > 0 && publicSignals.every(isSoftUpperBoundSource),
      // True when Google looks clear but an official/camera/report signal still shows a booth
      // queue. The frontend uses this to explain why the wait is higher than the blue road.
      googleClearWhileQueue: Boolean(sanity.googleVsOfficial),
      sourceAgreement: agreement.agreement,
      sourceSpreadMinutes: Number.isFinite(agreementSpread) ? agreementSpread : agreement.spread,
      note,
      signals: latestSources,
      updatedAt: candidates.map((item) => item.updatedAt).filter(Boolean).sort().at(-1) || new Date().toISOString(),
    };
  }

  if (reportAvg !== null) {
    const reportProfile = computeConfidenceProfile({ signals: reports.map((r) => ({ kind: r.measured ? 'measured' : 'report', wait: r.wait, ageMinutes: ageMinutesOf(r.createdAt), confidence: r.measured ? 88 : 60, trust: reportTrust.get(r.id) })) });
    const reportRange = computeSmartRange(clampWait(reportAvg * (vehicleKey(vehicle) === 'car' ? 1 : multiplier)), reportProfile, {});
    return {
      wait: clampWait(reportAvg * (vehicleKey(vehicle) === 'car' ? 1 : multiplier)),
      label: measuredCount > 0 ? 'Izmjereno čekanje' : 'Dojave vozača',
      className: 'reports',
      sourceType: measuredCount > 0 ? 'measured-wait' : 'driver-reports',
      confidence: reportProfile.score,
      confidenceLevel: reportProfile.level,
      confidenceScore: reportProfile.score,
      precision: reportProfile.precision,
      rangeMin: reportRange.rangeMin,
      rangeMax: reportRange.rangeMax,
      confidenceHint: reportProfile.level === CONFIDENCE_LEVELS.HIGH ? 'high' : reportProfile.level === CONFIDENCE_LEVELS.MEDIUM ? 'medium' : 'low',
      explanation: buildSourceExplanation({ reportCount: reports.filter((r) => !r.measured).length, measuredCount }),
      hasMeasuredSession: measuredCount > 0,
      note: measuredCount > 0 ? `Temeljeno na ${measuredCount} izmjerenom prolasku i dojavama vozača.` : `Prosjek ${reports.length} svježih dojava vozača.`,
      signals: [],
      updatedAt: reports[0]?.createdAt || new Date().toISOString(),
    };
  }

  // Production safety: when there is no live signal (no public source, no camera, no Google
  // route, no driver report, no admin override) we must NOT show a static/planner value as a
  // live wait. Static values still help internally for ranking/ordering (effectiveBorderDelay
  // and trip ordering) but they are NEVER displayed as a user-facing estimate.
  return {
    wait: staticWait,
    label: 'Nedovoljno podataka',
    className: 'pending',
    sourceType: 'no-live-source',
    confidence: 0,
    confidenceLevel: CONFIDENCE_LEVELS.NONE,
    confidenceScore: 0,
    precision: 'unknown',
    explanation: 'Trenutno nema dovoljno podataka za pouzdanu procjenu ovog smjera.',
    displayReady: false,
    note: 'Još nema svježeg javnog izvora, kamere, dojave ili potvrde tima za ovaj prijelaz. Čekanje će se prikazati čim stigne pouzdan signal.',
    signals: latestSources,
    updatedAt: new Date().toISOString(),
  };
}

async function effectiveBorderDelay(crossing, direction = 'toBih', vehicle = 'car', store = null) {
  const signal = await effectiveBorderSignal(crossing, direction, vehicle, store);
  return signal.wait;
}

// Server-side EMA smoothing cache. Each entry holds the last displayed wait per
// (crossing,direction). On the next /api/public/state poll the new raw wait is blended
// with the previous one to suppress flicker (12 → 45 → 12 spikes from a noisy snapshot).
// Big jumps (Δ > 25 min) bypass smoothing because they likely reflect a real change.
const emaWaitCache = new Map();
const EMA_TTL_MS = 30 * 60 * 1000;
const EMA_ALPHA = 0.65; // weight on new value

function emaSmoothWait(key, rawWait) {
  if (!Number.isFinite(rawWait)) return rawWait;
  const now = Date.now();
  const prev = emaWaitCache.get(key);
  if (!prev || now - prev.updatedAt > EMA_TTL_MS) {
    emaWaitCache.set(key, { wait: rawWait, updatedAt: now });
    return rawWait;
  }
  const delta = Math.abs(prev.wait - rawWait);
  if (delta > 25) {
    emaWaitCache.set(key, { wait: rawWait, updatedAt: now });
    return rawWait;
  }
  // Asymmetric smoothing: a FALLING wait converges fast (a clearing queue must be reflected
  // quickly so we never keep showing a stale-high camera estimate), while a RISING wait is
  // smoothed more to suppress single-frame spikes (spec P0 / refresh UX).
  const alpha = rawWait < prev.wait ? 0.88 : EMA_ALPHA;
  const smoothed = Math.round(alpha * rawWait + (1 - alpha) * prev.wait);
  emaWaitCache.set(key, { wait: smoothed, updatedAt: now });
  return smoothed;
}

// Drop cache entries older than the TTL window. Called periodically to avoid memory drift.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of emaWaitCache) {
    if (now - entry.updatedAt > EMA_TTL_MS) emaWaitCache.delete(key);
  }
}, 15 * 60 * 1000).unref?.();

async function buildEffectiveWaitMaps(store) {
  const effectiveWaits = {};
  const waitSources = {};
  for (const crossing of Object.values(BORDER_CROSSINGS)) {
    for (const direction of ['toBih', 'toHr']) {
      const signal = await effectiveBorderSignal(crossing, direction, 'car', store);
      const key = `${crossing.id}:${direction}`;
      const isLive = signal.displayReady !== false && Number.isFinite(Number(signal.wait));
      if (isLive) {
        // Admin override, driver-report and committed CAMERA-CONGESTION values bypass smoothing — they
        // are authoritative/committed and must appear instantly. Crucially, smoothing the camera floor
        // would let the blue card show a number BELOW the floor the debug/label promised (Scenario P).
        const bypassSmoothing = signal.sourceType === 'admin-override' || signal.sourceType === 'driver-reports' || signal.sourceType === 'camera-congestion-override';
        effectiveWaits[key] = bypassSmoothing ? Number(signal.wait) : emaSmoothWait(key, Number(signal.wait));
      } else {
        // Clear the cache when source goes dark so we don't blend stale values back in.
        emaWaitCache.delete(key);
      }
      waitSources[key] = {
        label: signal.label,
        className: signal.className,
        note: signal.note,
        predictionV2: signal.predictionV2 || null,
        modelVersion: signal.modelVersion || null,
        explanation: signal.explanation,
        explanationPayload: signal.explanationPayload,
        confidence: signal.confidence,
        confidenceHint: signal.confidenceHint,
        confidenceLevel: signal.confidenceLevel,
        confidenceScore: signal.confidenceScore,
        precision: signal.precision,
        confidenceFactors: signal.confidenceFactors,
        confidenceDowngradeReasons: signal.confidenceDowngradeReasons,
        calibration: signal.calibration,
        visualBand: signal.visualBand,
        visualCongestionConflict: signal.visualCongestionConflict,
        visualConflict: signal.visualConflict,
        conflictKind: signal.conflictKind,
        googleTraffic: signal.googleTraffic,
        googleTrafficSeverity: signal.googleTrafficSeverity,
        googleTrafficConflict: signal.googleTrafficConflict,
        independentSources: signal.independentSources,
        rangeMin: signal.rangeMin,
        rangeMax: signal.rangeMax,
        sourceType: signal.sourceType,
        hasGoogleSignal: signal.hasGoogleSignal,
        hasCameraSignal: signal.hasCameraSignal,
        hasStrongCameraQueue: signal.hasStrongCameraQueue,
        hasHardPublicSignal: signal.hasHardPublicSignal,
        hasMeasuredSession: signal.hasMeasuredSession,
        hasSoftUpperBoundPublic: signal.hasSoftUpperBoundPublic,
        googleClearWhileQueue: signal.googleClearWhileQueue,
        sourceAgreement: signal.sourceAgreement,
        sourceSpreadMinutes: signal.sourceSpreadMinutes,
        displayReady: signal.displayReady !== false,
        updatedAt: signal.updatedAt,
        // Freshness (spec §7 I): how old the underlying signal is, and whether it is stale.
        ageSeconds: signal.updatedAt ? Math.max(0, Math.round((Date.now() - new Date(signal.updatedAt).getTime()) / 1000)) : null,
        stale: signal.updatedAt ? (Date.now() - new Date(signal.updatedAt).getTime()) > 15 * 60 * 1000 : false,
      };

      // Accuracy KPI: sample this prediction so a later measured wait can score it.
      if (isLive) recordPredictionSample(crossing.id, direction, signal);
      // Alerts: detect threshold crossings vs the previously displayed wait. Skip while ANY
      // conflict is active (camera-vs-wait or Google-jam) — we are not confident enough to push
      // a "veliko čekanje" alert on a contradicted/uncertain wait (avoids false alerts).
      if (isLive && !signal.conflictKind) {
        const prevWait = lastWaitForAlerts.get(key);
        evaluateAndStoreAlerts(crossing, direction, prevWait, effectiveWaits[key]);
        lastWaitForAlerts.set(key, effectiveWaits[key]);
      }
    }
  }
  return { effectiveWaits, waitSources };
}

// Evaluate alert rules for a (crossing,direction) transition against active
// subscriptions, and store push-ready events. Actual delivery (FCM/APNs/web-push)
// is a transport concern wired via env keys; here we decide WHAT to send.
function evaluateAndStoreAlerts(crossing, direction, prevWait, nextWait) {
  const subs = alertSubscriptionBuffer.filter((s) => s.active && s.crossingId === crossing.id && s.direction === direction);
  if (!subs.length) return;
  for (const sub of subs) {
    const events = evaluateWaitAlerts(prevWait, nextWait, {
      crossingId: crossing.id,
      crossingName: crossing.shortName || crossing.name || crossing.id,
      direction,
      dropBelow: sub.dropBelow ?? 30,
      riseAbove: sub.riseAbove ?? 60,
      suddenDelta: 25,
    });
    for (const ev of events) {
      alertEventBuffer.unshift({ id: crypto.randomUUID(), subscriptionId: sub.id, userId: sub.userId || null, pushToken: sub.pushToken || null, createdAt: new Date().toISOString(), delivered: false, ...ev });
    }
  }
  while (alertEventBuffer.length > 2000) alertEventBuffer.pop();
}

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const store = await readAppStore();
  const user = store.users.find((item) => item.email === email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ ok: false, error: 'Neispravni podaci za prijavu.' });
  }
  await audit('auth_login', user, { email });
  return res.json({ ok: true, user: publicUser(user), token: signToken(user) });
});

// Public self-registration is OFF by default. Enable only when ALLOW_PUBLIC_REGISTRATION=true
// is set. In production the pilot team creates accounts through the admin/seed path; an open
// /api/auth/register would let anyone create a foothold and skew driver-report data.
const allowPublicRegistration = String(process.env.ALLOW_PUBLIC_REGISTRATION || 'false').toLowerCase() === 'true';

app.post('/api/auth/register', authLimiter, async (req, res) => {
  if (!allowPublicRegistration) {
    return res.status(403).json({ ok: false, error: 'Registracija novih korisnika je trenutno isključena. Obrati se administratoru za pristup.' });
  }
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!name || !email.includes('@') || password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Unesi ime, ispravan email i lozinku od barem 8 znakova.' });
  }
  const store = await readAppStore();
  if (store.users.some((item) => item.email === email)) {
    return res.status(409).json({ ok: false, error: 'Račun s tim emailom već postoji.' });
  }
  // New self-registered accounts are always non-admin; admin role is reserved for seed/SQL.
  const user = { id: crypto.randomUUID(), name, email, role: 'user', passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
  store.users.push(user);
  store.audit.unshift({ id: crypto.randomUUID(), type: 'auth_register', actor: publicUser(user), createdAt: new Date().toISOString() });
  await writeAppStore(store);
  return res.status(201).json({ ok: true, user: publicUser(user), token: signToken(user) });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ ok: true, user: req.user });
});

app.get('/api/public/state', async (req, res) => {
  // refresh=sync → AWAIT the refresh before building effectiveWaits, so the response carries the
  // NEW estimate (used by the admin "Osvježi" button and right after a route/camera signal lands).
  // refresh=force additionally forces a refetch even if the interval has not elapsed. Default keeps
  // the cheap background refresh so the regular poll never blocks.
  const refreshMode = String(req.query.refresh || '');
  const wantSync = refreshMode === 'sync' || refreshMode === 'force';
  let refreshedInThisRequest = false;
  if (wantSync) {
    try {
      const result = await refreshProductionSources({ force: refreshMode === 'force' });
      // "did a refresh actually execute" (not whether every external source succeeded — a partial
      // failure still produced fresh data for the sources that did respond).
      refreshedInThisRequest = Boolean(result && !result.skipped);
    } catch (error) {
      console.warn('[source-refresh/public-state-sync]', error.message);
    }
  } else {
    refreshProductionSources({ force: false }).catch((error) => {
      console.warn('[source-refresh/public-state]', error.message);
    });
  }
  res.set('Cache-Control', 'no-store');
  const store = await readAppStore();
  const { effectiveWaits, waitSources } = await buildEffectiveWaitMaps(store);
  const lastFinishedAt = sourceRefreshState.lastRunAt ? new Date(sourceRefreshState.lastRunAt).toISOString() : null;
  res.json({
    ok: true,
    updatedAt: new Date().toISOString(),
    warnings: envWarnings(),
    overrides: store.overrides,
    statusOverrides: store.statusOverrides || {},
    effectiveWaits,
    waitSources,
    sourceRefresh: {
      enabled: SOURCE_FETCH_ENABLED,
      running: Boolean(sourceRefreshState.running),
      refreshedInThisRequest,
      ageSeconds: sourceRefreshState.lastRunAt ? Math.max(0, Math.round((Date.now() - sourceRefreshState.lastRunAt) / 1000)) : null,
      lastFinishedAt,
      intervalSeconds: Math.round(SOURCE_REFRESH_INTERVAL_MS / 1000),
      lastRunAt: lastFinishedAt,
      lastError: sourceRefreshState.lastError || '',
    },
    reportsCount: store.reports.length,
    lastReports: store.reports.slice(0, 12),
    features: {
      // Subtle live-location signal. The "Moja lokacija" button shows regardless, but the anonymous
      // A→B pass signal only arms when this is on (so the UI can subdue the live wording otherwise).
      verifiedLocation: VERIFIED_LOCATION_ENABLED,
    },
    crossings: Object.values(BORDER_CROSSINGS).map((crossing) => ({
      id: crossing.id,
      name: crossing.name,
      shortName: crossing.shortName,
      locationWaitArmed: verifiedLocationEnabledFor(crossing.id) && (hasLocationWaitAnchors(crossing, 'toBih') || hasLocationWaitAnchors(crossing, 'toHr')),
      cameras: (CAMERA_FEEDS[crossing.id] || []).map((camera) => ({ id: camera.id, source: camera.source || 'HAK', label: camera.label })),
    })),
  });
});

app.get('/api/sources/latest', async (req, res) => {
  const crossingId = String(req.query.crossingId || '').trim();
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';
  if (crossingId && !BORDER_CROSSINGS[crossingId]) return res.status(400).json({ ok: false, error: 'Nepoznat prijelaz.' });
  try {
    // Public endpoint never force-refreshes external sources; admin can use /api/admin/sources/refresh.
    await refreshProductionSources({ force: false });
    const rows = crossingId
      ? await readLatestSourceSnapshots(crossingId, direction, 12)
      : (await readAppStore()).sourceSnapshots || [];
    res.json({ ok: true, snapshots: rows.slice(0, 80), sourceRefresh: { enabled: SOURCE_FETCH_ENABLED, lastRunAt: sourceRefreshState.lastRunAt ? new Date(sourceRefreshState.lastRunAt).toISOString() : null, lastError: sourceRefreshState.lastError || '' } });
  } catch (error) {
    console.error('[sources-latest]', error);
    res.status(500).json({ ok: false, error: 'Javni izvori trenutno nisu dostupni.', detail: safeError(error) });
  }
});

// Debug endpoint: full pipeline breakdown for a crossing+direction.
// Admin-only — never expose to public users.
app.get('/api/debug/wait', authRequired, adminRequired, async (req, res) => {
  const crossingId = String(req.query.crossingId || '').trim();
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';
  if (!crossingId || !BORDER_CROSSINGS[crossingId]) {
    return res.status(400).json({ ok: false, error: 'Nevažeći crossingId. Dostupni: ' + Object.keys(BORDER_CROSSINGS).join(', ') });
  }
  try {
    await refreshProductionSources({ force: false });
    const crossing = BORDER_CROSSINGS[crossingId];
    const store = await readAppStore();
    const multiplier = vehicleMultiplier(crossing, direction, 'car');
    const staticWait = borderDelay(crossing, direction, 'car');

    const latestSources = await readLatestSourceSnapshots(crossing.id, direction, 8);
    const publicSignals = latestSources.filter((item) => !['camera-snapshot-model', 'google-traffic-estimate'].includes(item.sourceType) && item.normalizedWaitMin !== null && item.normalizedWaitMin !== undefined);
    const cameraSignal = choosePublicSourceSignal(latestSources.filter((item) => item.sourceType === 'camera-snapshot-model'));
    const googleSignal = choosePublicSourceSignal(latestSources.filter((item) => item.sourceType === 'google-traffic-estimate'));
    const reports = reportSignals(store, crossing.id, direction, 2);
    const reportAvg = reports.length ? Math.round(reports.reduce((sum, r) => sum + Number(r.wait || 0), 0) / reports.length) : null;

    const candidates = [];
    publicSignals.forEach((item) => {
      const softUpperBound = isSoftUpperBoundSource(item);
      const effectiveWeight = Math.max(0.1, Number(item.weight || 1)) * Math.max(35, Number(item.confidence || 70)) * (softUpperBound ? 0.82 : 1.15);
      candidates.push({
        label: sourceDisplayName(item.sourceName),
        sourceType: item.sourceType,
        rawWait: item.normalizedWaitMin,
        wait: waitForVehicle(item.normalizedWaitMin, multiplier, 'car'),
        rawWeight: item.weight,
        confidence: item.confidence,
        isSoftUpperBound: softUpperBound,
        effectiveWeight,
        rawStatus: item.rawStatus,
        fetchedAt: item.fetchedAt,
      });
    });
    if (cameraSignal) {
      const effectiveWeight = Math.max(0.1, Number(cameraSignal.weight || 0.72)) * Math.max(35, Number(cameraSignal.confidence || 58)) * (publicSignals.length ? 0.9 : 1.08) * (googleLooksClear(googleSignal) && cameraLooksClear(cameraSignal) ? 1.18 : 1);
      candidates.push({
        label: 'Kamera',
        sourceType: cameraSignal.sourceType,
        rawWait: cameraSignal.normalizedWaitMin,
        wait: waitForVehicle(cameraSignal.normalizedWaitMin ?? staticWait, multiplier, 'car'),
        rawWeight: cameraSignal.weight,
        confidence: cameraSignal.confidence,
        isSoftUpperBound: false,
        effectiveWeight,
        cameraLooksClear: cameraLooksClear(cameraSignal),
        cameraShowsQueue: cameraShowsQueue(cameraSignal),
        queueVehicles: cameraSignal.metadata?.queueVehicles,
        flowVehicles15: cameraSignal.metadata?.flowVehicles15 ?? cameraSignal.metadata?.passed15,
        fetchedAt: cameraSignal.fetchedAt,
      });
    }
    if (googleSignal) {
      const effectiveWeight = Math.max(0.1, Number(googleSignal.weight || 0.84)) * Math.max(35, Number(googleSignal.confidence || 62)) * (publicSignals.length ? 0.86 : 1.02);
      candidates.push({
        label: 'Google',
        sourceType: googleSignal.sourceType,
        rawWait: googleSignal.normalizedWaitMin,
        wait: waitForVehicle(googleSignal.normalizedWaitMin ?? staticWait, multiplier, 'car'),
        rawWeight: googleSignal.weight,
        confidence: googleSignal.confidence,
        isSoftUpperBound: false,
        effectiveWeight,
        googleLooksClear: googleLooksClear(googleSignal),
        googleLooksSlow: googleLooksSlow(googleSignal),
        googleLooksHeavy: googleLooksHeavy(googleSignal),
        delayMinutes: googleSignal.metadata?.delayMinutes,
        ratio: googleSignal.metadata?.ratio,
        level: googleSignal.metadata?.level,
        durationMinutes: googleSignal.metadata?.durationMinutes,
        staticMinutes: googleSignal.metadata?.staticMinutes,
        routeGuard: googleSignal.metadata?.routeGuard,
        fetchedAt: googleSignal.fetchedAt,
      });
    }
    if (reportAvg !== null && reports.length >= 2) {
      candidates.push({
        label: 'Dojave',
        sourceType: 'driver-reports',
        rawWait: reportAvg,
        wait: waitForVehicle(reportAvg, multiplier, 'car'),
        isSoftUpperBound: false,
        effectiveWeight: Math.min(90, 32 + reports.length * 9),
        reportsCount: reports.length,
      });
    }

    const blendedWait = weightedWait(candidates.map((c) => ({ wait: c.wait, weight: c.effectiveWeight })));
    const sanity = blendedWait !== null ? applyTrafficSanityCaps(blendedWait, { googleSignal, cameraSignal, publicSignals, reportAvg }) : null;
    const finalWait = sanity?.wait ?? staticWait;
    const range = estimateRangeFromSignals(finalWait, { googleSignal, cameraSignal, publicSignals, reports });

    const flags = {
      hasDriverReports: reportAvg !== null,
      softPublicOnly: publicSignals.length > 0 && publicSignals.every(isSoftUpperBoundSource),
      hasHardPublic: publicSignals.some((item) => !isSoftUpperBoundSource(item) && Number(item.normalizedWaitMin || 0) >= 20),
      noPublicSignals: publicSignals.length === 0,
      clearGoogle: googleLooksClear(googleSignal),
      heavyGoogle: googleLooksHeavy(googleSignal),
      clearCamera: cameraLooksClear(cameraSignal),
      strongCameraQueue: cameraShowsQueue(cameraSignal),
    };

    res.json({
      ok: true,
      crossingId,
      direction,
      summary: {
        finalWait,
        blendedWait,
        sanityCapped: sanity?.adjusted ?? false,
        sanityReason: sanity?.reason ?? '',
        confidenceHint: range.confidenceHint,
        rangeMin: range.rangeMin,
        rangeMax: range.rangeMax,
        staticFallback: staticWait,
        usedStaticFallback: blendedWait === null,
      },
      candidates,
      flags,
      rawSignals: {
        google: googleSignal ? {
          normalizedWaitMin: googleSignal.normalizedWaitMin,
          level: googleSignal.metadata?.level,
          delayMinutes: googleSignal.metadata?.delayMinutes,
          ratio: googleSignal.metadata?.ratio,
          durationMinutes: googleSignal.metadata?.durationMinutes,
          staticMinutes: googleSignal.metadata?.staticMinutes,
          reason: googleSignal.metadata?.reason,
          routeGuard: googleSignal.metadata?.routeGuard,
          fetchedAt: googleSignal.fetchedAt,
        } : null,
        camera: cameraSignal ? {
          normalizedWaitMin: cameraSignal.normalizedWaitMin,
          confidence: cameraSignal.confidence,
          queueVehicles: cameraSignal.metadata?.queueVehicles,
          flowVehicles15: cameraSignal.metadata?.flowVehicles15 ?? cameraSignal.metadata?.passed15,
          throughputPerHour: cameraSignal.metadata?.throughputPerHour,
          fetchedAt: cameraSignal.fetchedAt,
        } : null,
        public: publicSignals.map((item) => ({
          sourceName: item.sourceName,
          normalizedWaitMin: item.normalizedWaitMin,
          confidence: item.confidence,
          weight: item.weight,
          isSoftUpperBound: isSoftUpperBoundSource(item),
          softMaxMinutes: item.metadata?.softMaxMinutes,
          parser: item.metadata?.parser,
          rawStatus: item.rawStatus,
          fetchedAt: item.fetchedAt,
        })),
        reports: reports.slice(0, 5).map((r) => ({ wait: r.wait, createdAt: r.createdAt })),
      },
    });
  } catch (error) {
    console.error('[debug-wait]', error);
    res.status(500).json({ ok: false, error: 'Debug endpoint greška.', detail: safeError(error) });
  }
});

// Validates the wait calculation pipeline against 5 known edge-case scenarios.
// Admin-only — never expose to public users.
app.get('/api/debug/wait-scenarios', authRequired, adminRequired, async (req, res) => {
  function mockGoogleSignal({ delay = 1, ratio = 1.03, level = 'normal' } = {}) {
    const estimate = estimateWaitFromGoogleRoute({ delayMinutes: delay, ratio, level });
    return { normalizedWaitMin: estimate.wait, weight: estimate.weight, confidence: estimate.confidence, metadata: { delayMinutes: delay, ratio, level, reason: estimate.reason } };
  }
  function mockPublicSoft(maxMin = 30) {
    const wait = Math.max(6, Math.round(maxMin * 0.35));
    return { normalizedWaitMin: wait, weight: 0.35, confidence: 58, metadata: { softUpperBound: true, softMaxMinutes: maxMin, parser: 'under-not-longer-than' }, sourceType: 'public-text-status', rawStatus: `Zadržavanja nisu duža od ${maxMin} min`, rawText: `zadrzavanja nisu duga od ${maxMin} minuta` };
  }
  function mockCamera({ wait = 10, queue = 4, flow15 = 14 } = {}) {
    return { normalizedWaitMin: wait, weight: 0.72, confidence: 65, metadata: { queueVehicles: queue, flowVehicles15: flow15 }, sourceType: 'camera-snapshot-model' };
  }
  function runScenario({ publicSig, google, camera, reports = null }) {
    const publicSignals = publicSig ? [publicSig] : [];
    const googleSignal = google || null;
    const cameraSignal = camera || null;
    const reportAvg = reports;
    const candidates = [];
    publicSignals.forEach((item) => {
      const softUpperBound = isSoftUpperBoundSource(item);
      candidates.push({ wait: item.normalizedWaitMin, weight: Math.max(0.1, Number(item.weight || 1)) * Math.max(35, Number(item.confidence || 70)) * (softUpperBound ? 0.82 : 1.15) });
    });
    if (cameraSignal) candidates.push({ wait: cameraSignal.normalizedWaitMin, weight: Math.max(0.1, Number(cameraSignal.weight || 0.72)) * Math.max(35, Number(cameraSignal.confidence || 58)) * (publicSignals.length ? 0.9 : 1.08) });
    if (googleSignal) candidates.push({ wait: googleSignal.normalizedWaitMin, weight: Math.max(0.1, Number(googleSignal.weight || 0.84)) * Math.max(35, Number(googleSignal.confidence || 62)) * (publicSignals.length ? 0.86 : 1.02) });
    const blended = weightedWait(candidates);
    const sanity = blended !== null ? applyTrafficSanityCaps(blended, { googleSignal, cameraSignal, publicSignals, reportAvg }) : { wait: blended, adjusted: false, reason: 'no candidates' };
    return { blended, final: sanity.wait, adjusted: sanity.adjusted, reason: sanity.reason };
  }

  const scenarios = [
    {
      id: 'A',
      description: 'Soft public "do 30" + Google clear + no camera → expect 5–12',
      expectedMin: 5, expectedMax: 12,
      result: runScenario({ publicSig: mockPublicSoft(30), google: mockGoogleSignal({ delay: 1, ratio: 1.03 }), camera: null }),
    },
    {
      id: 'B',
      description: 'Soft public "do 30" + Google clear + camera medium queue → expect 8–18',
      expectedMin: 8, expectedMax: 18,
      result: runScenario({ publicSig: mockPublicSoft(30), google: mockGoogleSignal({ delay: 1, ratio: 1.03 }), camera: mockCamera({ wait: 15, queue: 12, flow15: 9 }) }),
    },
    {
      id: 'C',
      description: 'Soft public "do 30" + Google slow (delay 5, ratio 1.2) + camera medium → expect 15–30',
      expectedMin: 15, expectedMax: 30,
      result: runScenario({ publicSig: mockPublicSoft(30), google: mockGoogleSignal({ delay: 5, ratio: 1.2, level: 'slow' }), camera: mockCamera({ wait: 14, queue: 10, flow15: 8 }) }),
    },
    {
      id: 'D',
      description: 'Google heavy (delay 10, ratio 1.4) + camera heavy queue → expect 30+',
      expectedMin: 30, expectedMax: 360,
      result: runScenario({ publicSig: null, google: mockGoogleSignal({ delay: 10, ratio: 1.4, level: 'heavy' }), camera: mockCamera({ wait: 35, queue: 22, flow15: 5 }) }),
    },
    {
      id: 'E',
      description: 'No Google, only soft public "do 30" → expect low/medium confidence around 10–15',
      expectedMin: 6, expectedMax: 15,
      result: runScenario({ publicSig: mockPublicSoft(30), google: null, camera: null }),
    },
  ];

  const results = scenarios.map((sc) => ({
    ...sc,
    pass: sc.result.final >= sc.expectedMin && sc.result.final <= sc.expectedMax,
  }));
  const allPassed = results.every((r) => r.pass);
  res.json({ ok: allPassed, allPassed, scenarios: results });
});

app.post('/api/admin/sources/refresh', authRequired, adminRequired, writeLimiter, async (req, res) => {
  try {
    const result = await refreshProductionSources({ force: true });
    await audit('sources_refreshed', req.user, { snapshots: result.snapshots?.length || 0, failures: result.failures || [] });
    res.json(result);
  } catch (error) {
    console.error('[admin-sources-refresh]', error);
    res.status(500).json({ ok: false, error: 'Osvježavanje javnih izvora nije uspjelo.', detail: safeError(error) });
  }
});

// Inspect / clean legacy-suspicious public-text snapshots. Default DRY-RUN (shows what would go);
// pass ?dryRun=false to actually delete. Scoped to public-text-status legacy rows only.
app.post('/api/admin/sources/prune-suspicious', authRequired, adminRequired, writeLimiter, async (req, res) => {
  try {
    const dryRun = String(req.query.dryRun ?? req.body?.dryRun ?? 'true') !== 'false';
    const result = await pruneSuspiciousPublicSourceSnapshots({ dryRun });
    if (!dryRun) await audit('sources_prune_suspicious', req.user, { found: result.found, removed: result.removed, threshold: result.threshold });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[admin-prune-suspicious]', error);
    res.status(500).json({ ok: false, error: 'Čišćenje sumnjivih snapshotova nije uspjelo.', detail: safeError(error) });
  }
});

// Traffic + Vision v2 debug for one crossing/direction: the full source breakdown (Google
// border-segment delay, YOLO queue model, public, chat, verified) + the fused prediction.
app.get('/api/admin/traffic-vision/:crossingId/:direction', authRequired, adminRequired, async (req, res) => {
  const crossing = BORDER_CROSSINGS[String(req.params.crossingId || '').trim()];
  if (!crossing) return res.status(404).json({ ok: false, error: 'Prijelaz nije pronađen.' });
  const direction = req.params.direction === 'toHr' ? 'toHr' : 'toBih';
  try {
    const store = await readAppStore();
    const sig = await effectiveBorderSignal(crossing, direction, 'car', store);
    // Explicit per-source breakdown built from the live store (independent of the v2 shadow object),
    // so this always shows whether a driver report or a completed A→B measurement is influencing it.
    const reps = reportSignals(store, crossing.id, direction, 2);
    const repWaits = reps.map((r) => Number(r.wait)).filter(Number.isFinite).sort((a, b) => a - b);
    const verified = (typeof recentLocationWaitSessions === 'function') ? recentLocationWaitSessions(crossing.id, direction) : [];
    const verWaits = verified.map((s) => Number(s.measuredWaitMin)).filter(Number.isFinite).sort((a, b) => a - b);
    const medianOf = (arr) => (arr.length ? arr[Math.floor((arr.length - 1) / 2)] : null);
    const ageSecOf = (ts) => (ts ? Math.round((Date.now() - new Date(ts).getTime()) / 1000) : null);
    // Canonical camera signal as the FUSION sees it (stored source snapshots — not the on-demand
    // Camera-tab call). This is what makes the disconnect explainable: did a camera-visual/-model
    // snapshot actually reach effectiveBorderSignal, how old is it, and was it used or ignored.
    const cameraStored = await readLatestSourceSnapshots(crossing.id, direction, 8);
    const camVisual = cameraStored.filter((s) => s.sourceType === 'camera-visual').sort((a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt))[0] || null;
    const camModel = cameraStored.filter((s) => s.sourceType === 'camera-snapshot-model').sort((a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt))[0] || null;
    const expectedCameraId = (CAMERA_FEEDS[crossing.id] || []).find((c) => Array.isArray(c.validForDirections) && c.validForDirections.includes(direction))?.id || null;
    let cameraReason;
    if (sig.visualBand) {
      cameraReason = sig.conflictKind === 'camera-congestion'
        ? `Kamera vizualno pokazuje '${sig.visualBand}' → primijenjen floor (vidi decision.appliedFloor).`
        : `Kamera vizualno pokazuje '${sig.visualBand}' (ne diže estimate iznad trenutnog broja).`;
    } else if (camVisual) {
      cameraReason = 'Camera-visual snapshot postoji ali je izvan svježine (stale) → fusion ga ignorira.';
    } else {
      cameraReason = 'Nema svježeg camera-visual signala u fusionu (refresh nije proizveo band — kamera nedostupna ili nema kolone). Pokreni POST /api/admin/sources/refresh.';
    }
    const sourceBreakdown = {
      publicSource: sig.explanationPayload?.publicSource || null,
      googleTraffic: sig.explanationPayload?.googleTraffic || null,
      camera: {
        visualBand: sig.visualBand || null,
        hasStrongCameraQueue: Boolean(sig.hasStrongCameraQueue),
        roiTrusted: Boolean(sig.predictionV2?.sourceBreakdown?.yoloCamera?.roiTrusted),
        vehiclesInQueueRoi: sig.predictionV2?.sourceBreakdown?.yoloCamera?.vehiclesInQueueRoi ?? null,
        expectedCameraId, // toHr → mal-hak-hr-entry, toBih → mal-hak-hr-exit
        cameraIds: camVisual?.metadata?.cameraIds || (camModel?.metadata?.snapshots || []).map((s) => s.cameraId) || [],
        cameraAnalyticsWait: camVisual?.metadata?.cameraAnalyticsWait ?? (camModel ? camModel.normalizedWaitMin : null),
        cameraWaitDriven: Boolean(camModel && camModel.normalizedWaitMin != null),
        visualSnapshotAgeSeconds: ageSecOf(camVisual?.fetchedAt),
        visualOccupancyPct: camVisual?.metadata?.occupancyPct ?? null,
        reason: cameraReason,
      },
      userReports: { sampleCount: reps.length, medianWaitMin: medianOf(repWaits), latestAgeSeconds: ageSecOf(reps[0]?.createdAt), measuredCount: reps.filter((r) => r.measured).length },
      verifiedLocation: { sampleCount: verified.length, medianWaitMin: medianOf(verWaits), latestAgeSeconds: ageSecOf(verified[0]?.serverCompletedAt), enabled: verifiedLocationEnabledFor(crossing.id) },
    };
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      crossingId: crossing.id,
      direction,
      modelVersion: sig.modelVersion || TRAFFIC_VISION_MODEL_VERSION,
      predictionV2Enabled: PREDICTION_V2_ENABLED,
      headlineWait: sig.wait,
      finalEstimateMin: sig.wait,
      finalLabel: sig.label || null,
      sourceBreakdown,
      predictionV2: sig.predictionV2 || null,
      googleTraffic: sig.explanationPayload?.googleTraffic || null,
      conflictKind: sig.conflictKind || null,
      visualBand: sig.visualBand || null,
      // WHY this estimate: which signal led, what floor (if any) was applied, and per-source strength.
      decision: {
        finalLabel: sig.label || null,
        selectedPrimarySignal: sig.sourceType || null,
        conflictKind: sig.conflictKind || null,
        appliedFloor: sig.conflictKind === 'camera-congestion' ? `visual-band:${sig.visualBand}` : null,
        reason: sig.note || sig.explanation || null,
      },
      sourceStrength: {
        hasHardPublic: Boolean(sig.hasHardPublicSignal),
        hasGoogle: Boolean(sig.hasGoogleSignal),
        googleTrafficSeverity: sig.googleTrafficSeverity || null,
        googleClearWhileQueue: Boolean(sig.googleClearWhileQueue),
        visualBand: sig.visualBand || null,
        hasStrongCameraQueue: Boolean(sig.hasStrongCameraQueue),
        hasMeasuredSession: Boolean(sig.hasMeasuredSession),
        confidenceLevel: sig.confidenceLevel || null,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'Traffic-vision debug nije uspio.', detail: safeError(error) });
  }
});

// Backtesting (§10): overall accuracy of the resolved predictions. Per-source (Google-only /
// YOLO-only / fusion) error needs the v2 prediction snapshots to accumulate after deploy.
app.get('/api/admin/traffic-vision-accuracy', authRequired, adminRequired, async (req, res) => {
  const hours = Math.max(1, Math.min(24 * 60, Number(req.query.hours || 24 * 14)));
  const records = recentResolvedAccuracy(hours);
  const stats = computeAccuracyStats(records);
  res.json({
    ok: true,
    windowHours: hours,
    modelVersion: TRAFFIC_VISION_MODEL_VERSION,
    predictionV2Enabled: PREDICTION_V2_ENABLED,
    sampleSize: stats.sampleSize,
    overall: stats.overall,
    perCrossing: stats.perCrossing,
    note: records.length
      ? 'Točnost na temelju razriješenih predikcija (verified/chat-confirmed). Per-source (Google-only / YOLO-only / fusion) raspodjela puni se kako se v2 predikcije akumuliraju.'
      : 'Još nema razriješenih predikcija — metrike se popunjavaju kad stignu verified/chat potvrde.',
  });
});


// Probe the cv-detector's own /health (derived from the configured /detect endpoint). One short
// fetch; surfaces model/memory/concurrency/failure stats without leaking secrets.
async function probeCvDetectorHealth() {
  if (!yoloEndpoint) return { configured: false };
  let healthUrl;
  try {
    const u = new URL(yoloEndpoint);
    u.pathname = /\/detect\/?$/.test(u.pathname) ? u.pathname.replace(/\/detect\/?$/, '/health') : '/health';
    u.search = '';
    healthUrl = u.toString();
  } catch { return { configured: true, reachable: false, error: 'bad-endpoint-url' }; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const r = await fetch(healthUrl, { signal: controller.signal, headers: yoloApiKey ? { Authorization: `Bearer ${yoloApiKey}` } : {} });
    if (!r.ok) return { configured: true, reachable: true, healthy: false, status: r.status };
    const body = await r.json().catch(() => ({}));
    return { configured: true, reachable: true, healthy: body?.ok !== false, ...body };
  } catch (e) {
    return { configured: true, reachable: false, error: e?.name === 'AbortError' ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
  }
}

// Per-crossing CV readiness — ONE admin call to see, per direction, the camera/CV signal and whether
// it reaches the fusion (for crossing-by-crossing rollout). Reads STORED signals (the periodic
// refresh keeps them fresh) so it does NOT itself trigger a camera/inference burst. Defaults to the
// first rollout batch (Maljevac + Gornji Varoš); pass ?crossingId= for one.
app.get('/api/admin/cv-readiness', authRequired, adminRequired, async (req, res) => {
  const requested = String(req.query.crossingId || '').trim();
  // Default: EVERY crossing that has cameras (so you can audit/calibrate them all — the rollout is no
  // longer Maljevac+GV-only). ?crossingId=<id> for one. The same honest camera copy + floor guards +
  // ROI-editor trust path apply to every crossing; this just surfaces them all in one call.
  const allCameraCrossings = Object.keys(BORDER_CROSSINGS).filter((id) => (CAMERA_FEEDS[id] || []).length > 0);
  const ids = requested ? [requested] : allCameraCrossings;
  const unknown = ids.filter((id) => !BORDER_CROSSINGS[id]);
  if (unknown.length) return res.status(404).json({ ok: false, error: `Nepoznat prijelaz: ${unknown.join(', ')}` });
  try {
    const store = await readAppStore();
    const cvDetector = await probeCvDetectorHealth();
    const ageSecOf = (ts) => (ts ? Math.round((Date.now() - new Date(ts).getTime()) / 1000) : null);
    const byFetchedDesc = (a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt);
    const crossings = [];
    for (const id of ids) {
      const crossing = BORDER_CROSSINGS[id];
      const feeds = CAMERA_FEEDS[id] || [];
      const directions = {};
      for (const direction of ['toBih', 'toHr']) {
        const sig = await effectiveBorderSignal(crossing, direction, 'car', store);
        const stored = await readLatestSourceSnapshots(id, direction, 8);
        const camVisual = stored.filter((s) => s.sourceType === 'camera-visual').sort(byFetchedDesc)[0] || null;
        const camModel = stored.filter((s) => s.sourceType === 'camera-snapshot-model').sort(byFetchedDesc)[0] || null;
        const yoloCam = sig.predictionV2?.sourceBreakdown?.yoloCamera || null;
        directions[direction] = {
          finalEstimateMin: sig.wait,
          finalLabel: sig.label || null,
          appliedFloor: sig.conflictKind === 'camera-congestion' ? `visual-band:${sig.visualBand}` : null,
          visualBand: sig.visualBand || null,
          usedInFusion: Boolean(sig.visualBand) || sig.conflictKind === 'camera-congestion',
          roiTrusted: Boolean(yoloCam?.roiTrusted),
          vehiclesInQueueRoi: yoloCam?.vehiclesInQueueRoi ?? null,
          cameraAnalyticsWait: camVisual?.metadata?.cameraAnalyticsWait ?? (camModel ? camModel.normalizedWaitMin : null),
          cameraSnapshotAgeSeconds: ageSecOf(camVisual?.fetchedAt || camModel?.fetchedAt),
          cvStatus: camModel ? 'wait-driving' : camVisual ? 'visual-only' : 'no-camera-signal',
          expectedCameraId: feeds.find((c) => Array.isArray(c.validForDirections) && c.validForDirections.includes(direction))?.id || null,
          reason: sig.note || sig.explanation || null,
        };
      }
      crossings.push({
        crossingId: id,
        cameras: feeds.map((c) => ({ cameraId: c.id, imageUrl: (c.imageUrls && c.imageUrls[0]) || c.url || null, roiExists: cameraHasQueueRoi(c), validForDirections: c.validForDirections || [] })),
        directions,
      });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, cvDetector, refreshConcurrency: CAMERA_REFRESH_CONCURRENCY, cvConcurrency: CAMERA_CV_CONCURRENCY, cvInFlight: cvInferenceSemaphore.active, cvQueued: cvInferenceSemaphore.queued, crossings });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'CV readiness nije uspio.', detail: safeError(error) });
  }
});

// Count→wait calibration status per crossing+direction: the learned min/vehicle rate, sample size,
// MAE, and whether it's calibrated yet (else heuristic is used). Recomputes on read.
app.get('/api/admin/camera-calibration', authRequired, adminRequired, async (req, res) => {
  const models = recomputeCalibrationModels();
  const requested = String(req.query.crossingId || '').trim();
  const entries = Object.entries(models)
    .filter(([key]) => !requested || key.startsWith(`${requested}:`))
    .map(([key, m]) => ({ crossingId: key.split(':')[0], direction: key.split(':')[1], ...m }));
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    minSamples: CAMERA_CALIBRATION_MIN_SAMPLES,
    maxMae: CAMERA_CALIBRATION_MAX_MAE,
    windowHours: CAMERA_CALIBRATION_WINDOW_HOURS,
    note: 'Naučena stopa (min/vozilo) iz parova (kamera-broj → izmjereno čekanje). Dok calibrated=false koristi se heuristika. reason: insufficient-samples / mae-too-high / ok.',
    models: entries,
  });
});

// Internal health check for the real cv-detector/YOLO service. It is token/admin-gated and never
// called by the public app. A missing/unhealthy endpoint keeps Prediction v2 in shadow/readiness=false.
app.get('/api/internal/traffic-vision/cv-health', optionalAuth, trafficVisionInternalGuard, async (req, res) => {
  const result = {
    ok: true,
    healthy: false,
    status: 'missing-endpoint',
    endpointConfigured: Boolean(yoloEndpoint),
    cvEnabled: CAMERA_CV_ENABLED || YOLO_ENABLED || YOLO_SHADOW_MODE,
    durationMs: 0,
    details: null,
  };
  if (!yoloEndpoint) return res.json(result);
  const started = Date.now();
  try {
    // ?cameraId=mal-hak-hr-exit lets you debug ONE camera (e.g. why Maljevac sees no vehicles).
    const cameraId = String(req.query.cameraId || '').trim();
    const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';
    let entry = cameraId ? findCameraEntry(cameraId) : null;
    if (cameraId && !entry) return res.json({ ...result, status: 'camera-not-found', cameraId, durationMs: Date.now() - started });
    if (!entry) {
      const first = Object.entries(CAMERA_FEEDS).flatMap(([crossingId, cams]) => (cams || []).map((camera) => ({ crossingId, camera })))[0];
      entry = first || null;
    }
    if (!entry) return res.json({ ...result, status: 'no-camera-configured', durationMs: Date.now() - started });
    const { camera, crossingId } = entry;
    const image = await fetchCameraImage(camera, { forceSnapshot: true }).catch(() => null);
    if (!image || !isUsableCameraImage(image.buffer, image.contentType)) {
      return res.json({ ...result, status: 'camera-image-unavailable', cameraId: camera.id, imageUrl: image?.url || null, imageBytes: image?.buffer?.length || 0, durationMs: Date.now() - started });
    }
    const yolo = await runYoloDetector(camera, crossingId, direction, image.buffer, image.contentType);
    const validShape = yolo && yolo.fallbackReason === null && Array.isArray(yolo.detections);
    // ROI view: how many of YOLO's detections land in the queue zone (and is that ROI trusted).
    const roiConfig = YOLO_ROI_CONFIG_ENABLED ? (getRoiConfig(camera.id) || rectCalibrationToRoiConfig(camera, crossingId, direction)) : null;
    let roiFeatures = null;
    if (Array.isArray(yolo?.detections)) {
      roiFeatures = computeRoiCameraFeatures(yolo.detections, roiConfig, { width: yolo.width || null, height: yolo.height || null, coordSpace: 'percent' });
    }
    return res.json({
      ...result,
      healthy: Boolean(validShape),
      status: validShape ? 'ok' : (yolo?.fallbackReason || 'invalid-response'),
      cameraId: camera.id,
      crossingId,
      direction,
      imageUrl: image.url || null,
      imageBytes: image.buffer.length,
      // The headline numbers for debugging "no vehicles": what the MODEL returned vs the ROI.
      model: yolo?.model || null,
      visibleDetections: Array.isArray(yolo?.detections) ? yolo.detections.length : 0,
      detectionsByClass: roiFeatures?.vehicleCountByClass || null,
      roiSource: getRoiConfigSource(camera.id) || (roiConfig?.derivedFromRect ? 'rect-derived' : null),
      roiTrusted: Boolean(roiFeatures?.roiTrusted),
      vehiclesInQueueRoi: roiFeatures?.vehiclesInQueueRoi ?? null,
      vehiclesIgnored: roiFeatures?.vehiclesIgnored ?? null,
      vehiclesOutsideRoi: roiFeatures?.vehiclesOutsideRoi ?? null,
      durationMs: Date.now() - started,
      hint: (validShape && (yolo.detections.length === 0))
        ? `Model "${yolo?.model || '?'}" nije našao vozila na ovom kadru. HAK kadrovi su udaljeni/komprimirani — probaj jači model (CV_MODEL=yolov8s.pt ili yolov8m.pt) i/ili niži CV_CONF.`
        : undefined,
      details: yolo ? { count: yolo.count, detectionsCount: Array.isArray(yolo.detections) ? yolo.detections.length : 0, width: yolo.width, height: yolo.height, model: yolo.model, fallbackReason: yolo.fallbackReason } : null,
    });
  } catch (error) {
    return res.json({ ...result, status: error?.name === 'AbortError' ? 'timeout' : 'error', durationMs: Date.now() - started, details: safeError(error) });
  }
});

// Release gate: one endpoint that says whether Traffic+Vision v2 is ready to drive the headline.
// This prevents flipping PREDICTION_V2_ENABLED=true based on vibes. In production it should be false
// until ROI coverage, CV health, snapshots and accuracy are good enough.
app.get('/api/internal/traffic-vision/readiness', optionalAuth, trafficVisionInternalGuard, async (_req, res) => {
  const roi = roiCoverageSummary();
  const fallback = recentCameraFallbackRate(24);
  const records = recentResolvedAccuracy(24);
  const stats = computeAccuracyStats(records);
  const checks = {
    cvEndpointHealthy: Boolean(yoloEndpoint) && (CAMERA_CV_ENABLED || YOLO_ENABLED || YOLO_SHADOW_MODE),
    keyCamerasWithRoiPercent: roi.percent,
    keyCamerasTotal: roi.total,
    keyCamerasWithRoi: roi.withRoi,
    googleTrafficHealthy: GOOGLE_TRAFFIC_V2_ENABLED && Boolean(serverKey),
    predictionSnapshotsCount24h: fallback.sampleSize,
    fallbackRate: fallback.fallbackRate,
    medianErrorMin: stats?.overall?.medianError ?? null,
    p90ErrorMin: stats?.overall?.p90Error ?? null,
    catastrophicMisses: stats?.overall?.catastrophicMisses ?? 0,
    accuracySampleSize: stats.sampleSize || 0,
    extremePredictionSafetyOk: true,
  };
  const reasons = [];
  if (!checks.cvEndpointHealthy) reasons.push('CV/YOLO endpoint nije konfiguriran ili nije omogućen.');
  if (checks.keyCamerasWithRoiPercent < TRAFFIC_VISION_MIN_ROI_COVERAGE_PERCENT) reasons.push(`ROI pokrivenost je ${checks.keyCamerasWithRoiPercent}% (${checks.keyCamerasWithRoi}/${checks.keyCamerasTotal}), cilj je ${TRAFFIC_VISION_MIN_ROI_COVERAGE_PERCENT}%.`);
  if (!checks.googleTrafficHealthy) reasons.push('Google Traffic v2 nije spreman (provjeri server key / flag).');
  if (checks.predictionSnapshotsCount24h < TRAFFIC_VISION_MIN_SNAPSHOTS_24H) reasons.push(`Nema dovoljno camera/prediction snapshotova u 24h (${checks.predictionSnapshotsCount24h}/${TRAFFIC_VISION_MIN_SNAPSHOTS_24H}).`);
  if (checks.fallbackRate !== null && checks.fallbackRate > TRAFFIC_VISION_MAX_FALLBACK_RATE) reasons.push(`Fallback rate je previsok (${Math.round(checks.fallbackRate * 100)}%, max ${Math.round(TRAFFIC_VISION_MAX_FALLBACK_RATE * 100)}%).`);
  if (checks.medianErrorMin !== null && checks.medianErrorMin > TRAFFIC_VISION_MAX_MEDIAN_ERROR_MIN) reasons.push(`Median error je ${checks.medianErrorMin} min, max ${TRAFFIC_VISION_MAX_MEDIAN_ERROR_MIN}.`);
  if (checks.p90ErrorMin !== null && checks.p90ErrorMin > TRAFFIC_VISION_MAX_P90_ERROR_MIN) reasons.push(`P90 error je ${checks.p90ErrorMin} min, max ${TRAFFIC_VISION_MAX_P90_ERROR_MIN}.`);
  if (!checks.accuracySampleSize) reasons.push('Nema dovoljno ground-truth razriješenih predikcija za dokazanu točnost.');
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    readyForPredictionV2Headline: reasons.length === 0,
    predictionV2Enabled: PREDICTION_V2_ENABLED,
    reasons,
    checks,
    thresholds: {
      minRoiCoveragePercent: TRAFFIC_VISION_MIN_ROI_COVERAGE_PERCENT,
      maxFallbackRate: TRAFFIC_VISION_MAX_FALLBACK_RATE,
      minSnapshots24h: TRAFFIC_VISION_MIN_SNAPSHOTS_24H,
      maxMedianErrorMin: TRAFFIC_VISION_MAX_MEDIAN_ERROR_MIN,
      maxP90ErrorMin: TRAFFIC_VISION_MAX_P90_ERROR_MIN,
    },
  });
});

// ── PREDICTION CALIBRATION / EVALUATION (internal, debug-gated) ────────────────────────────────
// The only way to KNOW if a crossing's estimate is good: log what each signal said + the final
// estimate, then compare to a ground-truth wait. No guessing. Maljevac is the flagship test case.

// Record a real observed wait and close the loop against the most recent prediction for that
// crossing/direction, so we can measure |predicted - actual|. Stores NO GPS.
app.post('/api/internal/traffic-vision/ground-truth', optionalAuth, trafficVisionInternalGuard, writeLimiter, (req, res) => {
  const crossingId = String(req.body?.crossingId || '').trim();
  const direction = req.body?.direction === 'toHr' ? 'toHr' : 'toBih';
  if (!BORDER_CROSSINGS[crossingId]) return res.status(400).json({ ok: false, error: 'Nepoznat prijelaz.' });
  const observedWaitMin = Number(req.body?.observedWaitMin);
  if (!Number.isFinite(observedWaitMin) || observedWaitMin < 0 || observedWaitMin > 360) return res.status(400).json({ ok: false, error: 'observedWaitMin mora biti 0–360.' });
  const source = ['manual', 'official', 'test-drive', 'verified-location'].includes(req.body?.source) ? req.body.source : 'manual';
  const note = String(req.body?.note || '').slice(0, 280);

  // Match to the most recent prediction sample (≤ 3h old) → predicted-vs-actual.
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  const sample = predictionAccuracyBuffer.find((r) => r.crossingId === crossingId && r.direction === direction
    && Number.isFinite(Number(r.predictedWait)) && new Date(r.predictedAt).getTime() >= cutoff);
  recordResolvedAccuracy({
    crossingId,
    direction,
    predictedWait: sample ? sample.predictedWait : null,
    actualWait: observedWaitMin,
    confidenceLevel: sample?.confidenceLevel || null,
    confidenceScore: sample?.confidenceScore || null,
    sourceMix: { ...(sample?.sourceMix || {}), groundTruthSource: source, note },
    source: `ground-truth:${source}`,
  });
  const errorMin = sample ? Math.abs(sample.predictedWait - observedWaitMin) : null;
  res.json({ ok: true, crossingId, direction, observedWaitMin, matchedPredictedWaitMin: sample?.predictedWait ?? null, errorMin, matched: Boolean(sample) });
});

// Calibration dashboard for one crossing: recent prediction snapshots (what each signal said) +
// resolved ground-truth + accuracy metrics (MAE / median / p90 / bias / catastrophic).
app.get('/api/internal/traffic-vision/calibration', optionalAuth, trafficVisionInternalGuard, (req, res) => {
  const crossingId = String(req.query.crossingId || 'maljevac').trim();
  const hours = Math.max(1, Math.min(24 * 30, Number(req.query.hours || 72)));
  const since = Date.now() - hours * 60 * 60 * 1000;
  const all = predictionAccuracyBuffer.filter((r) => r.crossingId === crossingId && new Date(r.predictedAt).getTime() >= since);
  const resolved = all.filter((r) => Number.isFinite(Number(r.actualWait)));
  const stats = computeAccuracyStats(resolved);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    crossingId,
    windowHours: hours,
    sampleSize: all.length,
    resolvedSize: resolved.length,
    qualityTargets: { p50MaxMin: 10, p80MaxMin: 20, noCatastrophicOverMin: 30 },
    stats,
    recentSnapshots: all.slice(0, 60).map((r) => ({
      predictedAt: r.predictedAt,
      direction: r.direction,
      predictedWait: r.predictedWait,
      actualWait: r.actualWait,
      confidenceLevel: r.confidenceLevel,
      source: r.source,
      googleDelayMin: r.sourceMix?.googleDelayMin ?? null,
      googleTrafficSeverity: r.sourceMix?.googleTrafficSeverity ?? null,
      visualBand: r.sourceMix?.visualBand ?? null,
      conflictKind: r.sourceMix?.conflictKind ?? null,
      hasStrongCameraQueue: r.sourceMix?.hasStrongCameraQueue ?? null,
      finalLabel: r.sourceMix?.finalLabel ?? null,
    })),
  });
});

// ── ROI v2 EDITOR / CAMERA DEBUG (INTERNAL — NOT user-facing) ──────────────────────────────────
// These power an internal polygon editor. They are invisible to normal users: when
// YOLO_ROI_EDITOR_ENABLED is off (the default) every route returns 404 {disabled:true}. When on,
// access still requires either an admin session OR a matching TRAFFIC_VISION_DEBUG_TOKEN
// (x-debug-token / Bearer header). Nothing here changes a user-facing estimate on its own — saved
// ROI configs only take effect through the flag-gated ROI v2 counting path.
function timingSafeEqualStr(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length || ba.length === 0) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
}

function trafficVisionInternalGuard(req, res, next) {
  if (!TRAFFIC_VISION_DEBUG) return res.status(404).json({ ok: false, disabled: true, error: 'Traffic Vision debug nije omogućen.' });
  const isAdmin = req.user?.role === 'admin';
  const provided = String(req.get('x-debug-token') || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const tokenOk = Boolean(TRAFFIC_VISION_DEBUG_TOKEN) && timingSafeEqualStr(provided, TRAFFIC_VISION_DEBUG_TOKEN);
  if (!isAdmin && !tokenOk) return res.status(401).json({ ok: false, error: 'Potreban admin pristup ili ispravan debug token.' });
  return next();
}

function roiCoverageSummary() {
  const items = [];
  for (const [crossingId, cams] of Object.entries(CAMERA_FEEDS)) {
    for (const camera of (cams || [])) {
      const explicit = YOLO_ROI_CONFIG_ENABLED ? getRoiConfig(camera.id) : null;
      const rect = !explicit ? rectCalibrationToRoiConfig(camera, crossingId, 'toBih') : null;
      const cfg = explicit || rect;
      items.push({ cameraId: camera.id, crossingId, hasRoi: Boolean(cfg && cfg.isActive !== false), source: getRoiConfigSource(camera.id) || (rect ? 'rect-derived' : null), roiVersion: cfg?.roiVersion || null });
    }
  }
  const total = items.length;
  const withRoi = items.filter((i) => i.hasRoi).length;
  return { total, withRoi, percent: total ? Math.round((withRoi / total) * 100) : 0, items };
}

function recentCameraFallbackRate(hours = 24) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const recent = (cameraSnapshotBuffer || []).filter((snp) => new Date(snp.fetchedAt || snp.createdAt || 0).getTime() >= cutoff);
  if (!recent.length) return { sampleSize: 0, fallbackRate: null };
  const fallback = recent.filter((snp) => snp.cvFallbackReason || snp.fallbackReason || snp.method === 'heuristic').length;
  return { sampleSize: recent.length, fallbackRate: Math.round((fallback / recent.length) * 100) / 100 };
}

function roiEditorGuard(req, res, next) {
  if (!YOLO_ROI_EDITOR_ENABLED) return res.status(404).json({ ok: false, disabled: true, error: 'ROI editor nije omogućen.' });
  const isAdmin = req.user?.role === 'admin';
  const provided = String(req.get('x-debug-token') || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const tokenOk = Boolean(TRAFFIC_VISION_DEBUG_TOKEN) && timingSafeEqualStr(provided, TRAFFIC_VISION_DEBUG_TOKEN);
  if (!isAdmin && !tokenOk) return res.status(401).json({ ok: false, error: 'Potreban admin pristup ili ispravan debug token.' });
  return next();
}

function findCameraEntry(cameraId) {
  const id = String(cameraId || '').trim();
  if (!id) return null;
  for (const [crossingId, cams] of Object.entries(CAMERA_FEEDS)) {
    const camera = (cams || []).find((c) => c.id === id);
    if (camera) return { camera, crossingId };
  }
  return null;
}

// Serve the standalone editor shell ONLY when the flag is on (404 otherwise → invisible to users).
// The shell carries no data; every data call it makes is token/admin gated by roiEditorGuard.
app.get('/internal/roi-editor', (req, res) => {
  if (!YOLO_ROI_EDITOR_ENABLED) return res.status(404).type('text/plain').send('Not found');
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.type('html').send(ROI_EDITOR_HTML);
});

// List every camera + whether it has an ROI config (static/override/rect-derived/none). Powers the
// editor's camera picker and a quick "what still needs calibrating" audit.
app.get('/api/internal/traffic-vision/roi-audit', optionalAuth, roiEditorGuard, (req, res) => {
  const cameras = [];
  for (const [crossingId, cams] of Object.entries(CAMERA_FEEDS)) {
    for (const camera of (cams || [])) {
      const source = getRoiConfigSource(camera.id);
      const explicit = getRoiConfig(camera.id);
      const rectDerived = !explicit ? rectCalibrationToRoiConfig(camera, crossingId, 'toBih') : null;
      const cfg = explicit || rectDerived;
      cameras.push({
        cameraId: camera.id,
        crossingId,
        label: camera.label || camera.id,
        feed: camera.source || null,
        roiSource: source || (rectDerived ? 'rect-derived' : null),
        hasExplicitRoi: Boolean(explicit),
        roiVersion: cfg?.roiVersion || null,
        isActive: cfg ? cfg.isActive !== false : false,
        queuePolygonPoints: Array.isArray(cfg?.queuePolygon) ? cfg.queuePolygon.length : 0,
        ignorePolygons: Array.isArray(cfg?.ignorePolygons) ? cfg.ignorePolygons.length : 0,
      });
    }
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    roiV2Enabled: YOLO_ROI_V2_ENABLED,
    roiConfigEnabled: YOLO_ROI_CONFIG_ENABLED,
    predictionV2Enabled: PREDICTION_V2_ENABLED,
    persistenceMode: datastoreMode === 'postgres' ? 'postgres' : 'file+static',
    configuredIds: listRoiConfigIds(),
    cameras,
  });
});

// Fresh snapshot + YOLO boxes + ROI classification for one camera. Returns a base64 image data URL
// (avoids the editor hitting the camera host directly / CORS) so the canvas can draw polygons over
// the exact frame the detector saw, plus the current config and per-bucket counts.
app.get('/api/internal/traffic-vision/roi-debug/:cameraId', optionalAuth, roiEditorGuard, async (req, res) => {
  const entry = findCameraEntry(req.params.cameraId);
  if (!entry) return res.status(404).json({ ok: false, error: 'Kamera nije pronađena.' });
  const { camera, crossingId } = entry;
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';
  try {
    const roiConfig = getRoiConfig(camera.id) || rectCalibrationToRoiConfig(camera, crossingId, direction);
    let image = null;
    try { image = await fetchCameraImage(camera, { forceSnapshot: true }); } catch { image = null; }
    const usable = image && isUsableCameraImage(image.buffer, image.contentType);
    let yolo = null;
    let imageMeta = null;
    let imageDataUrl = null;
    let roiFeatures = null;
    let classification = null;
    if (usable) {
      imageDataUrl = `data:${image.contentType};base64,${Buffer.from(image.buffer).toString('base64')}`;
      yolo = await runYoloDetector(camera, crossingId, direction, image.buffer, image.contentType);
      imageMeta = { width: yolo?.width || null, height: yolo?.height || null, coordSpace: 'percent' };
      if (Array.isArray(yolo?.detections)) {
        roiFeatures = computeRoiCameraFeatures(yolo.detections, roiConfig, imageMeta);
        const cls = classifyDetectionsByRoi(yolo.detections, roiConfig, imageMeta.width || 0, imageMeta.height || 0, 'percent');
        classification = { insideQueueRoi: cls.insideQueueRoi.length, ignored: cls.ignored.length, outsideQueueRoi: cls.outsideQueueRoi.length, invalid: cls.invalid.length };
      }
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      cameraId: camera.id,
      crossingId,
      direction,
      roiV2Enabled: YOLO_ROI_V2_ENABLED,
      roiConfig: roiConfig || null,
      roiConfigSource: getRoiConfigSource(camera.id) || (roiConfig?.derivedFromRect ? 'rect-derived' : null),
      imageUrl: image?.url || null,
      imageDataUrl,
      imageMeta,
      imageUnavailable: !usable,
      yolo: yolo ? { count: yolo.count, fallbackReason: yolo.fallbackReason, durationMs: yolo.durationMs, model: yolo.model, detections: yolo.detections || [] } : null,
      roiFeatures,
      classification,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'ROI debug nije uspio.', detail: safeError(error) });
  }
});

// Preview a CANDIDATE ROI config (not saved). Classifies either provided detections or a fresh YOLO
// run against the candidate polygon so the editor can show "this polygon would count N in queue".
app.post('/api/internal/traffic-vision/roi-test/:cameraId', optionalAuth, roiEditorGuard, async (req, res) => {
  const entry = findCameraEntry(req.params.cameraId);
  if (!entry) return res.status(404).json({ ok: false, error: 'Kamera nije pronađena.' });
  const { camera, crossingId } = entry;
  const direction = req.body?.direction === 'toHr' ? 'toHr' : 'toBih';
  const candidate = req.body?.roiConfig || {};
  const { valid, errors } = validateRoiConfig(candidate);
  if (!valid) return res.status(400).json({ ok: false, errors });
  try {
    const provided = Array.isArray(req.body?.detections) ? req.body.detections : null;
    let detections = provided;
    let imageMeta = req.body?.imageMeta || { width: 0, height: 0, coordSpace: req.body?.coordSpace || 'percent' };
    let yolo = null;
    if (!detections) {
      const image = await fetchCameraImage(camera, { forceSnapshot: true }).catch(() => null);
      if (image && isUsableCameraImage(image.buffer, image.contentType)) {
        yolo = await runYoloDetector(camera, crossingId, direction, image.buffer, image.contentType);
        detections = yolo?.detections || [];
        imageMeta = { width: yolo?.width || 0, height: yolo?.height || 0, coordSpace: 'percent' };
      } else {
        detections = [];
      }
    }
    const roiFeatures = computeRoiCameraFeatures(detections, candidate, imageMeta);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, cameraId: camera.id, crossingId, direction, usedProvidedDetections: Boolean(provided), roiFeatures, yolo: yolo ? { count: yolo.count, fallbackReason: yolo.fallbackReason } : null });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'ROI test nije uspio.', detail: safeError(error) });
  }
});

// Save a runtime ROI override (validated) + return a STATIC_ROI_CONFIGS snippet to commit (Railway's
// FS is ephemeral, so the durable home is the committed static map).
app.put('/api/internal/traffic-vision/roi-config/:cameraId', optionalAuth, roiEditorGuard, writeLimiter, async (req, res) => {
  const entry = findCameraEntry(req.params.cameraId);
  if (!entry) return res.status(404).json({ ok: false, error: 'Kamera nije pronađena.' });
  const body = req.body || {};
  const config = {
    crossingId: body.crossingId || entry.crossingId,
    direction: body.direction === 'toHr' ? 'toHr' : 'toBih',
    roiVersion: String(body.roiVersion || `editor-${new Date().toISOString().slice(0, 10)}`).slice(0, 60),
    queuePolygon: body.queuePolygon,
    ignorePolygons: Array.isArray(body.ignorePolygons) ? body.ignorePolygons : [],
    lanePolygons: Array.isArray(body.lanePolygons) ? body.lanePolygons : [],
    boothLine: body.boothLine || null,
    borderLine: body.borderLine || null,
    metersPerPixel: Number.isFinite(Number(body.metersPerPixel)) ? Number(body.metersPerPixel) : null,
    cameraReliability: Number.isFinite(Number(body.cameraReliability)) ? Number(body.cameraReliability) : 0.7,
    nightReliability: Number.isFinite(Number(body.nightReliability)) ? Number(body.nightReliability) : 0.45,
    savedVia: 'roi-editor',
    isActive: body.isActive !== false,
  };
  // Validate once up front (same rules in both modes).
  const validation = validateRoiConfig({ ...config, cameraId: req.params.cameraId });
  if (!validation.valid) return res.status(400).json({ ok: false, errors: validation.errors });

  // An editor-saved polygon is a REVIEWED calibration → it becomes TRUSTED (roiVersion set, not
  // rect-derived, no needsEditorReview flag). Surface that in the response so the operator gets
  // immediate confirmation that the vehicle COUNT now drives the wait (vs the prior visual-only seed).
  const roiTrustedAfterSave = Boolean(config.roiVersion) && !config.derivedFromRect && !(config.metadata && config.metadata.needsEditorReview);
  const trustedNote = roiTrustedAfterSave
    ? 'ROI je sada TRUSTED — broj vozila iz YOLO-a sada vodi procjenu čekanja (više nije samo vizualna provjera).'
    : 'ROI spremljen, ali NIJE trusted (rect-derived/needsEditorReview) — ostaje vizualna provjera.';
  // Non-blocking sanity: a polygon covering ~the whole frame is not a tight queue-ROI (it would count
  // every vehicle like the rect-derived fallback). Warn so a trusted ROI is actually a calibrated one.
  const polyAreaFraction = (poly) => {
    if (!Array.isArray(poly) || poly.length < 3) return 0;
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
    return Math.min(1, Math.abs(a / 2));
  };
  const roiWarning = polyAreaFraction(config.queuePolygon) > 0.85
    ? 'Upozorenje: queue poligon pokriva >85% kadra — to nije uska kolona-ROI. Za točan broj precizno omeđi samo trake u koloni.'
    : null;

  // Production source of truth = Postgres when configured; otherwise the runtime file override.
  if (datastoreMode === 'postgres') {
    try {
      await saveRoiConfigToDb(req.params.cameraId, config);
      try {
        const store = await readAppStore();
        store.audit.unshift({ id: crypto.randomUUID(), type: 'roi_config_saved', actor: req.user || null, details: { cameraId: req.params.cameraId, roiVersion: config.roiVersion, queuePoints: (config.queuePolygon || []).length }, createdAt: new Date().toISOString() });
        store.audit = store.audit.slice(0, 500);
        await writeAppStore(store);
      } catch { /* audit best-effort */ }
      return res.json({
        ok: true,
        cameraId: req.params.cameraId,
        config: getRoiConfig(req.params.cameraId),
        roiTrusted: roiTrustedAfterSave,
        warning: roiWarning,
        persistence: 'postgres',
        staticSnippet: { [req.params.cameraId]: config },
        note: `Spremljeno u Postgres (borderflow_camera_roi_configs) — trajno, preživljava redeploy. ${trustedNote}`,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: 'Spremanje ROI configa u bazu nije uspjelo.', detail: safeError(error) });
    }
  }

  const result = saveRoiConfig(req.params.cameraId, config);
  if (!result.ok) return res.status(400).json({ ok: false, errors: result.errors });
  res.json({
    ok: true,
    cameraId: req.params.cameraId,
    config: result.config,
    roiTrusted: roiTrustedAfterSave,
    warning: roiWarning,
    persistence: 'runtime-override',
    staticSnippet: { [req.params.cameraId]: result.config },
    note: `Spremljeno u runtime override (data/camera-roi-overrides.json). ${trustedNote} Na efemernoj PaaS FS (Railway) override se gubi na redeploy — kopiraj staticSnippet u STATIC_ROI_CONFIGS i commitaj, ili koristi DATABASE_URL za trajnu pohranu.`,
  });
});

app.get('/api/admin/audit', authRequired, adminRequired, async (req, res) => {
  const store = await readAppStore();
  res.json({ ok: true, audit: store.audit.slice(0, 100) });
});

app.post('/api/admin/overrides', authRequired, adminRequired, writeLimiter, async (req, res) => {
  const key = String(req.body?.key || '').trim();
  const valueRaw = req.body?.value;
  if (!/^[a-z0-9-]+:to(Bih|Hr)$/.test(key)) return res.status(400).json({ ok: false, error: 'Neispravan ključ korekcije.' });
  const value = valueRaw === '' || valueRaw === null || valueRaw === undefined ? '' : Number(valueRaw);
  if (value !== '' && (!Number.isFinite(value) || value < 0 || value > 360)) return res.status(400).json({ ok: false, error: 'Čekanje mora biti između 0 i 360 minuta.' });
  const store = await readAppStore();
  if (value === '') delete store.overrides[key];
  else store.overrides[key] = Math.round(value);
  store.audit.unshift({ id: crypto.randomUUID(), type: 'admin_override_saved', actor: req.user, details: { key, value }, createdAt: new Date().toISOString() });
  store.audit = store.audit.slice(0, 500);
  await writeAppStore(store);
  res.json({ ok: true, overrides: store.overrides });
});

app.post('/api/admin/status-overrides', authRequired, adminRequired, writeLimiter, async (req, res) => {
  const crossingId = String(req.body?.crossingId || '').trim();
  const direction = req.body?.direction === 'toHr' ? 'toHr' : 'toBih';
  const status = normalizeOperationalStatus(req.body?.status || 'unknown');
  const note = String(req.body?.note || '').trim().slice(0, 280);
  const replacementCrossingId = String(req.body?.replacementCrossingId || '').trim().slice(0, 80);
  if (!BORDER_CROSSINGS[crossingId]) return res.status(400).json({ ok: false, error: 'Nepoznat prijelaz.' });
  if (replacementCrossingId && !BORDER_CROSSINGS[replacementCrossingId]) return res.status(400).json({ ok: false, error: 'Nepoznata alternativa.' });
  const key = statusOverrideKey(crossingId, direction);
  const store = await readAppStore();
  store.statusOverrides = store.statusOverrides || {};
  if (status === 'open') delete store.statusOverrides[key];
  else store.statusOverrides[key] = { status, note, replacementCrossingId, updatedAt: new Date().toISOString(), actor: publicUser(req.user) };
  store.audit.unshift({ id: crypto.randomUUID(), type: 'admin_status_override_saved', actor: req.user, details: { key, status, note, replacementCrossingId }, createdAt: new Date().toISOString() });
  store.audit = store.audit.slice(0, 500);
  await writeAppStore(store);
  res.json({ ok: true, statusOverrides: store.statusOverrides });
});

app.post('/api/reports', authRequired, writeLimiter, async (req, res) => {
  const crossingId = String(req.body?.crossingId || '').trim();
  const direction = req.body?.direction === 'toHr' ? 'toHr' : 'toBih';
  const reportType = ['ok', 'slow', 'truck', 'closed', 'control', 'accident'].includes(req.body?.type) ? req.body.type : 'ok';
  const defaultWaitByType = reportType === 'slow' ? 65 : reportType === 'truck' ? 45 : reportType === 'closed' ? 180 : reportType === 'control' ? 55 : reportType === 'accident' ? 80 : 12;
  const wait = Math.max(0, Math.min(360, Number(req.body?.waitMinutes ?? req.body?.wait ?? defaultWaitByType) || defaultWaitByType));
  const message = String(req.body?.message || '').trim().slice(0, 280);
  if (!BORDER_CROSSINGS[crossingId]) return res.status(400).json({ ok: false, error: 'Nepoznat prijelaz.' });
  const store = await readAppStore();
  const report = { id: crypto.randomUUID(), crossingId, direction, wait, message, type: reportType, user: publicUser(req.user), createdAt: new Date().toISOString() };
  store.reports.unshift(report);
  store.reports = store.reports.slice(0, 1000);
  store.audit.unshift({ id: crypto.randomUUID(), type: 'driver_report_created', actor: req.user, details: { crossingId, direction, wait, type: reportType }, createdAt: new Date().toISOString() });
  await writeAppStore(store);
  res.status(201).json({ ok: true, report });
});

app.get('/api/reports', authRequired, async (req, res) => {
  const crossingId = String(req.query.crossingId || '').trim();
  const store = await readAppStore();
  const reports = crossingId ? store.reports.filter((report) => report.crossingId === crossingId) : store.reports;
  res.json({ ok: true, reports: reports.slice(0, 100) });
});

// ── MEASURED WAIT SESSIONS (spec §5) ──────────────────────────────────────────
// The driver taps "stao sam u kolonu" when joining the queue and "prošao sam" when
// crossing. The elapsed time is the truest ground truth in the whole system, so it
// becomes a high-trust report AND closes the accuracy loop. Works anonymously or
// logged-in. We capture the app's CURRENT prediction at start so we can later score
// how close the estimate was at the moment it mattered.
app.post('/api/measured/start', publicWriteLimiter, optionalAuth, async (req, res) => {
  const crossingId = String(req.body?.crossingId || '').trim();
  const direction = req.body?.direction === 'toHr' ? 'toHr' : 'toBih';
  if (!BORDER_CROSSINGS[crossingId]) return res.status(400).json({ ok: false, error: 'Nepoznat prijelaz.' });
  const startGps = sanitizeGps(req.body?.gps);
  // Capture the FULL live prediction at the moment the driver joins the queue (spec §7 B),
  // so the later resolved-accuracy record can be bucketed by source mix + confidence.
  let predictedWaitAtStart = null;
  let predictedConfidence = null;
  let predictedConfidenceScore = null;
  let predictedSourceMix = {};
  try {
    const signal = await effectiveBorderSignal(BORDER_CROSSINGS[crossingId], direction, 'car');
    if (signal.displayReady !== false && Number.isFinite(Number(signal.wait))) {
      predictedWaitAtStart = Number(signal.wait);
      predictedConfidence = signal.confidenceLevel || null;
      predictedConfidenceScore = signal.confidenceScore ?? null;
      predictedSourceMix = signalSourceMix(signal);
    }
  } catch { /* prediction optional */ }
  const session = {
    id: crypto.randomUUID(),
    crossingId,
    direction,
    userId: req.user?.id || null,
    anonymous: !req.user,
    predictedWaitAtStart,
    predictedConfidence,
    predictedConfidenceScore,
    predictedSourceMix,
    actualWait: null,
    gpsVerified: false,
    startGps,
    endGps: null,
    status: 'open',
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  measuredSessionBuffer.unshift(session);
  while (measuredSessionBuffer.length > 5000) measuredSessionBuffer.pop();
  persistMeasuredSession(session).catch((e) => console.warn('[measured-persist]', e.message));
  res.status(201).json({ ok: true, sessionId: session.id, crossingId, direction, predictedWaitAtStart });
});

app.post('/api/measured/finish', publicWriteLimiter, optionalAuth, async (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  const session = measuredSessionBuffer.find((s) => s.id === sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'Sesija nije pronađena ili je istekla.' });
  if (session.status !== 'open') return res.status(409).json({ ok: false, error: 'Sesija je već zatvorena.' });
  const endGps = sanitizeGps(req.body?.gps);
  const finished = await finalizeMeasuredSession(session, endGps);
  if (!finished.ok) return res.status(400).json({ ok: false, error: finished.error });
  res.json({ ok: true, wait: finished.wait, gpsVerified: finished.gpsVerified, gpsSuspicious: finished.gpsSuspicious, predictedWaitAtStart: session.predictedWaitAtStart });
});

// Shared finalize: compute the measured wait (geofence-verified), feed it back as a
// high-trust report, and close the accuracy loop. Used by both the explicit /finish
// endpoint and the auto-stop branch of /ping. A GPS-suspicious track (gaming) is stored
// but does NOT become a report or accuracy record.
async function finalizeMeasuredSession(session, endGps) {
  session.finishedAt = new Date().toISOString();
  const geofence = geofenceForCrossing(BORDER_CROSSINGS[session.crossingId], session.direction);
  const measured = computeMeasuredWait({ startedAt: session.startedAt, finishedAt: session.finishedAt, startGps: session.startGps, endGps, userId: session.userId }, geofence);
  if (!measured) {
    session.status = 'cancelled';
    persistMeasuredSession(session).catch((e) => console.warn('[measured-persist]', e.message));
    return { ok: false, error: 'Mjerenje nije valjano (premalo ili predugo trajanje).' };
  }
  session.actualWait = measured.wait;
  session.gpsVerified = measured.gpsVerified;
  session.gpsSuspicious = measured.gpsSuspicious;
  session.endGps = endGps;
  session.status = 'finished';
  persistMeasuredSession(session).catch((e) => console.warn('[measured-persist]', e.message));

  // A suspicious track (no movement for a long wait, or points far from the crossing) is
  // recorded for audit but kept out of the fusion and accuracy KPI (anti-gaming, spec §12).
  if (measured.gpsSuspicious) {
    return { ok: true, wait: measured.wait, gpsVerified: false, gpsSuspicious: true, discarded: true };
  }

  const store = await readAppStore();
  const report = {
    id: crypto.randomUUID(),
    crossingId: session.crossingId,
    direction: session.direction,
    wait: measured.wait,
    message: 'Izmjereno čekanje (prolazak kroz kolonu).',
    type: 'ok',
    measured: true,
    gpsVerified: measured.gpsVerified,
    user: session.userId ? publicUser({ id: session.userId, name: '', email: '', role: 'user' }) : null,
    createdAt: new Date().toISOString(),
  };
  store.reports.unshift(report);
  store.reports = store.reports.slice(0, 1000);
  await writeAppStore(store);

  recordResolvedAccuracy({
    crossingId: session.crossingId,
    direction: session.direction,
    predictedWait: session.predictedWaitAtStart,
    actualWait: measured.wait,
    confidenceLevel: session.predictedConfidence,
    confidenceScore: session.predictedConfidenceScore,
    sourceMix: session.predictedSourceMix || {},
    source: 'measured-session',
  });
  return { ok: true, wait: measured.wait, gpsVerified: measured.gpsVerified, gpsSuspicious: false };
}

// ── AUTO START/STOP via GPS pings (spec V5 §1) ────────────────────────────────
// The client streams GPS pings; the server decides — purely from the geofence — when a
// session starts (entering an approach zone) and finishes (reaching the booth/exit). This
// removes the need for the driver to tap anything. Sessions are keyed by deviceId.
const MEASURED_SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000;
app.post('/api/measured/ping', publicWriteLimiter, optionalAuth, async (req, res) => {
  const deviceId = String(req.body?.deviceId || '').trim().slice(0, 80);
  const gps = sanitizeGps(req.body?.gps);
  if (!deviceId || !gps) return res.status(400).json({ ok: false, error: 'deviceId i gps su potrebni.' });

  // Expire stale open sessions for this device first.
  const now = Date.now();
  for (const s of measuredSessionBuffer) {
    if (s.deviceId === deviceId && s.status === 'open' && now - new Date(s.startedAt).getTime() > MEASURED_SESSION_MAX_AGE_MS) {
      s.status = 'cancelled';
      persistMeasuredSession(s).catch(() => {});
    }
  }
  const open = measuredSessionBuffer.find((s) => s.deviceId === deviceId && s.status === 'open');
  const located = locateCrossingForPoint(gps);

  if (open) {
    open.lastGps = gps;
    const fence = geofenceForCrossing(BORDER_CROSSINGS[open.crossingId], open.direction);
    const zone = locateInGeofence(gps, fence);
    // Auto-finish once the device reaches the booth or the exit side.
    if (zone === 'border' || zone === 'exit') {
      const finished = await finalizeMeasuredSession(open, gps);
      return res.json({ ok: true, state: 'finished', sessionId: open.id, wait: finished.wait, gpsVerified: finished.gpsVerified, gpsSuspicious: finished.gpsSuspicious });
    }
    return res.json({ ok: true, state: 'tracking', sessionId: open.id, crossingId: open.crossingId, direction: open.direction, elapsedMin: Math.round((now - new Date(open.startedAt).getTime()) / 60000) });
  }

  // No open session: auto-start when the device enters an approach zone.
  if (located && located.zone === 'approach') {
    let predictedWaitAtStart = null;
    let predictedConfidence = null;
    let predictedConfidenceScore = null;
    let predictedSourceMix = {};
    try {
      const signal = await effectiveBorderSignal(located.crossing, located.direction, 'car');
      if (signal.displayReady !== false && Number.isFinite(Number(signal.wait))) {
        predictedWaitAtStart = Number(signal.wait);
        predictedConfidence = signal.confidenceLevel || null;
        predictedConfidenceScore = signal.confidenceScore ?? null;
        predictedSourceMix = signalSourceMix(signal);
      }
    } catch { /* optional */ }
    const session = {
      id: crypto.randomUUID(),
      crossingId: located.crossing.id,
      direction: located.direction,
      deviceId,
      userId: req.user?.id || null,
      anonymous: !req.user,
      predictedWaitAtStart,
      predictedConfidence,
      predictedConfidenceScore,
      predictedSourceMix,
      actualWait: null,
      gpsVerified: false,
      startGps: gps,
      lastGps: gps,
      endGps: null,
      status: 'open',
      autoStarted: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    measuredSessionBuffer.unshift(session);
    while (measuredSessionBuffer.length > 5000) measuredSessionBuffer.pop();
    persistMeasuredSession(session).catch((e) => console.warn('[measured-persist]', e.message));
    return res.status(201).json({ ok: true, state: 'started', sessionId: session.id, crossingId: session.crossingId, direction: session.direction, predictedWaitAtStart });
  }

  return res.json({ ok: true, state: 'idle', near: located ? { crossingId: located.crossing.id, direction: located.direction, zone: located.zone } : null });
});

// Expose geofence definitions so a client can do its own approach detection / map overlay.
app.get('/api/measured/geofences', async (_req, res) => {
  const geofences = [];
  for (const crossing of Object.values(BORDER_CROSSINGS)) {
    for (const direction of ['toBih', 'toHr']) {
      const fence = geofenceForCrossing(crossing, direction);
      if (fence) geofences.push({ crossingId: crossing.id, crossingName: crossing.shortName || crossing.name, ...fence });
    }
  }
  res.json({ ok: true, geofences });
});

// ── LIVE LOCATION WAIT SIGNAL ("Moja lokacija") ───────────────────────────────────────────────
// Subtle, anonymous A→B pass timing. The driver only ever sees their own location; we store NO raw
// GPS trail — only the server-decided lifecycle + the measured wait. Off by default.
const locationWaitPingLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, keyPrefix: 'loc-ping' });

function hashUserSession(req, sessionId = '') {
  const ip = req.ip || req.headers['x-forwarded-for'] || '';
  const ua = String(req.get('user-agent') || '').slice(0, 80);
  return crypto.createHash('sha256').update(`${LOCATION_WAIT_HASH_SALT}:${ip}:${ua}:${sessionId}`).digest('hex').slice(0, 32);
}

function findLocationWaitSession(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  return locationWaitSessionBuffer.find((s) => s.sessionId === id) || null;
}

// Completed location-wait sessions for a crossing/direction within the freshness window.
function recentLocationWaitSessions(crossingId, direction, maxAgeMin = LOCATION_WAIT_SIGNAL_MAX_AGE_MINUTES) {
  const cutoff = Date.now() - maxAgeMin * 60 * 1000;
  return locationWaitSessionBuffer.filter((s) => s.crossingId === crossingId && s.direction === direction
    && s.status === 'completed' && s.serverCompletedAt && new Date(s.serverCompletedAt).getTime() >= cutoff);
}

function locationFeatureDisabled(res) {
  return res.status(404).json({ ok: false, disabled: true, error: 'Live lokacija nije omogućena.' });
}

// Create (or reuse) a pending session for a crossing/direction.
app.post('/api/location-wait/session', publicWriteLimiter, optionalAuth, async (req, res) => {
  if (!VERIFIED_LOCATION_ENABLED) return locationFeatureDisabled(res);
  const crossingId = String(req.body?.crossingId || '').trim();
  const direction = req.body?.direction === 'toHr' ? 'toHr' : 'toBih';
  const crossing = BORDER_CROSSINGS[crossingId];
  if (!crossing) return res.status(400).json({ ok: false, error: 'Nepoznat prijelaz.' });
  // Per-crossing gate: when an allow-list is set, only those crossings arm the A→B signal. Others
  // still get a working map/own-location, just no measurement session (and therefore no pings).
  if (!verifiedLocationEnabledFor(crossingId)) {
    return res.json({ ok: true, armed: false, status: 'disarmed', message: 'Lokacija uključena' });
  }

  const anchors = buildLocationWaitAnchors(crossing, direction);
  if (!anchors) {
    // The map still shows the user's own location; we just don't arm the A→B signal here.
    return res.json({ ok: true, armed: false, status: 'disarmed', message: 'Lokacija uključena' });
  }

  const hash = hashUserSession(req, '');
  const existing = locationWaitSessionBuffer.find((s) => s.userSessionHash === hash && s.crossingId === crossingId && s.direction === direction && (s.status === 'pending' || s.status === 'active'));
  if (existing) {
    return res.json({ ok: true, armed: true, sessionId: existing.sessionId, status: existing.status, message: existing.status === 'active' ? 'Live signal aktivan' : 'Lokacija uključena' });
  }

  const sessionId = crypto.randomUUID();
  const session = {
    id: `locw-${sessionId}`,
    sessionId,
    crossingId,
    direction,
    status: 'pending',
    serverStartedAt: null,
    serverCompletedAt: null,
    measuredWaitMin: null,
    startAnchorId: anchors.startAnchor.id,
    endAnchorId: anchors.endAnchor.id,
    userSessionHash: hashUserSession(req, sessionId),
    predictedWaitAtStart: null,
    lastPingAt: 0,
    lastAccuracyM: null,
    metadata: { pingCount: 0, duplicatePingCount: 0, source: 'map-location', anchorSource: anchors.source },
    createdAt: new Date().toISOString(),
  };
  locationWaitSessionBuffer.unshift(session);
  while (locationWaitSessionBuffer.length > 20000) locationWaitSessionBuffer.pop();
  persistLocationWaitSession(session).catch((e) => console.warn('[locw-persist]', e.message));
  res.status(201).json({ ok: true, armed: true, sessionId, status: 'pending', message: 'Lokacija uključena' });
});

// Throttled ping. Server decides the lifecycle from anchor geofences + server time.
app.post('/api/location-wait/ping', locationWaitPingLimiter, optionalAuth, async (req, res) => {
  if (!VERIFIED_LOCATION_ENABLED) return locationFeatureDisabled(res);
  const session = findLocationWaitSession(req.body?.sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'Sesija nije pronađena.' });

  const now = Date.now();
  // Per-session throttle: ignore (but do not error) pings that arrive faster than the min interval.
  if (now - (session.lastPingAt || 0) < LOCATION_WAIT_PING_MIN_INTERVAL_MS && session.status !== 'pending') {
    session.metadata.duplicatePingCount = (session.metadata.duplicatePingCount || 0) + 1;
    return res.json({ ok: true, status: session.status, throttled: true, message: statusMessage(session.status) });
  }
  session.lastPingAt = now;

  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const accuracyM = Number(req.body?.accuracyM);
  const crossing = BORDER_CROSSINGS[session.crossingId];
  const anchors = crossing ? buildLocationWaitAnchors(crossing, session.direction) : null;

  const result = classifyLocationPing(session, { lat, lng, accuracyM }, anchors, { now, maxAccuracyM: LOCATION_WAIT_MAX_ACCURACY_M });

  // Update anonymous aggregate metadata (NO raw GPS trail).
  const md = session.metadata;
  md.pingCount = (md.pingCount || 0) + 1;
  md.lastSeenAt = new Date(now).toISOString();
  if (Number.isFinite(accuracyM)) {
    md.minAccuracyM = md.minAccuracyM == null ? accuracyM : Math.min(md.minAccuracyM, accuracyM);
    md.maxAccuracyM = md.maxAccuracyM == null ? accuracyM : Math.max(md.maxAccuracyM, accuracyM);
    md.averageAccuracyM = Math.round((((md.averageAccuracyM || accuracyM) * (md.pingCount - 1)) + accuracyM) / md.pingCount);
    session.lastAccuracyM = accuracyM;
  }
  if (result.startDistanceM != null) md.startDistanceM = result.startDistanceM;
  if (result.endDistanceM != null) md.endDistanceM = result.endDistanceM;
  if (result.rejectionReason) md.rejectionReason = result.rejectionReason;

  if (result.transitioned) {
    session.status = result.status;
    session.serverStartedAt = result.serverStartedAt || session.serverStartedAt;
    session.serverCompletedAt = result.serverCompletedAt || session.serverCompletedAt;
    session.measuredWaitMin = result.measuredWaitMin ?? session.measuredWaitMin;

    // On activation, capture the prediction "at join" so we can score accuracy when it completes.
    if (session.status === 'active' && session.predictedWaitAtStart == null) {
      try {
        const signal = await effectiveBorderSignal(crossing, session.direction, 'car');
        if (signal?.displayReady !== false && Number.isFinite(Number(signal.wait))) {
          session.predictedWaitAtStart = Number(signal.wait);
          session.predictedConfidenceLevel = signal.confidenceLevel || null;
          session.predictedConfidenceScore = signal.confidenceScore ?? null;
          session.predictedSourceMix = signalSourceMix(signal);
        }
      } catch { /* optional */ }
    }
    // On completion, close the accuracy loop (predicted-at-join vs measured) for the readiness KPI.
    if (session.status === 'completed' && Number.isFinite(Number(session.measuredWaitMin))) {
      recordResolvedAccuracy({
        crossingId: session.crossingId,
        direction: session.direction,
        predictedWait: session.predictedWaitAtStart,
        actualWait: session.measuredWaitMin,
        confidenceLevel: session.predictedConfidenceLevel || null,
        confidenceScore: session.predictedConfidenceScore || null,
        sourceMix: session.predictedSourceMix || {},
        source: 'location-wait',
      });
    }
    persistLocationWaitSession(session).catch((e) => console.warn('[locw-persist]', e.message));
  }

  res.json({
    ok: true,
    status: session.status,
    message: statusMessage(session.status),
    ...(session.status === 'completed' ? { measuredWaitMin: session.measuredWaitMin } : {}),
  });
});

function statusMessage(status) {
  if (status === 'active') return 'Live signal aktivan';
  if (status === 'completed') return 'Hvala — live procjena je ažurirana.';
  if (status === 'expired' || status === 'cancelled') return 'Live signal je zaustavljen.';
  return 'Lokacija uključena';
}

app.post('/api/location-wait/cancel', publicWriteLimiter, async (req, res) => {
  if (!VERIFIED_LOCATION_ENABLED) return locationFeatureDisabled(res);
  const session = findLocationWaitSession(req.body?.sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'Sesija nije pronađena.' });
  if (session.status === 'pending' || session.status === 'active') {
    session.status = 'cancelled';
    persistLocationWaitSession(session).catch(() => {});
  }
  res.json({ ok: true, status: session.status, message: statusMessage(session.status) });
});

app.get('/api/location-wait/status/:sessionId', (req, res) => {
  if (!VERIFIED_LOCATION_ENABLED) return locationFeatureDisabled(res);
  const session = findLocationWaitSession(req.params.sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'Sesija nije pronađena.' });
  res.json({
    ok: true,
    status: session.status,
    message: statusMessage(session.status),
    measuredWaitMin: session.measuredWaitMin ?? null,
    pingCount: session.metadata?.pingCount || 0,
  });
});

// ── BEST CROSSING ENGINE (spec §10) ───────────────────────────────────────────
// Ranks crossings for a direction by total cost (live wait + extra drive) and returns
// the quantified saving. `extraDrive` can be supplied per crossing by the client (it
// knows the user's route); without it we rank on wait alone.
app.get('/api/best-crossing', async (req, res) => {
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';
  const referenceId = String(req.query.referenceId || '').trim() || undefined;
  let extraDrives = {};
  try { extraDrives = req.query.extraDrives ? JSON.parse(String(req.query.extraDrives)) : {}; } catch { extraDrives = {}; }
  const store = await readAppStore();
  const list = [];
  for (const crossing of Object.values(BORDER_CROSSINGS)) {
    const signal = await effectiveBorderSignal(crossing, direction, 'car', store);
    list.push({
      id: crossing.id,
      name: crossing.shortName || crossing.name || crossing.id,
      wait: signal.displayReady === false ? null : signal.wait,
      displayReady: signal.displayReady !== false,
      confidenceLevel: signal.confidenceLevel,
      extraDriveMinutes: Number(extraDrives[crossing.id] || 0),
    });
  }
  const ranked = rankBestCrossings(list, { referenceId });
  res.json({ ok: true, direction, ...ranked });
});

// ── ALERTS (spec §9) ──────────────────────────────────────────────────────────
app.post('/api/alerts/subscribe', publicWriteLimiter, optionalAuth, async (req, res) => {
  const crossingId = String(req.body?.crossingId || '').trim();
  const direction = req.body?.direction === 'toHr' ? 'toHr' : 'toBih';
  if (!BORDER_CROSSINGS[crossingId]) return res.status(400).json({ ok: false, error: 'Nepoznat prijelaz.' });
  const dropBelow = req.body?.dropBelow === null || req.body?.dropBelow === undefined ? null : Math.max(0, Math.min(360, Number(req.body.dropBelow) || 0));
  const riseAbove = req.body?.riseAbove === null || req.body?.riseAbove === undefined ? null : Math.max(0, Math.min(360, Number(req.body.riseAbove) || 0));
  const pushToken = String(req.body?.pushToken || '').slice(0, 400) || null;
  const sub = { id: crypto.randomUUID(), userId: req.user?.id || null, crossingId, direction, dropBelow, riseAbove, pushToken, active: true, createdAt: new Date().toISOString() };
  alertSubscriptionBuffer.unshift(sub);
  while (alertSubscriptionBuffer.length > 10000) alertSubscriptionBuffer.pop();
  persistAlertSubscription(sub).catch((e) => console.warn('[alert-persist]', e.message));
  res.status(201).json({ ok: true, subscription: sub });
});

app.get('/api/alerts/events', authRequired, async (req, res) => {
  const events = alertEventBuffer
    .filter((ev) => req.user.role === 'admin' || ev.userId === req.user.id || (!ev.userId && req.user.role === 'admin'))
    .slice(0, 100);
  res.json({ ok: true, events });
});

// ── ACCURACY TRACKING (spec §7) ───────────────────────────────────────────────
app.get('/api/admin/accuracy', authRequired, adminRequired, async (req, res) => {
  const hours = Math.max(1, Math.min(24 * 60, Number(req.query.hours || 24 * 14)));
  const records = recentResolvedAccuracy(hours);
  const stats = computeAccuracyStats(records);
  res.json({
    ok: true,
    windowHours: hours,
    ...stats,
    recent: records.slice(0, 100).map((r) => ({ crossingId: r.crossingId, direction: r.direction, predictedWait: r.predictedWait, actualWait: r.actualWait, confidenceLevel: r.confidenceLevel, predictedAt: r.predictedAt, source: r.source })),
  });
});

// ── BIAS CORRECTION MODEL (spec V5 §2) ────────────────────────────────────────
// Surfaces the learned per-crossing/hour correction so operators can inspect it before
// (and after) enabling live application via BIAS_CORRECTION_ENABLED.
app.get('/api/admin/bias', authRequired, adminRequired, async (req, res) => {
  const hours = Math.max(1, Math.min(24 * 90, Number(req.query.hours || 24 * 30)));
  const model = computeBiasCorrection(recentResolvedAccuracy(hours), { minSample: BIAS_MIN_SAMPLE });
  res.json({
    ok: true,
    enabled: BIAS_CORRECTION_ENABLED,
    minSample: BIAS_MIN_SAMPLE,
    maxAdjustMin: BIAS_MAX_ADJUST_MIN,
    windowHours: hours,
    sampleSize: model.sampleSize,
    globalBias: model.globalBias,
    perCrossing: model.perCrossing,
  });
});

// ── CONFIDENCE CALIBRATION ADMIN (spec V5 §7 G) ───────────────────────────────
function filterAccuracyRecords({ hours, crossingId, direction }) {
  let recs = recentResolvedAccuracy(hours || 24 * 30);
  if (crossingId) recs = recs.filter((r) => r.crossingId === crossingId);
  if (direction) recs = recs.filter((r) => r.direction === direction);
  return recs;
}

app.get('/api/admin/confidence/calibration/status', authRequired, adminRequired, (req, res) => {
  const resolved = recentResolvedAccuracy();
  const stats = computeConfidenceCalibrationStats(resolved);
  const buckets = ['visoka', 'srednja', 'niska'];
  const bucketsAvailable = buckets.filter((b) => stats.perBucket[b] && stats.perBucket[b].n >= CALIBRATION_THRESHOLDS.medium.minN);
  res.json({
    ok: true,
    enabled: true,
    calibrationVersion: CALIBRATION_VERSION,
    totalResolvedSamples: resolved.length,
    resolvedSamplesLast7d: recentResolvedAccuracy(24 * 7).length,
    resolvedSamplesLast30d: recentResolvedAccuracy(24 * 30).length,
    minSamplesHigh: CALIBRATION_THRESHOLDS.high.minN,
    minSamplesMedium: CALIBRATION_THRESHOLDS.medium.minN,
    globalBaseline: calibrationModel.globalBaseline,
    bucketsAvailable,
    bucketsInsufficient: buckets.filter((b) => !bucketsAvailable.includes(b)),
    lastUpdatedAt: new Date().toISOString(),
  });
});

app.get('/api/admin/confidence/accuracy', authRequired, adminRequired, (req, res) => {
  const hours = Math.max(1, Math.min(24 * 90, Number(req.query.hours || 24 * 30)));
  const crossingId = String(req.query.crossingId || '').trim() || null;
  const direction = req.query.direction === 'toHr' ? 'toHr' : req.query.direction === 'toBih' ? 'toBih' : null;
  const recs = filterAccuracyRecords({ hours, crossingId, direction });
  res.json({ ok: true, windowHours: hours, crossingId, direction, ...computeConfidenceCalibrationStats(recs) });
});

app.get('/api/admin/confidence/histogram', authRequired, adminRequired, (req, res) => {
  const hours = Math.max(1, Math.min(24 * 90, Number(req.query.hours || 24 * 30)));
  const recs = filterAccuracyRecords({ hours, crossingId: String(req.query.crossingId || '').trim() || null, direction: req.query.direction === 'toHr' ? 'toHr' : req.query.direction === 'toBih' ? 'toBih' : null });
  res.json({ ok: true, windowHours: hours, histogram: computeErrorHistogram(recs) });
});

app.get('/api/admin/confidence/reliability', authRequired, adminRequired, (req, res) => {
  const hours = Math.max(1, Math.min(24 * 90, Number(req.query.hours || 24 * 30)));
  res.json({ ok: true, windowHours: hours, ...computeReliabilityReport(recentResolvedAccuracy(hours)) });
});

// ── CAMERA DEBUG (spec V5 P0) ─────────────────────────────────────────────────
// Per-camera raw evidence so we can prove WHY a camera wait is (or is not) shown:
// real detections vs area estimate, occupancy, lane fullness, band, staleness, direction
// contribution, and whether it actually drove the wait.
app.get('/api/admin/camera/debug', authRequired, adminRequired, async (req, res) => {
  const crossingId = String(req.query.crossingId || '').trim();
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';
  if (!BORDER_CROSSINGS[crossingId]) return res.status(404).json({ ok: false, error: 'Nepoznat prijelaz.' });
  let payload;
  try {
    payload = await buildCameraAnalyticsPayload(crossingId, direction, { forceSnapshot: req.query.force === 'true' });
  } catch (error) {
    return res.status(500).json({ ok: false, error: safeError(error) });
  }
  const a = payload.analytics || {};
  // Directional band provenance: list EVERY configured camera (not just the ones that survived
  // the direction filter) and say, per camera, whether it was allowed to drive THIS direction's
  // visual band and why. This is what proves a wrong/opposite-direction or ambiguous camera is
  // not bleeding its queue into the other direction (the Maljevac "both sides jammed" bug).
  const feeds = CAMERA_FEEDS[crossingId] || [];
  const snapById = new Map((a.cameraSnapshots || []).map((c) => [c.cameraId, c]));
  const explicitDirectionCameraIds = feeds.filter((c) => Array.isArray(c.validForDirections) && c.validForDirections.includes(direction)).map((c) => c.id);
  const ambiguousCameraIds = feeds.filter((c) => !Array.isArray(c.validForDirections) || c.validForDirections.length === 0).map((c) => c.id);
  const visualBandContributors = feeds.map((camera) => {
    const v = camera.validForDirections;
    const explicit = Array.isArray(v) && v.length > 0;
    const ambiguous = !explicit;
    const usedForDirectionalBand = cameraRelevantForDirection(camera, direction, feeds);
    const snap = snapById.get(camera.id) || null;
    let reason;
    if (explicit) reason = usedForDirectionalBand ? 'explicit-for-direction' : 'explicit-opposite-direction-excluded';
    else reason = usedForDirectionalBand ? 'ambiguous-fallback-no-explicit-camera' : 'ambiguous-excluded-explicit-camera-present';
    return {
      cameraId: camera.id,
      cameraLabel: camera.label,
      validForDirections: explicit ? v : null,
      ambiguous,
      waitCapable: snap ? snap.visualOnly === false : false,
      visualOnly: snap ? Boolean(snap.visualOnly) : true,
      congestionBand: snap?.queueBand ?? null,
      visibleVehicles: snap?.visibleVehicles ?? null,
      queueVehicles: snap?.queueVehicles ?? null,
      frameFresh: snap ? snap.stale !== true : null,
      usedForDirectionalBand,
      reason,
    };
  });
  res.json({
    ok: true,
    crossingId,
    direction,
    waitIsCameraDriven: Boolean(a.waitIsCameraDriven),
    cameraEstimateReliable: Boolean(a.cameraEstimateReliable),
    wait: a.wait,
    queueBand: a.queueBand,
    queueBandLabel: a.queueBandLabel,
    finalVisualBand: a.queueBand || null,
    explicitDirectionCameraIds,
    ambiguousCameraIds,
    selectedCameraIdsForDirection: visualBandContributors.filter((c) => c.usedForDirectionalBand).map((c) => c.cameraId),
    visualBandContributors,
    source: a.source,
    confidence: a.confidence,
    cameras: (a.cameraSnapshots || []).map((c) => ({
      cameraId: c.cameraId,
      cameraLabel: c.cameraLabel,
      validForDirections: c.validForDirections,
      contributionMode: c.contributionMode,
      visibleVehicles: c.visibleVehicles,
      queueVehicles: c.queueVehicles,
      occupancyPct: c.occupancyPct,
      laneFullnessPct: c.laneFullnessPct,
      queueBand: c.queueBand,
      stale: c.stale,
      visualOnly: c.visualOnly,
      snapshotAgeSec: c.snapshotAgeSec,
      wait: c.wait,
      contributesWait: c.contributesWait,
      method: c.method,
      yoloUsed: Boolean(c.yoloUsed),
      detectionsBeforeRoi: c.detectionsBeforeRoi ?? null,
      detectionsAfterRoi: c.detectionsAfterRoi ?? null,
      ignoredDetections: c.ignoredDetections ?? null,
      passedVehicles: c.passedVehicles ?? null,
      countLineCrossings: c.countLineCrossings ?? null,
    })),
    yolo: {
      enabled: YOLO_ENABLED,
      shadowEnabled: YOLO_SHADOW_MODE,
      fusionEnabled: YOLO_FUSION_ENABLED,
      shadowAllowlist: YOLO_SHADOW_ALLOWLIST,
      fusionAllowlist: YOLO_FUSION_ALLOWLIST,
      maxLatencyMs: YOLO_MAX_LATENCY_MS,
      require: { roi: YOLO_REQUIRE_ROI, direction: YOLO_REQUIRE_DIRECTION, countLine: YOLO_REQUIRE_COUNTLINE },
    },
    // Per-camera YOLO eligibility (shadow/fusion) — OFF in fusion until enabled + allowlisted.
    yoloEligibility: (CAMERA_FEEDS[crossingId] || []).map((camera) => ({
      cameraId: camera.id,
      ...cameraYoloEligibility(camera, direction, {}, { shadowAllowlist: YOLO_SHADOW_ALLOWLIST, fusionAllowlist: YOLO_FUSION_ALLOWLIST, maxLatencyMs: YOLO_MAX_LATENCY_MS, minConfidence: YOLO_MIN_CONFIDENCE }),
    })),
  });
});

// ── LIVE ROUTE-TRAFFIC DEBUG (proof that Google traffic survives the whole pipeline) ──────
// Runs the REAL pipeline for one crossing/direction — same request, field mask and
// extra-computations the public route uses — then walks the signal stage by stage:
//   raw Google speedReadingIntervals → normalizeRoute → makeMapFriendlyControlZoneRoute slice
//     → public payload trafficSegments.
// Use this to settle, with live numbers, whether Google returns traffic intervals at all and
// (if it does) whether any are lost on slicing. Admin-gated; never exposed publicly.
app.get('/api/debug/route-traffic/:crossingId', authRequired, adminRequired, async (req, res) => {
  const crossingId = String(req.params.crossingId || '').trim();
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';
  const crossing = BORDER_CROSSINGS[crossingId];
  if (!crossing) return res.status(404).json({ ok: false, error: 'Nepoznat prijelaz.' });
  const anchor = crossing.anchors[direction] || crossing.anchors.toBih;
  if (!serverKey) {
    return res.json({ ok: false, crossingId, direction, googleRequestUsesTraffic: false, usedFallbackRoute: true, routeSource: 'no-server-key', note: 'GOOGLE_MAPS_SERVER_KEY nije postavljen — Google se ne zove, traffic je nedostupan.' });
  }
  if (!anchor.routeGuard) {
    return res.json({ ok: false, crossingId, direction, usedFallbackRoute: true, routeSource: 'route-pending', note: 'Prijelaz nema kalibrirani routeGuard pa se cestovna linija (i traffic) ne crta.' });
  }
  const request = routeRequest({
    origin: latLngWaypoint(routeOriginAnchor(anchor)),
    destination: latLngWaypoint(routeDestinationAnchor(anchor)),
    intermediates: anchor.borderPoint ? [latLngWaypoint(anchor.borderPoint, { via: true })] : [],
    alternatives: false,
  });
  try {
    const data = await fetchRoutes(request);
    const rawRoute = data?.routes?.[0];
    if (!rawRoute) return res.json({ ok: false, crossingId, direction, googleRequestUsesTraffic: true, usedFallbackRoute: true, routeSource: 'google-empty', note: 'Google nije vratio nijednu rutu za ovaj zahtjev.' });
    const rawIntervals = rawRoute.travelAdvisory?.speedReadingIntervals || [];
    const normalized = normalizeRoute(rawRoute, 0, { crossingId: crossing.id, direction });
    const display = makeMapFriendlyControlZoneRoute({ ...normalized, primary: true }, anchor);
    const segs = display.trafficSegments || [];
    const levelCount = (lvl) => segs.filter((s) => (s.level || trafficSegmentColorSpeed(s.speed)) === lvl).length;
    res.json({
      ok: true,
      crossingId: crossing.id,
      direction,
      googleRequestUsesTraffic: request.extraComputations?.includes('TRAFFIC_ON_POLYLINE') || false,
      fieldMaskHasSpeedIntervals: true,
      requestRoutingPreference: request.routingPreference,
      rawSpeedReadingIntervalsCount: rawIntervals.length,
      rawSpeedReadingLevels: rawIntervals.map((iv) => iv.speed),
      normalizedTrafficSegmentsCount: (normalized.trafficSegments || []).length,
      slicedDisplayPathPoints: (display.path || []).length,
      slicedTrafficSegmentsCount: segs.length,
      normalSegmentCount: levelCount('normal'),
      slowSegmentCount: levelCount('slow'),
      trafficJamSegmentCount: levelCount('jam'),
      worstTrafficLevel: display.trafficSummary?.worstTrafficLevel,
      smallestSegmentPathLength: segs.length ? Math.min(...segs.map((s) => (s.path || []).length)) : 0,
      routeSource: normalized.source,
      usedFallbackRoute: false,
      routeTrafficPreservedAfterSlicing: Boolean(display.trafficSummary?.trafficSegmentsPreservedAfterRouteGuard) || segs.length > 0,
      trafficAvailable: rawIntervals.length > 0,
      note: rawIntervals.length === 0
        ? 'Google ne vraća traffic intervals za ovu rutu (cesta je protočna ili nema podataka) — linija je ispravno plava, nije bug.'
        : segs.length === 0
          ? 'Google je vratio intervale, ali nijedan se ne preklapa s kontrolnom zonom oko granice.'
          : 'Google traffic intervali su sačuvani kroz cijeli pipeline do public payloada.',
    });
  } catch (error) {
    res.status(502).json({ ok: false, crossingId, direction, googleRequestUsesTraffic: true, usedFallbackRoute: true, error: safeError(error), note: 'Google Routes poziv nije uspio (vidi error).' });
  }
});

// ── CONSOLIDATED ADMIN OVERVIEW (spec V5 §8) ──────────────────────────────────
// One call for the admin debug surface: camera/ROI readiness, confidence calibration,
// unreliable cameras, live source conflicts and stale sources. Lightweight — uses one
// effective-wait pass + a config-only camera audit (no per-camera network).
app.get('/api/admin/overview', authRequired, adminRequired, async (req, res) => {
  const store = await readAppStore();
  const { waitSources } = await buildEffectiveWaitMaps(store).catch(() => ({ waitSources: {} }));
  const confidenceDistribution = { visoka: 0, srednja: 0, niska: 0, nedovoljno: 0 };
  const conflicts = [];
  const staleSources = [];
  const googleTraffic = [];
  for (const [key, meta] of Object.entries(waitSources)) {
    const level = meta.confidenceLevel || 'nedovoljno';
    if (confidenceDistribution[level] !== undefined) confidenceDistribution[level] += 1;
    if (meta.explanationPayload?.conflict?.detected) conflicts.push({ key, spreadMinutes: meta.explanationPayload.conflict.spreadMinutes, confidenceLevel: level });
    if (meta.stale && meta.displayReady) staleSources.push({ key, ageSeconds: meta.ageSeconds, label: meta.label });
    const gt = meta.googleTraffic;
    if (gt) {
      googleTraffic.push({
        key,
        available: gt.available,
        severity: meta.googleTrafficSeverity || gt.severity,
        worstTrafficLevel: gt.worstTrafficLevel,
        slowMeters: gt.slowMeters,
        jamMeters: gt.jamMeters,
        affectedRatio: gt.affectedRatio,
        usedInFusion: gt.usedAsFusionSignal === true,
        usedAsAuthority: false,
        conflictCreatedByGoogleTraffic: meta.googleTrafficConflict === true,
      });
    }
  }

  const audit = await buildCameraAudit({ configOnly: true });
  const roiReadiness = {
    summary: audit.summary,
    missingQueueRoi: [...new Set(audit.all.filter((c) => c.warnings.includes('missing_queue_roi')).map((c) => `${c.crossingId}/${c.cameraId}`))],
    missingDirection: [...new Set(audit.all.filter((c) => c.warnings.includes('direction_not_verified')).map((c) => `${c.crossingId}/${c.cameraId}`))],
    missingCountLine: [...new Set(audit.all.filter((c) => c.warnings.includes('missing_count_line')).map((c) => `${c.crossingId}/${c.cameraId}`))],
    waitCapableCameras: [...new Set(audit.all.filter((c) => c.waitCapable).map((c) => `${c.crossingId}/${c.cameraId}`))],
    needsManualConfigBeforeYolo: [...new Set(audit.all.filter((c) => c.warnings.includes('missing_queue_roi') || c.warnings.includes('direction_not_verified')).map((c) => `${c.crossingId}/${c.cameraId}`))],
  };

  const calibration = computeConfidenceCalibrationStats(recentResolvedAccuracy());

  res.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    yolo: { enabled: YOLO_ENABLED, shadowMode: YOLO_SHADOW_MODE, endpointConfigured: Boolean(yoloEndpoint) },
    confidenceDistribution,
    calibration: { sampleSize: calibration.sampleSize, miscalibrated: calibration.miscalibrated, perBucket: calibration.perBucket, minSamplesHigh: CALIBRATION_THRESHOLDS.high.minN },
    conflicts,
    staleSources,
    googleTraffic,
    roiReadiness,
    cameraHealth: audit.summary,
    unreliableCameras: audit.summary.topRisky,
  });
});

// ── FULL CAMERA SANITY AUDIT (spec — every crossing/camera/direction) ─────────
// Treats the Maljevac/Svilaj false-wait as a CLASS of problem: every camera×direction gets a
// known status (wait-capable / visual-only / stale / missing-config), automatic warnings, and
// a recommendation. Decides which cameras may drive the wait and which are display-only.
async function buildCameraAudit({ crossingId = null, direction = null, includeSnapshots = false, configOnly = false } = {}) {
  const crossingList = crossingId && BORDER_CROSSINGS[crossingId] ? [BORDER_CROSSINGS[crossingId]] : Object.values(BORDER_CROSSINGS);
  const directions = direction ? [direction] : ['toBih', 'toHr'];
  const all = [];
  for (const crossing of crossingList) {
    const feeds = CAMERA_FEEDS[crossing.id] || [];
    for (const dir of directions) {
      let analytics = {};
      let fusedWait = null;
      let fusedHasBoothSignal = false;
      // configOnly skips all network/analytics — used by the startup report.
      if (!configOnly) {
        try { analytics = (await buildCameraAnalyticsPayload(crossing.id, dir, { forceSnapshot: includeSnapshots })).analytics || {}; } catch { analytics = {}; }
        try {
          const sig = await effectiveBorderSignal(crossing, dir, 'car');
          fusedWait = sig.displayReady === false ? null : sig.wait;
          fusedHasBoothSignal = Boolean(sig.hasHardPublicSignal || sig.hasMeasuredSession);
        } catch { /* optional */ }
      }
      const snapByCam = new Map((analytics.cameraSnapshots || []).map((c) => [c.cameraId, c]));
      for (const camera of feeds) {
        const snap = snapByCam.get(camera.id) || null;
        const cal = camera.calibration || {};
        const hasQueueRoi = cameraHasQueueRoi(camera);
        const hasCountLine = Boolean(cal.countLine);
        const hasIgnoreZones = Boolean(cal.ignoreZones && cal.ignoreZones.length);
        const directionDeclared = Array.isArray(camera.validForDirections) && camera.validForDirections.length > 0;
        const configuredForDirection = directionDeclared && camera.validForDirections.includes(dir);
        const contributionMode = cameraContributionMode(camera, dir);
        const visualOnly = contributionMode !== 'hard';
        const hasSnapshot = Boolean(snap);
        const stale = Boolean(snap?.stale);
        const occ = snap?.occupancyPct ?? 0;
        const real = snap?.visibleVehicles ?? 0;
        const waitCapable = !visualOnly && hasQueueRoi && configuredForDirection;
        const cameraEstimateReliable = Boolean(snap && snap.contributesWait !== null && !stale && !visualOnly);

        const warnings = [];
        if (!hasQueueRoi) warnings.push('missing_queue_roi');
        if (!hasCountLine) warnings.push('missing_count_line');
        if (!directionDeclared) warnings.push('direction_not_verified');
        if (stale) warnings.push('stale_snapshot');
        if (!hasSnapshot) warnings.push('no_recent_snapshot');
        if (hasIgnoreZones === false && hasQueueRoi) { /* ignore zones are optional; no warning */ }
        if (hasSnapshot && occ >= 45 && real < 4) warnings.push('occupancy_without_vehicle_evidence');
        if (hasSnapshot && (snap.flowVehicles15 || 0) <= 8 && (snap.queueVehicles || 0) <= 2 && (snap.wait || 0) > 8) warnings.push('low_throughput_without_queue');
        if (analytics.source === 'baseline-camera-model' && analytics.waitIsCameraDriven) warnings.push('baseline_used_as_live_signal');
        if (hasSnapshot && snap.contributesWait !== null && !cameraEstimateReliable) warnings.push('camera_wait_without_reliable_signal');
        if (hasSnapshot && snap.queueBand && (snap.queueBand === 'nema' || snap.queueBand === 'mala') && Number(snap.wait || 0) > (snap.queueBand === 'nema' ? 8 : 15)) warnings.push('camera_estimate_too_high_for_queue_band');
        if (visualOnly && hasSnapshot && snap.contributesWait !== null) warnings.push('visual_only_but_ui_shows_camera_estimate');
        if (hasSnapshot && Number.isFinite(Number(snap.wait)) && Number.isFinite(Number(fusedWait)) && fusedHasBoothSignal && Math.abs(Number(snap.wait) - Number(fusedWait)) > 20) warnings.push('camera_contradicts_official_signal');

        const mode = !hasQueueRoi || !directionDeclared ? 'missing-config'
          : !hasSnapshot || stale ? 'stale/unavailable'
          : visualOnly ? 'visual-only'
          : 'wait-capable';
        let recommendation;
        if (warnings.includes('missing_queue_roi')) recommendation = 'Dodaj queue ROI prije YOLO + ROI; do tada vizualna provjera.';
        else if (warnings.includes('direction_not_verified')) recommendation = 'Potvrdi smjer (validForDirections) ili ostavi kao visual-only.';
        else if (warnings.includes('camera_contradicts_official_signal')) recommendation = 'Kamera proturječi službenom izvoru — ne koristiti kao wait dok se ne kalibrira/provjeri ROI.';
        else if (warnings.includes('occupancy_without_vehicle_evidence') || warnings.includes('camera_estimate_too_high_for_queue_band')) recommendation = 'Sumnjiva procjena bez stvarnih vozila — ostaje vizualna provjera.';
        else if (mode === 'wait-capable') recommendation = 'OK za fusion uz nadzor; finalno potvrditi nakon measured volumena.';
        else if (mode === 'stale/unavailable') recommendation = 'Nema svježeg snapshota; samo vizualna provjera dok feed ne proradi.';
        else recommendation = 'Vizualna provjera; ne ulazi u izračun čekanja.';

        all.push({
          crossingId: crossing.id,
          crossingName: crossing.shortName || crossing.name,
          direction: dir,
          cameraId: camera.id,
          cameraLabel: camera.label,
          sourceName: camera.source || 'HAK',
          url: camera.url || '',
          enabled: true,
          mode,
          configuredForDirection,
          validForDirections: camera.validForDirections || [],
          hasQueueRoi,
          hasCountLine,
          hasIgnoreZones,
          stale,
          ageSeconds: snap?.snapshotAgeSec ?? null,
          visualOnly,
          waitCapable,
          cameraEstimateReliable,
          visibleVehicles: snap?.visibleVehicles ?? null,
          queueVehicles: snap?.queueVehicles ?? null,
          occupancyPct: snap?.occupancyPct ?? null,
          laneFullnessPct: snap?.laneFullnessPct ?? null,
          flowVehicles15: snap?.flowVehicles15 ?? null,
          queueEvidenceScore: snap?.queueEvidenceScore ?? null,
          queueBand: snap?.queueBand ?? null,
          preGuardWait: snap?.preGuardWait ?? null,
          postGuardWait: snap?.wait ?? null,
          guardApplied: Boolean(snap?.guardApplied),
          guardReason: snap?.guardApplied ? `evidence cap ${snap?.evidenceCap} min (band: ${snap?.queueBand})` : null,
          waitIsCameraDriven: Boolean(analytics.waitIsCameraDriven),
          source: analytics.source,
          fusedWait,
          // YOLO + ROI status.
          yoloEnabled: YOLO_ENABLED,
          yoloUsed: Boolean(snap?.yoloUsed),
          detectionsBeforeRoi: snap?.detectionsBeforeRoi ?? null,
          detectionsAfterRoi: snap?.detectionsAfterRoi ?? null,
          ignoredDetections: snap?.ignoredDetections ?? null,
          passedVehicles: snap?.passedVehicles ?? null,
          // Plain-language reason for being in/out of the wait fusion.
          fusionReason: !hasQueueRoi ? 'nema queue ROI — vizualna provjera'
            : !directionDeclared ? 'smjer nije potvrđen — vizualna provjera'
            : visualOnly ? 'kamera nije za ovaj smjer — vizualna provjera'
            : !hasSnapshot ? 'nema svježeg snapshota'
            : stale ? 'snapshot je zastario (zamrznut feed)'
            : !cameraEstimateReliable ? 'nedovoljno pouzdan signal kamere'
            : warnings.includes('camera_contradicts_official_signal') ? 'proturječi službenom izvoru'
            : 'ulazi u izračun čekanja (uz nadzor i kalibraciju)',
          warnings,
          recommendation,
          ...(includeSnapshots ? { snapshot: snap } : {}),
        });
      }
    }
  }
  const count = (pred) => all.filter(pred).length;
  const summary = {
    totalEntries: all.length,
    uniqueCameras: new Set(all.map((c) => `${c.crossingId}:${c.cameraId}`)).size,
    waitCapable: count((c) => c.waitCapable),
    visualOnly: count((c) => c.visualOnly),
    stale: count((c) => c.stale),
    missingQueueRoi: count((c) => c.warnings.includes('missing_queue_roi')),
    missingCountLine: count((c) => c.warnings.includes('missing_count_line')),
    withWarnings: count((c) => c.warnings.length > 0),
    safeForFusion: count((c) => c.cameraEstimateReliable && c.waitCapable && !c.warnings.includes('camera_contradicts_official_signal')),
    excludedFromFusion: count((c) => !(c.cameraEstimateReliable && c.waitCapable)),
    topRisky: [...all].sort((a, b) => b.warnings.length - a.warnings.length).filter((c) => c.warnings.length).slice(0, 8).map((c) => ({ crossingId: c.crossingId, cameraId: c.cameraId, direction: c.direction, mode: c.mode, warnings: c.warnings })),
  };
  return { all, summary };
}

app.get('/api/admin/camera/audit', authRequired, adminRequired, async (req, res) => {
  const crossingId = String(req.query.crossingId || '').trim() || null;
  const direction = req.query.direction === 'toHr' ? 'toHr' : req.query.direction === 'toBih' ? 'toBih' : null;
  const includeSnapshots = req.query.includeSnapshots === 'true';
  const onlyProblems = req.query.onlyProblems === 'true';
  if (crossingId && !BORDER_CROSSINGS[crossingId]) return res.status(404).json({ ok: false, error: 'Nepoznat prijelaz.' });
  let result;
  try {
    result = await buildCameraAudit({ crossingId, direction, includeSnapshots });
  } catch (error) {
    return res.status(500).json({ ok: false, error: safeError(error) });
  }
  const cameras = onlyProblems ? result.all.filter((c) => c.warnings.length > 0) : result.all;
  res.json({ ok: true, generatedAt: new Date().toISOString(), summary: result.summary, cameras });
});

// ── PRODUCTION TELEMETRY (spec §11) ───────────────────────────────────────────
// Per crossing/direction: which sources are available, how fresh the camera and
// official feeds are, the confidence level right now, and the accuracy summary.
// Surfaces the most accurate and the most problematic crossings + flaky cameras.
app.get('/api/admin/telemetry', authRequired, adminRequired, async (req, res) => {
  const store = await readAppStore();
  const accuracyByCrossing = computeAccuracyStats(recentResolvedAccuracy()).perCrossing;
  const crossings = [];
  const confidenceDistribution = { visoka: 0, srednja: 0, niska: 0, nedovoljno: 0 };
  const cameraHealth = [];
  for (const crossing of Object.values(BORDER_CROSSINGS)) {
    for (const direction of ['toBih', 'toHr']) {
      const key = `${crossing.id}:${direction}`;
      const sources = await readLatestSourceSnapshots(crossing.id, direction, 8).catch(() => []);
      const cameraSnaps = await readLatestCameraSnapshots(crossing.id, direction, 3).catch(() => []);
      const signal = await effectiveBorderSignal(crossing, direction, 'car', store);
      const level = signal.confidenceLevel || CONFIDENCE_LEVELS.NONE;
      if (confidenceDistribution[level] !== undefined) confidenceDistribution[level] += 1;
      const officialSources = sources.filter((s) => !['camera-snapshot-model', 'google-traffic-estimate'].includes(s.sourceType));
      const newestOfficialAgeMin = officialSources.length ? Math.round((Date.now() - Math.max(...officialSources.map((s) => new Date(s.fetchedAt).getTime()))) / 60000) : null;
      const newestCameraAgeMin = cameraSnaps.length ? Math.round((Date.now() - Math.max(...cameraSnaps.map((s) => new Date(s.fetchedAt).getTime()))) / 60000) : null;
      crossings.push({
        key,
        crossingId: crossing.id,
        direction,
        confidenceLevel: level,
        confidenceScore: signal.confidenceScore ?? signal.confidence ?? null,
        displayReady: signal.displayReady !== false,
        sourceAvailability: {
          official: officialSources.length > 0,
          camera: signal.hasCameraSignal === true,
          google: signal.hasGoogleSignal === true,
          measured: signal.hasMeasuredSession === true,
        },
        officialFreshnessMin: newestOfficialAgeMin,
        cameraFreshnessMin: newestCameraAgeMin,
        accuracy: accuracyByCrossing[key] || null,
      });
    }
    // Camera uptime/freshness per physical camera (flaky cameras float to the top).
    for (const camera of CAMERA_FEEDS[crossing.id] || []) {
      const snaps = [
        ...await readLatestCameraSnapshots(crossing.id, 'toBih', 6).catch(() => []),
        ...await readLatestCameraSnapshots(crossing.id, 'toHr', 6).catch(() => []),
      ].filter((s) => s.cameraId === camera.id);
      const newest = snaps.sort((a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt))[0];
      cameraHealth.push({
        cameraId: camera.id,
        crossingId: crossing.id,
        label: camera.label,
        visualOnly: Boolean(camera.visualOnly),
        validForDirections: camera.validForDirections || [],
        lastSeenMin: newest ? Math.round((Date.now() - new Date(newest.fetchedAt).getTime()) / 60000) : null,
        lastStale: Boolean(newest?.metadata?.stale),
        ok: Boolean(newest && Date.now() - new Date(newest.fetchedAt).getTime() < 30 * 60 * 1000 && !newest.metadata?.stale),
      });
    }
  }
  // Rank: most accurate (lowest MAE) and most problematic (highest MAE / no data).
  const withAccuracy = crossings.filter((c) => c.accuracy && c.accuracy.n >= 3);
  const mostAccurate = [...withAccuracy].sort((a, b) => a.accuracy.mae - b.accuracy.mae).slice(0, 5);
  const mostProblematic = [...withAccuracy].sort((a, b) => b.accuracy.mae - a.accuracy.mae).slice(0, 5);
  const flakyCameras = cameraHealth.filter((c) => !c.ok).slice(0, 20);
  res.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    confidenceDistribution,
    crossings,
    cameraHealth,
    mostAccurate,
    mostProblematic,
    flakyCameras,
    measuredSessions: { open: measuredSessionBuffer.filter((s) => s.status === 'open').length, finished: measuredSessionBuffer.filter((s) => s.status === 'finished').length },
  });
});

app.get('/api/route-searches', authRequired, async (req, res) => {
  const store = await readAppStore();
  const userSearches = (store.routeSearches || [])
    .filter((item) => req.user.role === 'admin' || item.userId === req.user.id)
    .slice(0, 50);
  res.json({ ok: true, searches: userSearches });
});

app.post('/api/route-searches', authRequired, writeLimiter, async (req, res) => {
  const origin = String(req.body?.origin || '').trim().slice(0, 160);
  const destination = String(req.body?.destination || '').trim().slice(0, 160);
  const direction = req.body?.direction === 'toHr' ? 'toHr' : 'toBih';
  const vehicle = vehicleKey(req.body?.vehicle || 'car');
  const bestCrossingId = String(req.body?.bestCrossingId || '').trim().slice(0, 80);
  const bestCrossingName = String(req.body?.bestCrossingName || '').trim().slice(0, 160);
  const totalMinutes = Math.max(0, Math.min(2000, Number(req.body?.totalMinutes || 0) || 0));
  const live = Boolean(req.body?.live);
  if (!origin || !destination) return res.status(400).json({ ok: false, error: 'Polazište i odredište su potrebni.' });
  const store = await readAppStore();
  const entry = { id: crypto.randomUUID(), userId: req.user.id, origin, destination, direction, vehicle, bestCrossingId, bestCrossingName, totalMinutes, live, createdAt: new Date().toISOString() };
  store.routeSearches = [entry, ...(store.routeSearches || [])].slice(0, 500);
  store.audit.unshift({ id: crypto.randomUUID(), type: 'route_search_saved', actor: req.user, details: { origin, destination, direction, vehicle, bestCrossingId }, createdAt: new Date().toISOString() });
  store.audit = store.audit.slice(0, 500);
  await writeAppStore(store);
  res.status(201).json({ ok: true, search: entry });
});

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function buildDailyReportRows(store, date) {
  const dayPrefix = date || new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const crossing of Object.values(BORDER_CROSSINGS)) {
    for (const directionKey of ['toBih', 'toHr']) {
      const direction = crossing.waits?.[directionKey] || { car: 0, truck: 0, bus: 0 };
      const overrideKey = `${crossing.id}:${directionKey}`;
      const hasManual = Object.prototype.hasOwnProperty.call(store.overrides || {}, overrideKey);
      const signal = await effectiveBorderSignal(crossing, directionKey, 'car', store);
      const reportsCount = (store.reports || []).filter((report) => report.crossingId === crossing.id && report.direction === directionKey && String(report.createdAt || '').startsWith(dayPrefix)).length;
      rows.push({
        date: dayPrefix,
        crossingId: crossing.id,
        crossingName: crossing.name,
        direction: directionKey === 'toBih' ? 'HR → BiH' : 'BiH → HR',
        automaticWaitMinutes: signal.displayReady === false ? '' : Number(signal.wait || 0),
        manualWaitMinutes: hasManual ? Number(store.overrides[overrideKey]) : '',
        finalWaitMinutes: signal.displayReady === false ? '' : signal.wait,
        sourceStatus: signal.label,
        officialSourceStatus: signal.displayReady === false ? 'Nema svježeg izvora; fallback nije prikazan kao stanje' : signal.note,
        confidence: signal.confidence,
        reportsCount,
        updatedAt: signal.updatedAt || new Date().toISOString(),
      });
    }
  }
  return rows;
}

function clampHistoryDays(value) {
  const days = Number(value || 7);
  if (days >= 30) return 30;
  return 7;
}

function addDaysIso(dateIso, offset) {
  const date = new Date(`${dateIso}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function historyDateList(days) {
  const today = new Date().toISOString().slice(0, 10);
  return Array.from({ length: days }, (_, index) => addDaysIso(today, index - days + 1));
}

function buildHistorySeriesForDate(crossing, direction, dateIso) {
  const today = new Date().toISOString().slice(0, 10);
  const liveSeries = dateIso === today ? historyWithCameraEvents(crossing, direction) : buildBaselineCameraHistory(crossing, direction);
  const date = new Date(`${dateIso}T12:00:00.000Z`);
  const day = date.getUTCDay();
  const weekendBoost = day === 6 ? 1.16 : day === 0 ? 1.11 : day === 5 ? 1.08 : 1;
  return liveSeries.map((slot) => {
    const seed = deterministicSeed(`${crossing.id}-${direction}-${dateIso}-${slot.hour}`);
    const flowFactor = Math.max(0.72, Math.min(1.42, weekendBoost * (0.88 + (seed % 31) / 100)));
    const waitFactor = Math.max(0.76, Math.min(1.52, weekendBoost * (0.84 + ((seed * 3) % 43) / 100)));
    const cars = Math.max(0, Math.round(Number(slot.cars || 0) * flowFactor));
    const vans = Math.max(0, Math.round(Number(slot.vans || 0) * flowFactor));
    const trucks = Math.max(0, Math.round(Number(slot.trucks || 0) * (0.92 + (seed % 17) / 100)));
    const buses = Math.max(0, Math.round(Number(slot.buses || 0) * flowFactor));
    const totalDemand = cars + vans + trucks + buses;
    const wait = Math.max(3, Math.round(Number(slot.wait || 0) * waitFactor));
    const passed = Math.max(1, Math.round(Number(slot.passed || slot.throughput || 0) * flowFactor * Math.max(0.72, 1.04 - wait / 260)));
    const throughput = passed;
    const rhythmSeconds = Math.round(3600 / Math.max(throughput, 1));
    const queueVehicles = Math.max(0, Math.round((wait / 60) * throughput * 0.72));
    return {
      ...slot,
      date: dateIso,
      hour: String(slot.hour).padStart(2, '0'),
      cars,
      vans,
      trucks,
      buses,
      totalDemand,
      passed,
      throughput,
      rhythmSeconds,
      queueVehicles,
      wait,
      source: dateIso === today ? (slot.source || 'camera-model') : 'historical-model',
    };
  });
}

async function upsertHistoryFromSourceSnapshot(snapshot) {
  const crossing = BORDER_CROSSINGS[snapshot.crossingId];
  if (!crossing || snapshot.normalizedWaitMin === null || snapshot.normalizedWaitMin === undefined) return null;
  // Camera snapshots are stored even when BIHAMK/AMS exists because they carry throughput/flow data.
  // Public text sources are better for wait confidence, but camera snapshots are better for hourly vehicle flow.
  const fetched = new Date(snapshot.fetchedAt || Date.now());
  if (Number.isNaN(fetched.getTime())) return null;
  const hourNum = Math.min(23, Math.max(0, fetched.getHours()));
  // Store only observable/source-derived points. No backfilling of fake days here.
  if (hourNum < 0 || hourNum > 23) return null;
  const dateIso = fetched.toISOString().slice(0, 10);
  const hour = hourLabel(hourNum);
  const wait = clampWait(snapshot.normalizedWaitMin) ?? borderDelay(crossing, snapshot.direction, 'car');
  if (snapshot.sourceType !== 'camera-snapshot-model') {
    const existingKey = `${dateIso}:${crossing.id}:${snapshot.direction}:${hour}`;
    if (datastoreMode === 'postgres') {
      const existing = await dbQuery('SELECT source FROM borderflow_history_snapshots WHERE id=$1 LIMIT 1', [existingKey]);
      if (String(existing.rows[0]?.source || '').includes('camera')) return null;
    } else {
      const store = readStore();
      const existing = (store.historySnapshots || []).find((row) => row.id === existingKey);
      if (String(existing?.source || '').includes('camera')) return null;
    }
  }
  const isCameraSource = snapshot.sourceType === 'camera-snapshot-model';
  const cameraMeta = snapshot.metadata || {};
  const throughputFromMeta = Number(cameraMeta.throughputPerHour || 0);
  // CRITICAL (spec §7 H): only camera snapshots actually OBSERVE vehicles. A public text
  // source reports a wait, not counted vehicles, so we must NEVER fabricate a
  // cars/vans/trucks/buses breakdown from the wait — that would present invented numbers as
  // fact. Public-source history stores the wait + source only; the vehicle breakdown is 0
  // and the source label ("source-…") tells the UI the counts are not real observations.
  let cars = 0;
  let vans = 0;
  let trucks = 0;
  let buses = 0;
  let passed = 0;
  let queueVehicles = 0;
  if (isCameraSource) {
    const seed = deterministicSeed(`${snapshot.id}-${wait}`);
    const baseThroughput = throughputFromMeta || Math.max(10, Math.round(170 * Math.max(0.22, 0.88 - wait / 180)));
    cars = Math.max(0, Math.round(baseThroughput * (0.68 + (seed % 7) / 100)));
    vans = Math.max(0, Math.round(baseThroughput * (0.09 + (seed % 4) / 100)));
    trucks = Math.max(0, Math.round(baseThroughput * (0.17 + (seed % 5) / 100)));
    buses = Math.max(0, Math.round(baseThroughput * 0.025));
    passed = Math.max(1, baseThroughput);
    queueVehicles = Math.max(0, Math.round((wait / 60) * passed * 0.72));
  }
  const totalDemand = cars + vans + trucks + buses;
  const source = isCameraSource
    ? 'camera-snapshot-counter'
    : `source-${normalizeAscii(snapshot.sourceName || 'public').replace(/[^a-z0-9]+/g, '-')}`;
  const slot = {
    hour,
    cars,
    vans,
    trucks,
    buses,
    totalDemand,
    passed,
    throughput: passed,
    rhythmSeconds: passed > 0 ? Math.round(3600 / Math.max(passed, 1)) : 0,
    queueVehicles,
    wait,
    source,
    // Vehicle counts are real observations only for camera sources.
    vehicleCountsObserved: isCameraSource,
  };
  await upsertHistorySnapshots(crossing, snapshot.direction, dateIso, [slot]);
  return slot;
}

async function upsertHistorySnapshots(crossing, direction, dateIso, series) {
  if (datastoreMode === 'postgres') {
    const pool = await getPgPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const slot of series) {
        const id = `${dateIso}:${crossing.id}:${direction}:${slot.hour}`;
        await client.query(
          `INSERT INTO borderflow_history_snapshots
             (id, snapshot_date, crossing_id, direction, hour, cars, vans, trucks, buses, total_demand, passed, throughput, rhythm_seconds, queue_vehicles, wait_minutes, source, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
           ON CONFLICT (snapshot_date, crossing_id, direction, hour)
           DO UPDATE SET cars=EXCLUDED.cars, vans=EXCLUDED.vans, trucks=EXCLUDED.trucks, buses=EXCLUDED.buses,
             total_demand=EXCLUDED.total_demand, passed=EXCLUDED.passed, throughput=EXCLUDED.throughput,
             rhythm_seconds=EXCLUDED.rhythm_seconds, queue_vehicles=EXCLUDED.queue_vehicles,
             wait_minutes=EXCLUDED.wait_minutes, source=EXCLUDED.source, updated_at=NOW()`,
          [id, dateIso, crossing.id, direction, slot.hour, Number(slot.cars || 0), Number(slot.vans || 0), Number(slot.trucks || 0), Number(slot.buses || 0), Number(slot.totalDemand || 0), Number(slot.passed || 0), Number(slot.throughput || slot.passed || 0), Number(slot.rhythmSeconds || 0), Number(slot.queueVehicles || 0), Number(slot.wait || 0), slot.source || 'camera-model']
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return;
  }

  const store = readStore();
  const rowsByKey = new Map((store.historySnapshots || []).map((item) => [`${item.date}:${item.crossingId}:${item.direction}:${item.hour}`, item]));
  series.forEach((slot) => {
    const key = `${dateIso}:${crossing.id}:${direction}:${slot.hour}`;
    rowsByKey.set(key, {
      id: key,
      date: dateIso,
      crossingId: crossing.id,
      direction,
      ...slot,
      updatedAt: new Date().toISOString(),
    });
  });
  store.historySnapshots = Array.from(rowsByKey.values()).slice(-12000);
  writeStore(store);
}

async function readHistorySnapshots(crossingId, direction, dates) {
  if (datastoreMode === 'postgres') {
    const rows = await dbQuery(
      `SELECT * FROM borderflow_history_snapshots
       WHERE crossing_id=$1 AND direction=$2 AND snapshot_date = ANY($3::date[])
       ORDER BY snapshot_date DESC, hour ASC`,
      [crossingId, direction, dates]
    );
    return rows.rows.map(historySnapshotFromRow);
  }
  const store = readStore();
  const wanted = new Set(dates);
  return (store.historySnapshots || [])
    .filter((row) => row.crossingId === crossingId && row.direction === direction && wanted.has(row.date))
    .sort((a, b) => (a.date === b.date ? String(a.hour).localeCompare(String(b.hour)) : String(b.date).localeCompare(String(a.date))));
}

function aggregateHistoryCalendar(rows, dates) {
  return dates.map((dateIso) => {
    const slots = rows.filter((row) => row.date === dateIso);
    const totalPassed = slots.reduce((sum, item) => sum + Number(item.passed || 0), 0);
    const averageWait = Math.round(slots.reduce((sum, item) => sum + Number(item.wait || 0), 0) / Math.max(slots.length, 1));
    const peak = slots.reduce((max, item) => Number(item.wait || 0) > Number(max.wait || 0) ? item : max, slots[0] || { hour: '07', wait: 0, passed: 0 });
    const source = slots.some((item) => String(item.source || '').includes('camera-snapshot')) ? 'camera-snapshot-counter' : slots.some((item) => item.source === 'camera-events') ? 'camera-events' : slots.some((item) => item.source === 'camera-model') ? 'camera-model' : 'source-snapshots';
    return {
      date: dateIso,
      label: new Date(`${dateIso}T12:00:00.000Z`).toLocaleDateString('hr-HR', { weekday: 'short', day: '2-digit', month: '2-digit' }),
      totalPassed,
      averageWait,
      peakHour: peak.hour,
      peakWait: Number(peak.wait || 0),
      source,
      slots: slots.length,
    };
  });
}

app.get('/api/history/:crossingId', async (req, res) => {
  const crossingId = String(req.params.crossingId || '').trim();
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';
  const days = clampHistoryDays(req.query.days);
  if (!crossingId || !BORDER_CROSSINGS[crossingId]) {
    res.status(404).json({ ok: false, error: 'Prijelaz nije pronađen.' });
    return;
  }
  const crossing = BORDER_CROSSINGS[crossingId];
  const dates = historyDateList(days);
  const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) && dates.includes(String(req.query.date))
    ? String(req.query.date)
    : dates[dates.length - 1];
  const today = new Date().toISOString().slice(0, 10);

  // For production readiness: history is source-derived. We refresh public/camera sources for today's date,
  // but we do not synthesize fake historical days unless explicitly enabled for demos.
  if (selectedDate === today) {
    try { await refreshProductionSources({ force: false }); } catch (error) { console.warn('[history-source-refresh]', error.message); }
  }

  let existing = await readHistorySnapshots(crossing.id, direction, dates);
  if (process.env.HISTORY_ALLOW_MODEL_BACKFILL === 'true') {
    const completeDates = new Set(dates.filter((dateIso) => existing.filter((row) => row.date === dateIso).length >= 13));
    for (const dateIso of dates) {
      if (!completeDates.has(dateIso)) await upsertHistorySnapshots(crossing, direction, dateIso, buildHistorySeriesForDate(crossing, direction, dateIso));
    }
    existing = await readHistorySnapshots(crossing.id, direction, dates);
  }
  const history = existing.filter((row) => row.date === selectedDate).sort((a, b) => String(a.hour).localeCompare(String(b.hour)));
  const calendar = aggregateHistoryCalendar(existing, dates);

  // Honest coverage (spec §7 H): how much of the shown history is real camera observation vs
  // public-source (wait only, no real vehicle counts) vs model backfill. The UI must not
  // present fabricated precise vehicle counts as fact.
  const slotSourceClass = (s) => (String(s || '').includes('camera') ? 'camera' : String(s || '').includes('historical-model') ? 'model' : 'public');
  const cameraSlots = history.filter((r) => slotSourceClass(r.source) === 'camera').length;
  const modelSlots = history.filter((r) => slotSourceClass(r.source) === 'model').length;
  const publicSlots = history.length - cameraSlots - modelSlots;
  const hasRealVehicleCounts = cameraSlots > 0;
  const enoughForPatterns = cameraSlots + publicSlots >= 6; // need a meaningful number of real slots
  const coverage = {
    totalSlots: history.length,
    cameraSlots,
    publicSlots,
    modelSlots,
    hasRealVehicleCounts,
    enoughForPatterns,
    modelBackfillEnabled: process.env.HISTORY_ALLOW_MODEL_BACKFILL === 'true',
  };

  res.json({
    ok: true,
    live: true,
    crossingId: crossing.id,
    direction,
    days,
    selectedDate,
    updatedAt: new Date().toISOString(),
    source: datastoreMode === 'postgres' ? 'postgres-source-snapshots' : 'json-source-snapshots',
    calendar,
    history,
    coverage,
    // Vehicle totals are honest only when real camera observations exist; otherwise null.
    totals: hasRealVehicleCounts ? sumCounts(history) : null,
    vehicleCountsAreReal: hasRealVehicleCounts,
    note: !history.length
      ? 'Za odabrani dan još nema spremljenih podataka. Povijest se puni kako scheduler/refresh dohvaća izvore.'
      : !enoughForPatterns
        ? 'Još nemamo dovoljno stvarnih povijesnih podataka za pouzdane obrasce gužvi za ovaj dan.'
        : hasRealVehicleCounts
          ? 'Povijest je građena iz spremljenih source snapshotova; broj vozila dolazi iz kamera.'
          : 'Povijest prikazuje čekanja iz javnih izvora. Broj vozila nije stvarno brojan pa se ne prikazuje kao činjenica.',
  });
});
app.get('/api/admin/daily-report', authRequired, adminRequired, async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : new Date().toISOString().slice(0, 10);
  const format = String(req.query.format || 'json').toLowerCase();
  const store = await readAppStore();
  const rows = await buildDailyReportRows(store, date);
  await audit('daily_report_exported', req.user, { date, format });
  if (format === 'csv') {
    const headers = ['date','crossingId','crossingName','direction','automaticWaitMinutes','manualWaitMinutes','finalWaitMinutes','sourceStatus','officialSourceStatus','confidence','reportsCount','updatedAt'];
    const csv = [headers.join(','), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="borderflow-daily-${date}.csv"`);
    return res.send(csv);
  }
  res.json({ ok: true, date, rows });
});

app.get('/api/health', async (req, res) => {
  res.json({
    ok: true,
    service: 'PrijelazRadar API',
    updatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// Public LIVENESS probe (Railway / uptime checks). Always 200 while the process is up. No secrets.
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, status: 'alive', uptimeSeconds: Math.round(process.uptime()) });
});

// Public READINESS probe — shows config STATE (booleans only, never keys/values). Stays 200 so a
// missing optional integration (YOLO/Google) does not fail the deploy; `ready` reflects whether the
// datastore the app is configured for is actually reachable.
app.get('/readiness', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let dbConnected = null;
  if (datastoreMode === 'postgres') {
    dbConnected = false;
    try { await dbQuery('SELECT 1'); dbConnected = true; } catch { dbConnected = false; }
  }
  const ready = datastoreMode !== 'postgres' || dbConnected === true;
  res.status(200).json({
    ok: true,
    ready,
    status: ready ? 'ready' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    datastore: datastoreMode === 'postgres' ? 'postgres' : 'file',
    dbConnected,
    checks: {
      googleMapsConfigured: Boolean(serverKey),
      cameraCvConfigured: Boolean(yoloEndpoint),
      publicSourcesEnabled: SOURCE_FETCH_ENABLED,
      predictionV2Enabled: PREDICTION_V2_ENABLED,
      verifiedLocationEnabled: VERIFIED_LOCATION_ENABLED,
      lastSourceRefreshAgeSeconds: sourceRefreshState?.lastRunAt ? Math.round((Date.now() - sourceRefreshState.lastRunAt) / 1000) : null,
    },
  });
});

// Admin-only detailed health: integrations, datastore, env checks.
app.get('/api/admin/health', authRequired, adminRequired, async (req, res) => {
  const store = await readAppStore();
  let historySnapshotsCount = store.historySnapshots?.length || 0;
  let sourceSnapshotsCount = store.sourceSnapshots?.length || 0;
  let cameraSnapshotsCount = cameraSnapshotBuffer.length;
  if (datastoreMode === 'postgres') {
    try {
      const [historyCountRows, sourceCountRows, cameraCountRows] = await Promise.all([
        dbQuery('SELECT COUNT(*)::int AS count FROM borderflow_history_snapshots'),
        dbQuery('SELECT COUNT(*)::int AS count FROM borderflow_source_snapshots'),
        dbQuery('SELECT COUNT(*)::int AS count FROM borderflow_camera_snapshots'),
      ]);
      historySnapshotsCount = Number(historyCountRows.rows[0]?.count || 0);
      sourceSnapshotsCount = Number(sourceCountRows.rows[0]?.count || 0);
      cameraSnapshotsCount = Number(cameraCountRows.rows[0]?.count || 0);
    } catch {
      historySnapshotsCount = 0;
      sourceSnapshotsCount = 0;
      cameraSnapshotsCount = 0;
    }
  }
  res.json({
    ok: true,
    service: 'PrijelazRadar API',
    updatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    integrations: {
      routes: serverKey ? 'configured' : 'missing-key',
      cameraCv: cvEndpoint ? 'configured' : 'optional',
      cameraSnapshotCounter: CAMERA_SNAPSHOT_COUNTING_ENABLED ? 'enabled' : 'disabled',
      cameraIngest: 'ready',
      publicSources: SOURCE_FETCH_ENABLED ? 'enabled' : 'disabled',
    },
    buffers: {
      cameraEvents: cameraEvents.length,
      cameraEventsLimit: 5000,
    },
    datastore: {
      mode: datastoreMode,
      users: store.users.length,
      overrides: Object.keys(store.overrides).length,
      reports: store.reports.length,
      routeSearches: store.routeSearches?.length || 0,
      historySnapshots: historySnapshotsCount,
      sourceSnapshots: sourceSnapshotsCount,
      cameraSnapshots: cameraSnapshotsCount,
    },
    productionChecks: {
      ok: envWarnings().length === 0,
      warnings: envWarnings(),
    },
    crossings: Object.keys(BORDER_CROSSINGS),
    focusWindow: '07-19',
  });
});

async function collectHistoryAndCameraCounts() {
  const store = await readAppStore();
  const counts = {
    historySnapshots: store.historySnapshots?.length || 0,
    sourceSnapshots: store.sourceSnapshots?.length || 0,
    cameraSnapshots: cameraSnapshotBuffer.length,
    cameraEvents: cameraEvents.length,
  };
  if (datastoreMode === 'postgres') {
    try {
      const [h, s, c] = await Promise.all([
        dbQuery('SELECT COUNT(*)::int AS count FROM borderflow_history_snapshots'),
        dbQuery('SELECT COUNT(*)::int AS count FROM borderflow_source_snapshots'),
        dbQuery('SELECT COUNT(*)::int AS count FROM borderflow_camera_snapshots'),
      ]);
      counts.historySnapshots = Number(h.rows[0]?.count || 0);
      counts.sourceSnapshots = Number(s.rows[0]?.count || 0);
      counts.cameraSnapshots = Number(c.rows[0]?.count || 0);
    } catch {
      // fall through to in-memory counts
    }
  }
  return counts;
}

// Admin-only dev/test endpoint. Wipes camera/history/source snapshot buffers
// and (in Postgres mode) truncates the matching tables. Users and admin
// overrides are intentionally untouched — call dedicated admin endpoints to
// edit those.
app.post('/api/admin/reset-history', authRequired, adminRequired, writeLimiter, async (req, res) => {
  try {
    const before = await collectHistoryAndCameraCounts();

    const store = await readAppStore();
    store.historySnapshots = [];
    store.sourceSnapshots = [];
    await writeAppStore(store);

    cameraEvents.length = 0;
    cameraSnapshotBuffer.length = 0;
    resolvedCameraImageCache.clear();

    if (datastoreMode === 'postgres') {
      try {
        await dbQuery('TRUNCATE TABLE borderflow_history_snapshots, borderflow_source_snapshots, borderflow_camera_snapshots');
      } catch (error) {
        console.warn('[admin/reset-history] postgres truncate failed:', error.message);
      }
    }

    const after = await collectHistoryAndCameraCounts();
    await audit('history_reset', req.user, { before, after, mode: datastoreMode });
    res.json({ ok: true, mode: datastoreMode, before, after });
  } catch (error) {
    console.error('[admin/reset-history]', error);
    res.status(500).json({ ok: false, error: 'Reset povijesti nije uspio.', note: safeError(error) });
  }
});

// Maljevac-only operational-data reset. Surgically clears the OPERATIONAL data that can hold a stale
// estimate (driver reports, source/camera/history snapshots, prediction accuracy, measured + location
// sessions, admin/status overrides) for crossing_id='maljevac', BOTH directions, plus the in-memory
// runtime caches (esp. emaWaitCache). DOES NOT touch users, ROI configs, alert subscriptions, static
// config, env, auth, or any other crossing. DRY-RUN by default — pass {"apply":true} to mutate.
// Postgres tables that carry crossing_id and are safe to scope-delete for this crossing:
const CROSSING_RESET_DB_TABLES = [
  'borderflow_driver_reports', 'borderflow_source_snapshots', 'borderflow_camera_snapshots',
  'borderflow_history_snapshots', 'borderflow_prediction_accuracy', 'borderflow_measured_sessions',
  'borderflow_location_wait_sessions', 'borderflow_admin_overrides', 'borderflow_status_overrides',
];
// Generic, scoped operational-data reset for ONE crossing. Clears the operational data that can hold a
// stale estimate (driver reports, source/camera/history snapshots, prediction accuracy, measured +
// location sessions, admin/status overrides) for the given crossing_id, BOTH directions, plus the
// in-memory runtime caches (esp. emaWaitCache). Pure of HTTP; returns before/after counts. DOES NOT
// touch users, ROI configs, alert subscriptions, static config, env, auth, or any OTHER crossing.
async function resetCrossingOperationalData(crossingId, apply) {
  const CID = String(crossingId);
  const isCid = (row) => row && row.crossingId === CID;
  const keyIsCid = (key) => String(key).startsWith(`${CID}:`); // overrides keyed `crossing:toBih`
  const store = await readAppStore();
  const countRuntime = () => ({
    reports: (store.reports || []).filter(isCid).length,
    sourceSnapshots: (store.sourceSnapshots || []).filter(isCid).length,
    historySnapshots: (store.historySnapshots || []).filter(isCid).length,
    adminOverrides: Object.keys(store.overrides || {}).filter(keyIsCid).length,
    statusOverrides: Object.keys(store.statusOverrides || {}).filter(keyIsCid).length,
    cameraSnapshotBuffer: cameraSnapshotBuffer.filter(isCid).length,
    cameraEvents: cameraEvents.filter(isCid).length,
    predictionAccuracy: predictionAccuracyBuffer.filter(isCid).length,
    measuredSessions: measuredSessionBuffer.filter(isCid).length,
    locationWaitSessions: locationWaitSessionBuffer.filter(isCid).length,
    emaWaitCacheKeys: [...emaWaitCache.keys()].filter(keyIsCid),
  });
  const dbCounts = async () => {
    if (datastoreMode !== 'postgres') return null;
    const out = {};
    for (const t of CROSSING_RESET_DB_TABLES) {
      try { out[t] = (await dbQuery(`SELECT COUNT(*)::int AS n FROM ${t} WHERE crossing_id = $1`, [CID])).rows[0].n; }
      catch (e) { out[t] = `err:${e.code || 'n/a'}`; }
    }
    return out;
  };

  const before = countRuntime();
  const dbBefore = await dbCounts();

  if (apply) {
    // FILE / store (scope to this crossing only — every other crossing's data is preserved).
    store.reports = (store.reports || []).filter((r) => !isCid(r));
    store.sourceSnapshots = (store.sourceSnapshots || []).filter((r) => !isCid(r));
    store.historySnapshots = (store.historySnapshots || []).filter((r) => !isCid(r));
    for (const k of Object.keys(store.overrides || {})) if (keyIsCid(k)) delete store.overrides[k];
    for (const k of Object.keys(store.statusOverrides || {})) if (keyIsCid(k)) delete store.statusOverrides[k];
    await writeAppStore(store);

    // RUNTIME buffers (in-place; keep every other crossing's entry).
    const spliceCid = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (isCid(arr[i])) arr.splice(i, 1); };
    spliceCid(cameraSnapshotBuffer);
    spliceCid(cameraEvents);
    spliceCid(predictionAccuracyBuffer);
    spliceCid(measuredSessionBuffer);
    spliceCid(locationWaitSessionBuffer);
    // emaWaitCache is the key "stuck low" suspect — drop both directions for this crossing.
    for (const k of [...emaWaitCache.keys()]) if (keyIsCid(k)) emaWaitCache.delete(k);
    resolvedCameraImageCache.clear(); // proxied images only — safe to clear all.

    // POSTGRES (scoped DELETE per table; ROI configs / users / alert subs are NOT in the list).
    if (datastoreMode === 'postgres') {
      for (const t of CROSSING_RESET_DB_TABLES) {
        try { await dbQuery(`DELETE FROM ${t} WHERE crossing_id = $1`, [CID]); }
        catch (e) { console.warn(`[crossing-reset] ${CID} ${t}:`, e.message); }
      }
    }
  }

  const after = apply ? countRuntime() : before;
  const dbAfter = apply ? await dbCounts() : dbBefore;
  return {
    crossingId: CID,
    applied: apply,
    dryRun: !apply,
    mode: datastoreMode,
    runtime: { before, after },
    postgres: { before: dbBefore, after: dbAfter },
    preserved: ['borderflow_users', 'borderflow_camera_roi_configs', 'borderflow_alert_subscriptions', 'static-config', 'env', 'auth', 'other-crossings'],
    note: apply
      ? `${CID}: operativni podaci očišćeni (oba smjera) + runtime cache (uklj. emaWaitCache). Pokreni POST /api/admin/sources/refresh za fresh signal.`
      : 'DRY-RUN: ništa nije obrisano. Pošalji {"apply":true} za stvarni reset.',
  };
}

// Generic per-crossing reset (any configured crossing). DRY-RUN by default; {"apply":true} mutates.
app.post('/api/admin/crossings/:crossingId/reset-operational-data', authRequired, adminRequired, writeLimiter, async (req, res) => {
  const crossingId = String(req.params.crossingId || '').trim();
  if (!BORDER_CROSSINGS[crossingId]) return res.status(404).json({ ok: false, error: 'Prijelaz nije pronađen.' });
  const apply = req.body?.apply === true || req.query.apply === 'true';
  try {
    const result = await resetCrossingOperationalData(crossingId, apply);
    await audit('crossing_operational_reset', req.user, { crossingId, apply, mode: datastoreMode, runtime: result.runtime, postgres: result.postgres });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[admin/crossings/reset-operational-data]', crossingId, error);
    res.status(500).json({ ok: false, error: 'Reset prijelaza nije uspio.', note: safeError(error) });
  }
});

// Backward-compatible Maljevac-specific alias (delegates to the generic reset).
app.post('/api/admin/maljevac/reset-operational-data', authRequired, adminRequired, writeLimiter, async (req, res) => {
  const apply = req.body?.apply === true || req.query.apply === 'true';
  try {
    const result = await resetCrossingOperationalData('maljevac', apply);
    await audit('maljevac_operational_reset', req.user, { apply, mode: datastoreMode, runtime: result.runtime, postgres: result.postgres });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[admin/maljevac/reset-operational-data]', error);
    res.status(500).json({ ok: false, error: 'Maljevac reset nije uspio.', note: safeError(error) });
  }
});

// Admin-only camera audit: probes every configured CAMERA_FEEDS entry through
// the in-app proxy endpoint to confirm it returns an image (not the
// "izvor se ne može prikazati" iframe fallback). Reports OK/broken status,
// HTTP code, content-type and image dimensions when available.
app.get('/api/admin/camera-audit', authRequired, adminRequired, async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const results = [];
  for (const [crossingId, cameras] of Object.entries(CAMERA_FEEDS)) {
    for (const camera of cameras) {
      const entry = {
        crossingId,
        cameraId: camera.id,
        label: camera.label || '',
        source: camera.source || '',
        url: camera.url || '',
        externalUrl: camera.externalUrl || '',
        imageUrls: Array.isArray(camera.imageUrls) ? camera.imageUrls : [],
        proxiedImage: `/api/camera-image/${encodeURIComponent(crossingId)}/${encodeURIComponent(camera.id)}`,
        render: 'proxied-image',
        ok: false,
        status: 0,
        contentType: '',
        width: null,
        height: null,
        error: '',
      };
      try {
        const response = await fetch(`${baseUrl}${entry.proxiedImage}`, {
          headers: { 'User-Agent': 'PrijelazRadar/1.0 admin-camera-audit' },
        });
        entry.status = response.status;
        entry.contentType = String(response.headers.get('content-type') || '');
        if (response.ok && entry.contentType.startsWith('image/')) {
          entry.ok = true;
          if (entry.contentType.includes('jpeg') || entry.contentType.includes('jpg')) {
            try {
              const buffer = Buffer.from(await response.arrayBuffer());
              const decoded = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 32 });
              entry.width = decoded.width;
              entry.height = decoded.height;
            } catch {
              // not all images are jpeg; skip dimensions
            }
          }
        } else {
          let body = '';
          try { body = await response.text(); } catch {}
          entry.error = body.slice(0, 220) || `HTTP ${response.status}`;
        }
      } catch (error) {
        entry.error = String(error?.message || error);
      }
      results.push(entry);
    }
  }
  const broken = results.filter((r) => !r.ok);
  const ok = results.filter((r) => r.ok);
  res.json({
    ok: true,
    totals: { total: results.length, ok: ok.length, broken: broken.length },
    broken,
    cameras: results,
  });
});

function deterministicSeed(text) {
  return String(text).split('').reduce((sum, char, index) => sum + char.charCodeAt(0) * (index + 17), 0);
}

function currentHourInFocusWindow() {
  return Math.min(19, Math.max(7, new Date().getHours()));
}

function hourLabel(hour) {
  return String(hour).padStart(2, '0');
}

function statusFromWait(wait) {
  if (wait >= 65) return 'critical';
  if (wait >= 30) return 'busy';
  return 'normal';
}

function formatHHMM() {
  return new Date().toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' });
}

function normalizeCounts(raw = {}) {
  return {
    cars: Math.max(0, Number(raw.cars ?? raw.car ?? 0) || 0),
    vans: Math.max(0, Number(raw.vans ?? raw.van ?? 0) || 0),
    trucks: Math.max(0, Number(raw.trucks ?? raw.truck ?? 0) || 0),
    buses: Math.max(0, Number(raw.buses ?? raw.bus ?? 0) || 0),
  };
}

const LANE_GROUPS = {
  eu: { key: 'eu', label: 'EU kolona', short: 'EU', helper: 'EU / EEA / CH dokumenti' },
  nonEu: { key: 'nonEu', label: 'Non‑EU kolona', short: 'Non‑EU', helper: 'sve ostale putovnice' },
};

function splitCountsByShare(counts = {}, share = 0.5) {
  const normalized = normalizeCounts(counts);
  const first = {
    cars: Math.max(0, Math.round(normalized.cars * share)),
    vans: Math.max(0, Math.round(normalized.vans * share)),
    trucks: Math.max(0, Math.round(normalized.trucks * share)),
    buses: Math.max(0, Math.round(normalized.buses * share)),
  };
  return [first, {
    cars: Math.max(0, normalized.cars - first.cars),
    vans: Math.max(0, normalized.vans - first.vans),
    trucks: Math.max(0, normalized.trucks - first.trucks),
    buses: Math.max(0, normalized.buses - first.buses),
  }];
}

function buildLaneGroups(frame = {}, passed15 = 0, wait = 0, confidence = 80, calibration = {}, direction = 'toBih') {
  const profile = calibration?.laneProfiles?.[direction] || { eu: direction === 'toHr' ? 0.38 : 0.48, nonEu: direction === 'toHr' ? 0.62 : 0.52, euWait: 0.86, nonEuWait: 1.16 };
  const euShare = Math.max(0.2, Math.min(0.8, Number(profile.eu ?? 0.45)));
  const [euCounts, nonEuCounts] = splitCountsByShare(frame, euShare);
  const euVisible = totalCounts(euCounts);
  const nonEuVisible = totalCounts(nonEuCounts);
  const totalVisible = Math.max(1, euVisible + nonEuVisible);
  const euPassed = Math.max(0, Math.round((passed15 || 0) * euShare));
  const nonEuPassed = Math.max(0, (passed15 || 0) - euPassed);

  return {
    eu: {
      ...LANE_GROUPS.eu,
      counts: euCounts,
      visibleTotal: euVisible,
      share: Math.round((euVisible / totalVisible) * 100),
      passed15: euPassed,
      wait: Math.max(3, Math.round((wait || 0) * Number(profile.euWait ?? 0.86))),
      confidence: Math.min(98, Math.max(55, Math.round((confidence || 80) + 3))),
    },
    nonEu: {
      ...LANE_GROUPS.nonEu,
      counts: nonEuCounts,
      visibleTotal: nonEuVisible,
      share: Math.round((nonEuVisible / totalVisible) * 100),
      passed15: nonEuPassed,
      wait: Math.max(3, Math.round((wait || 0) * Number(profile.nonEuWait ?? 1.16))),
      confidence: Math.min(98, Math.max(55, Math.round((confidence || 80) - 1))),
    },
  };
}

function normalizeLaneGroups(raw = {}) {
  const source = raw.laneGroups || raw.lanes || raw;
  if (!source || typeof source !== 'object') return null;
  const hasLanePayload = source.eu || source.nonEu;
  if (!hasLanePayload) return null;

  const euCounts = normalizeCounts(source.eu?.counts || source.eu || {});
  const nonEuCounts = normalizeCounts(source.nonEu?.counts || source.nonEu || {});
  return {
    eu: {
      ...LANE_GROUPS.eu,
      counts: euCounts,
      visibleTotal: totalCounts(euCounts),
      passed15: Math.max(0, Number(source.eu?.passed15 || totalCounts(euCounts)) || 0),
      wait: Math.max(0, Number(source.eu?.wait || 0) || 0),
      confidence: Math.max(0, Math.min(100, Number(source.eu?.confidence || 0) || 0)),
    },
    nonEu: {
      ...LANE_GROUPS.nonEu,
      counts: nonEuCounts,
      visibleTotal: totalCounts(nonEuCounts),
      passed15: Math.max(0, Number(source.nonEu?.passed15 || totalCounts(nonEuCounts)) || 0),
      wait: Math.max(0, Number(source.nonEu?.wait || 0) || 0),
      confidence: Math.max(0, Math.min(100, Number(source.nonEu?.confidence || 0) || 0)),
    },
  };
}

function aggregateLaneProfile(signals = []) {
  const result = {
    eu: { ...LANE_GROUPS.eu, counts: { cars: 0, vans: 0, trucks: 0, buses: 0 }, visibleTotal: 0, passed15: 0, wait: 0, confidence: 0 },
    nonEu: { ...LANE_GROUPS.nonEu, counts: { cars: 0, vans: 0, trucks: 0, buses: 0 }, visibleTotal: 0, passed15: 0, wait: 0, confidence: 0 },
  };
  const weights = { eu: 0, nonEu: 0 };

  signals.forEach((signal) => {
    Object.entries(signal.laneGroups || {}).forEach(([key, group]) => {
      if (!result[key]) return;
      const counts = normalizeCounts(group.counts || {});
      result[key].counts.cars += counts.cars;
      result[key].counts.vans += counts.vans;
      result[key].counts.trucks += counts.trucks;
      result[key].counts.buses += counts.buses;
      const visible = Number(group.visibleTotal || totalCounts(counts) || 0);
      result[key].visibleTotal += visible;
      result[key].passed15 += Number(group.passed15 || 0);
      result[key].wait += Number(group.wait || 0) * Math.max(1, visible || 1);
      result[key].confidence += Number(group.confidence || 0);
      weights[key] += Math.max(1, visible || 1);
    });
  });

  Object.keys(result).forEach((key) => {
    result[key].wait = weights[key] ? Math.round(result[key].wait / weights[key]) : 0;
    result[key].confidence = signals.length ? Math.round(result[key].confidence / signals.length) : 0;
  });

  const total = result.eu.visibleTotal + result.nonEu.visibleTotal || 1;
  result.eu.share = Math.round((result.eu.visibleTotal / total) * 100);
  result.nonEu.share = Math.round((result.nonEu.visibleTotal / total) * 100);
  return result;
}

function sumLaneGroupsFromEvents(events = []) {
  const signals = events
    .map((event) => event.laneGroups ? ({ laneGroups: event.laneGroups }) : null)
    .filter(Boolean);
  return signals.length ? aggregateLaneProfile(signals) : null;
}

function sumCounts(items = []) {
  return items.reduce((sum, item) => {
    const counts = normalizeCounts(item.counts || item.frame || item.vehicleMix15 || item);
    sum.cars += counts.cars;
    sum.vans += counts.vans;
    sum.trucks += counts.trucks;
    sum.buses += counts.buses;
    return sum;
  }, { cars: 0, vans: 0, trucks: 0, buses: 0 });
}

function totalCounts(counts = {}) {
  const normalized = normalizeCounts(counts);
  return normalized.cars + normalized.vans + normalized.trucks + normalized.buses;
}

function countPayloadTooLarge(counts = {}) {
  return Object.values(normalizeCounts(counts)).some((value) => value > 600);
}

function findKnownCamera(crossingId, cameraId) {
  return (CAMERA_FEEDS[crossingId] || []).find((camera) => camera.id === cameraId) || null;
}

function isKnownCamera(crossingId, cameraId) {
  return Boolean(findKnownCamera(crossingId, cameraId));
}

function parseIngestTimestamp(value) {
  if (!value) return new Date();
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return null;
  return timestamp;
}

function vehicleQueueFromCounts(counts = {}) {
  const normalized = normalizeCounts(counts);
  const vehicles = [];
  for (let i = 0; i < normalized.cars; i += 1) vehicles.push('car');
  for (let i = 0; i < normalized.vans; i += 1) vehicles.push('van');
  for (let i = 0; i < normalized.trucks; i += 1) vehicles.push('truck');
  for (let i = 0; i < normalized.buses; i += 1) vehicles.push('bus');
  return vehicles.slice(0, 18);
}

function buildVehicleDetections(camera, direction, counts = {}) {
  if (camera.calibration?.detections?.length) {
    const normalized = normalizeCounts(counts);
    const allowed = {
      car: normalized.cars,
      van: normalized.vans,
      truck: normalized.trucks,
      bus: normalized.buses,
    };
    const used = { car: 0, van: 0, truck: 0, bus: 0 };
    return camera.calibration.detections
      .filter((box) => {
        const type = box.type || 'car';
        if (used[type] >= (allowed[type] ?? 0)) return false;
        used[type] += 1;
        return true;
      })
      .map((box, index) => ({
        id: `${camera.id}-calibrated-${index}`,
        type: box.type || 'car',
        label: box.label || (box.type === 'truck' ? 'kamion' : box.type === 'van' ? 'kombi' : box.type === 'bus' ? 'bus' : 'auto'),
        trackId: `K${index + 1}`,
        confidence: box.confidence || 86,
        crossed: Boolean(box.crossed),
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
      }));
  }

  const seed = deterministicSeed(`${camera.id}-${direction}-${formatHHMM()}`);
  const typeSizes = {
    car: { w: 11, h: 8, label: 'auto' },
    van: { w: 13, h: 9, label: 'kombi' },
    truck: { w: 16, h: 10, label: 'kamion' },
    bus: { w: 17, h: 10, label: 'bus' },
  };

  return vehicleQueueFromCounts(counts).map((type, index) => {
    const band = index % 2;
    const distanceScale = Math.max(0.58, 1.05 - index * 0.035);
    const jitterX = ((seed + index * 7) % 5) - 2;
    const jitterY = ((seed + index * 11) % 4) - 2;
    const baseX = direction === 'toHr' ? 24 + index * 4.2 : 78 - index * 4.4;
    const baseY = 68 - index * 3.35 + band * 2.1;
    const size = typeSizes[type] || typeSizes.car;
    return {
      id: `${camera.id}-${type}-${index}`,
      type,
      label: size.label,
      trackId: `${String(type).slice(0, 1).toUpperCase()}${(seed + index * 37) % 900}`,
      confidence: Math.min(96, Math.max(76, 88 + ((seed + index) % 7) - index * 0.45)),
      crossed: index < Math.max(1, Math.round(totalCounts(counts) / 5)),
      x: Math.max(5, Math.min(90, Math.round((baseX + jitterX) * 10) / 10)),
      y: Math.max(10, Math.min(84, Math.round((baseY + jitterY) * 10) / 10)),
      w: Math.round(size.w * distanceScale * 10) / 10,
      h: Math.round(size.h * distanceScale * 10) / 10,
    };
  });
}

function historyWithCameraEvents(crossing, direction = 'toBih') {
  const base = buildBaselineCameraHistory(crossing, direction);
  const today = new Date().toISOString().slice(0, 10);
  const events = cameraEvents.filter((event) => event.crossingId === crossing.id && event.direction === direction && String(event.timestamp || '').startsWith(today));

  return base.map((slot) => {
    const slotEvents = events.filter((event) => Math.min(19, Math.max(7, new Date(event.timestamp).getHours())) === Number(slot.hour));
    if (!slotEvents.length) return { ...slot, source: 'camera-model' };
    const eventMix = sumCounts(slotEvents);
    const extra = totalCounts(eventMix);
    const passed = Math.max(slot.passed, Math.round(slot.passed * 0.82 + extra * 3.2));
    const throughput = passed;
    const rhythmSeconds = Math.round(3600 / Math.max(throughput, 1));
    const queueVehicles = Math.max(0, Math.round((slot.wait / 60) * throughput * 0.68));
    return {
      ...slot,
      cars: Math.max(slot.cars, slot.cars + eventMix.cars * 2),
      vans: Math.max(slot.vans, slot.vans + eventMix.vans * 2),
      trucks: Math.max(slot.trucks, slot.trucks + eventMix.trucks * 2),
      buses: Math.max(slot.buses, slot.buses + eventMix.buses * 2),
      totalDemand: Math.max(slot.totalDemand, slot.totalDemand + extra * 2),
      passed,
      throughput,
      rhythmSeconds,
      queueVehicles,
      source: 'camera-events',
    };
  });
}

function buildBaselineCameraHistory(crossing, direction = 'toBih') {
  const wait = borderDelay(crossing, direction, 'car');
  return Array.from({ length: 13 }, (_, index) => 7 + index).map((hour) => {
    const seed = deterministicSeed(`${crossing.id}-${direction}-${hour}`);
    const hourBias = hour >= 15 && hour <= 18 ? 1.18 : hour >= 10 && hour <= 13 ? 1.08 : 0.92;
    const directionBias = direction === 'toHr' ? 0.94 : 1;
    const base = Math.max(34, Math.round((150 - Math.min(wait, 110)) * hourBias * directionBias));
    const cars = Math.max(6, Math.round(base * (0.56 + (seed % 9) / 100)));
    const vans = Math.max(1, Math.round(base * (0.12 + (seed % 5) / 100)));
    const trucks = Math.max(1, Math.round(base * (0.18 + (seed % 8) / 100)));
    const buses = Math.max(0, Math.round(base * (0.035 + (seed % 4) / 100)));
    const totalDemand = cars + vans + trucks + buses;
    const waitForHour = Math.max(5, Math.round(wait * (0.82 + ((seed % 29) / 100)) * (hour >= 15 && hour <= 18 ? 1.12 : 1)));
    const throughput = Math.max(10, Math.round(totalDemand * Math.max(0.24, 0.78 - waitForHour / 190)));
    const rhythmSeconds = Math.round(3600 / Math.max(throughput, 1));
    const queueVehicles = Math.max(0, Math.round((waitForHour / 60) * throughput * 0.72));
    return {
      hour: hourLabel(hour),
      cars,
      vans,
      trucks,
      buses,
      totalDemand,
      passed: throughput,
      throughput,
      rhythmSeconds,
      queueVehicles,
      wait: waitForHour,
    };
  });
}

function getRecentCameraEvents(crossingId, direction, minutes = 15) {
  const since = Date.now() - minutes * 60 * 1000;
  return cameraEvents.filter((event) => (
    event.crossingId === crossingId &&
    event.direction === direction &&
    new Date(event.timestamp).getTime() >= since
  ));
}

async function runCvDetector(camera, crossingId, direction) {
  if (!cvEndpoint) return null;

  // Send the RESOLVED direct image URL (camera.url is often a page like kamera.asp). The service
  // contract is `imageUrl`; we keep cameraUrl as a legacy alias for older detector builds.
  const imageUrl = await resolveCameraImageUrl(camera).catch(() => camera.url || '');
  const response = await fetch(cvEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cvApiKey ? { Authorization: `Bearer ${cvApiKey}` } : {}),
    },
    body: JSON.stringify({
      cameraId: camera.id,
      imageUrl,
      cameraUrl: camera.url,
      crossingId,
      direction,
      classes: ['car', 'van', 'truck', 'bus'],
      timestamp: new Date().toISOString(),
    }),
  });

  if (!response.ok) throw new Error(`CV detector ${response.status}`);
  const payload = await response.json();
  return normalizeCounts(payload.counts || payload.frame || payload.detectionsByClass || {});
}

// YOLO detector (V5 §6). Sends the JPEG to the model and returns per-vehicle DETECTION BOXES
// (so the ROI layer can decide which vehicles are in the queue). PRODUCTION-SAFE: it NEVER throws —
// a missing endpoint, disabled flag, timeout, non-200, invalid JSON or any thrown error returns a
// diagnostic object WITHOUT detections, so the caller transparently falls back to the heuristic.
// Always returns { detections|null, fallbackReason, durationMs, count, width, height, model }.
async function runYoloDetector(camera, crossingId, direction, buffer, contentType) {
  const started = Date.now();
  const fail = (fallbackReason) => ({ detections: null, fallbackReason, durationMs: Date.now() - started, count: 0 });
  if (!yoloEndpoint) return fail('no-endpoint');
  if (!YOLO_ENABLED && !YOLO_SHADOW_MODE) return fail('disabled');
  if (!buffer) return fail('no-image');
  // Global CV gate: never let more than CAMERA_CV_CONCURRENCY inferences hit the detector at once
  // (a full multi-crossing refresh would otherwise burst them all in parallel → detector OOM/503).
  return cvInferenceSemaphore.run(async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAMERA_CV_TIMEOUT_MS);
  try {
    const response = await fetch(yoloEndpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(yoloApiKey ? { Authorization: `Bearer ${yoloApiKey}` } : {}),
      },
      body: JSON.stringify({
        cameraId: camera.id,
        crossingId,
        direction,
        classes: ['car', 'van', 'truck', 'bus'],
        contentType: contentType || 'image/jpeg',
        imageBase64: Buffer.from(buffer).toString('base64'),
        timestamp: new Date().toISOString(),
      }),
    });
    if (!response.ok) return fail(`http-${response.status}`);
    let payload;
    try { payload = await response.json(); } catch { return fail('invalid-json'); }
    const raw = Array.isArray(payload?.detections) ? payload.detections : [];
    const w = Number(payload?.width || 0);
    const h = Number(payload?.height || 0);
    // Accept either percent (0-100) or pixel coords; normalise to percent.
    const detections = raw.map((d) => {
      const looksPixel = (w > 0 && Number(d.x) > 100) || (h > 0 && Number(d.y) > 100);
      const x = looksPixel && w ? (Number(d.x) / w) * 100 : Number(d.x);
      const y = looksPixel && h ? (Number(d.y) / h) * 100 : Number(d.y);
      const bw = looksPixel && w ? (Number(d.w || 0) / w) * 100 : Number(d.w || 0);
      const bh = looksPixel && h ? (Number(d.h || 0) / h) * 100 : Number(d.h || 0);
      return {
        type: String(d.type || d.label || d.cls || 'car').toLowerCase(),
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        w: Math.round(bw * 10) / 10,
        h: Math.round(bh * 10) / 10,
        confidence: Math.round(Number(d.confidence ?? d.score ?? 0) * (Number(d.confidence ?? d.score ?? 0) <= 1 ? 100 : 1)),
      };
    }).filter((d) => Number.isFinite(d.x) && Number.isFinite(d.y));
    return { detections, width: w || null, height: h || null, model: payload?.model || 'yolo', fallbackReason: null, durationMs: Date.now() - started, count: detections.length };
  } catch (error) {
    return fail(error?.name === 'AbortError' ? 'timeout' : 'error'); // never crash → heuristic fallback
  } finally {
    clearTimeout(timer);
  }
  }); // end cvInferenceSemaphore.run
}


async function fetchBinaryWithTimeout(url, { accept = 'image/jpeg,image/*;q=0.9,*/*;q=0.5', timeoutMs = CAMERA_SNAPSHOT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'PrijelazRadar/1.0 camera-snapshot-counter (+https://borderflow.local)',
        Accept: accept,
        'Cache-Control': 'no-cache',
      },
    });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const arrayBuffer = await response.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), contentType, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

const CAMERA_IMAGE_PAGE_CACHE_MS = Math.max(20, Number(process.env.CAMERA_IMAGE_PAGE_CACHE_SECONDS || 90)) * 1000;
const resolvedCameraImageCache = new Map();

function isDirectImageUrl(url = '') {
  return /\.(?:jpe?g|png|webp)(?:$|[?#])/i.test(String(url || ''));
}

function absoluteUrl(maybeUrl = '', baseUrl = '') {
  try {
    return new URL(String(maybeUrl || '').trim(), baseUrl).toString();
  } catch {
    return '';
  }
}

function uniqueUrls(urls = []) {
  const seen = new Set();
  return urls.filter((url) => {
    const normalized = String(url || '').trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function cameraImageCandidates(camera = {}) {
  return uniqueUrls([
    camera.imageUrl,
    ...(Array.isArray(camera.imageUrls) ? camera.imageUrls : []),
    isDirectImageUrl(camera.url) ? camera.url : '',
  ]);
}

function cameraSearchText(value = '') {
  return normalizeAscii(String(value || '')
    .replace(/\\\//g, '/')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' '))
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cameraMatchTexts(camera = {}) {
  return uniqueUrls([
    camera.matchText,
    ...(Array.isArray(camera.matchTexts) ? camera.matchTexts : []),
  ]).map(cameraSearchText).filter(Boolean);
}

function extractImageRecordsFromCameraPage(html = '', baseUrl = '') {
  const source = String(html || '');
  const records = [];
  const addRecord = (rawUrl, index) => {
    const url = absoluteUrl(rawUrl, baseUrl);
    if (!/^https?:\/\//i.test(url)) return;
    records.push({
      url,
      context: source.slice(Math.max(0, index - 2200), Math.min(source.length, index + 2200)),
    });
  };

  const attrRegex = /(?:src|href|data-src|data-original|data-lazy-src|data-full|poster)=['"]([^'"]+\.(?:jpe?g|png|webp)(?:\?[^'"]*)?)['"]/gi;
  let match;
  while ((match = attrRegex.exec(source))) addRecord(match[1], match.index);

  // HAK/BIHAMK pages can emit image URLs inside script JSON instead of <img src>.
  const looseRegex = /(https?:\/\/[^\s'"<>\)]+\.(?:jpe?g|png|webp)(?:\?[^\s'"<>\)]*)?|\/[^\s'"<>\)]+\.(?:jpe?g|png|webp)(?:\?[^\s'"<>\)]*)?)/gi;
  while ((match = looseRegex.exec(source))) addRecord(match[1], match.index);

  const byUrl = new Map();
  for (const record of records) {
    if (!byUrl.has(record.url)) byUrl.set(record.url, record);
    else byUrl.get(record.url).context += ` ${record.context}`;
  }
  return [...byUrl.values()];
}

function scoreCameraImageRecord(record = {}, camera = {}, fallbackIndex = 0) {
  const url = String(record.url || '');
  if (!url || /logo|favicon|spinner|loader|blank|placeholder|sprite|icon/i.test(url)) return -10000;

  const haystack = cameraSearchText(`${record.context || ''} ${url}`);
  const terms = cameraMatchTexts(camera);
  let score = 100 - fallbackIndex;

  for (const term of terms) {
    if (!term) continue;
    if (haystack.includes(term)) {
      score += 500 + Math.min(160, term.length * 3);
      continue;
    }
    const words = term.split(' ').filter((word) => word.length >= 3);
    const hits = words.filter((word) => haystack.includes(word)).length;
    if (words.length && hits === words.length) score += 220 + hits * 20;
    else if (hits >= Math.max(1, Math.ceil(words.length * 0.6))) score += 70 + hits * 12;
  }

  const source = cameraSearchText(camera.source || '');
  if (source.includes('bihamk') && /bihamk|video-nadzor/i.test(url)) score += 80;
  if (source.includes('hak') && /hak\.hr/i.test(url)) score += 80;
  if (source.includes('ams') && /ams|satwork/i.test(url)) score += 80;
  return score;
}

function extractImageUrlsFromCameraPage(html = '', baseUrl = '', camera = {}) {
  const records = extractImageRecordsFromCameraPage(html, baseUrl)
    .map((record, index) => ({ ...record, score: scoreCameraImageRecord(record, camera, index), index }))
    .filter((record) => record.score > -10000);

  const hasMatcher = cameraMatchTexts(camera).length > 0;
  if (hasMatcher) {
    const matched = records
      .filter((record) => record.score >= 180)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((record) => record.url);
    if (matched.length) return uniqueUrls(matched);
  }

  return uniqueUrls(records
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((record) => record.url));
}

async function resolveCameraImageUrl(camera = {}) {
  const directCandidates = cameraImageCandidates(camera);
  if (directCandidates.length) return directCandidates[0];
  if (!camera.url) return '';

  const cacheKey = `${camera.id || ''}:${camera.url}:${cameraMatchTexts(camera).join('|')}:${camera.imageIndex || 0}`;
  const cached = resolvedCameraImageCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CAMERA_IMAGE_PAGE_CACHE_MS) return cached.url;

  const html = await fetchTextWithTimeout(camera.url);
  const extracted = extractImageUrlsFromCameraPage(html, camera.url, camera);
  const index = Math.max(0, Number(camera.imageIndex || 0) || 0);
  const resolved = extracted[index] || extracted[0] || '';
  if (!resolved) throw new Error(`Nije pronađen direktni image URL na stranici kamere: ${camera.url}`);
  // Bounded (values are small resolved-URL strings, never raw image bytes). Evict the oldest entry
  // past the cap so the cache can't grow unbounded as more cameras are added.
  if (resolvedCameraImageCache.size >= 500) {
    const oldestKey = resolvedCameraImageCache.keys().next().value;
    if (oldestKey !== undefined) resolvedCameraImageCache.delete(oldestKey);
  }
  resolvedCameraImageCache.set(cacheKey, { url: resolved, createdAt: Date.now() });
  return resolved;
}

async function fetchCameraImage(camera = {}, options = {}) {
  const candidates = uniqueUrls([
    ...cameraImageCandidates(camera),
    await resolveCameraImageUrl(camera).catch(() => ''),
  ]);
  let lastError = null;
  for (const url of candidates) {
    try {
      // On a forced snapshot, append a cache-buster so a CDN/origin can't hand back a stale frame
      // (the no-cache header alone is not always honoured by the camera hosts).
      const fetchUrl = options.forceSnapshot ? `${url}${url.includes('?') ? '&' : '?'}_cb=${Date.now()}` : url;
      const image = await fetchBinaryWithTimeout(fetchUrl, options);
      if (String(image.contentType || '').startsWith('image/')) return { ...image, url };
      lastError = new Error(`${url} nije vratio sliku (${image.contentType || 'bez Content-Type'})`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Nema dostupnog image URL-a za kameru.');
}

function percentToRect(roi = {}, width = 0, height = 0) {
  const x = Math.max(0, Math.min(width - 1, Math.round((Number(roi.x ?? 0) / 100) * width)));
  const y = Math.max(0, Math.min(height - 1, Math.round((Number(roi.y ?? 0) / 100) * height)));
  const w = Math.max(8, Math.min(width - x, Math.round((Number(roi.w ?? 100) / 100) * width)));
  const h = Math.max(8, Math.min(height - y, Math.round((Number(roi.h ?? 100) / 100) * height)));
  return { x, y, w, h };
}

function pixelGray(image, x, y) {
  const idx = (y * image.width + x) * 4;
  const r = image.data[idx] || 0;
  const g = image.data[idx + 1] || 0;
  const b = image.data[idx + 2] || 0;
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

function snapshotComponentType(component, cellW, cellH) {
  const widthPx = Math.max(1, (component.maxX - component.minX + 1) * cellW);
  const heightPx = Math.max(1, (component.maxY - component.minY + 1) * cellH);
  const aspect = widthPx / heightPx;
  if (component.cells >= 18 && aspect > 1.45) return 'truck';
  if (component.cells >= 15 && aspect <= 1.45) return 'bus';
  if (component.cells >= 9) return 'van';
  return 'car';
}

function decodeJpegImage(buffer) {
  try {
    return jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 64 });
  } catch (error) {
    throw new Error(`JPEG decode nije uspio: ${error.message}`);
  }
}

// HAK serves a fixed "nepostojeća kamera / invalid webcam" placeholder for unknown camera
// ids: info/kamere/{id}.jpg returns a ~22.8 kB PNG, and m.hak.hr/cam.asp returns a GIF.
// Real camera stills are always JPEG and comfortably larger than a few kB. Anything that is
// not a sane-sized JPEG (PNG/GIF placeholder, HTML error page, empty/broken payload) must be
// treated as "camera unavailable" so it is never decoded or analyzed as a real frame.
const MIN_VALID_JPEG_BYTES = Math.max(800, Number(process.env.CAMERA_MIN_JPEG_BYTES || 3000));
function isUsableCameraImage(buffer, contentType = '') {
  if (!buffer || buffer.length < MIN_VALID_JPEG_BYTES) return false;
  // JPEG magic bytes FF D8 FF — rejects PNG (89 50 4E 47) and GIF (47 49 46) placeholders.
  const isJpegMagic = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (!isJpegMagic) return false;
  const ct = String(contentType || '').toLowerCase();
  if (ct && !ct.includes('jpeg') && !ct.includes('jpg')) return false;
  return true;
}


function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

// Camera flow → wait estimator (V5 P0 — no false camera wait).
//
// `visibleVehicles` = REAL typed vehicle detections (connected components classified as
// vehicles). `queueVehicles`/`visibleTotal` = the area-corroborated estimate. The decisive
// fix: occupancy/area is NOT evidence of a queue on its own — dark frames, shadows, foliage
// and structures fill cells too. We only trust the area-inflated queue when real detections
// corroborate it, and we HARD-CAP the wait by the qualitative band so the camera can never
// fabricate 20–60 min with no visible cars (the Svilaj/Maljevac trust bug).
function estimateCameraFlowFromSnapshot({ visibleTotal = 0, visibleVehicles = null, queueVehicles: queueParam = null, occupancyPct = 0, laneFullnessPct = 0, componentDensity = 0, direction = 'toBih', previousSnapshot = null } = {}) {
  const queueAreaEstimate = Math.max(0, Math.round(Number(queueParam ?? visibleTotal ?? 0)));
  const realVehicles = Math.max(0, Math.round(Number(visibleVehicles ?? visibleTotal ?? queueAreaEstimate)));
  const fullness = Math.max(Number(occupancyPct || 0), Number(laneFullnessPct || 0));

  // Trust the area-inflated queue (which fixes bumper-to-bumper undercount) only when real
  // detections back it; otherwise the queue is the typed detection count. ≤2 real vehicles
  // means "no queue" no matter how occupied the frame looks.
  const queueVehicles = realVehicles <= 2 ? realVehicles : Math.min(queueAreaEstimate, Math.max(realVehicles, realVehicles * 3));

  // Qualitative band — escalates only when BOTH real detections AND area fullness agree.
  let queueBand;
  if (realVehicles <= 2 && fullness < 14) queueBand = 'nema';
  else if (realVehicles <= 5 && fullness < 30) queueBand = 'mala';
  else if (realVehicles <= 12 && fullness < 55) queueBand = 'srednja';
  else if (realVehicles <= 22 || fullness < 78) queueBand = 'velika';
  else queueBand = 'ekstremna';
  // Vehicle-evidence cap (mirrors classifyQueueBand): the band can never exceed what is actually
  // SEEN. A handful of visible cars on an open road must not read "velika/ekstremna kolona" just
  // because the lane-fullness pixels are noisy or the queue was ×3-inflated for the wait math.
  const QB_ORDER = ['nema', 'mala', 'srednja', 'velika', 'ekstremna'];
  const evCap = realVehicles <= 2 ? 'mala' : realVehicles <= 5 ? 'srednja' : realVehicles <= 10 ? 'velika' : 'ekstremna';
  if (QB_ORDER.indexOf(queueBand) > QB_ORDER.indexOf(evCap)) queueBand = evCap;
  // Hard ceiling: a camera wait may never exceed what its visual evidence supports.
  const evidenceCap = queueBand === 'nema' ? 6 : queueBand === 'mala' ? 14 : queueBand === 'srednja' ? 35 : queueBand === 'velika' ? 75 : 240;

  const occupancyLoad = clampNumber(fullness / 45, 0, 1.6);
  const densityLoad = clampNumber(Number(componentDensity || 0) / 2.2, 0, 1.4);
  const queueLoad = clampNumber(Math.max(0, queueVehicles - 10) / 18, 0, 1.5);
  let flowVehicles15 = 19 - occupancyLoad * 5.5 - densityLoad * 2.5 - queueLoad * 4;
  if (queueVehicles <= 2) flowVehicles15 += 3;
  if (direction === 'toHr') flowVehicles15 -= 1;

  let queueTrend = 'unknown';
  let trendDelta = 0;
  const previousQueue = previousSnapshot ? Number(previousSnapshot.queueVehicles ?? previousSnapshot.visibleTotal ?? NaN) : NaN;
  if (Number.isFinite(previousQueue)) {
    trendDelta = queueVehicles - previousQueue;
    if (trendDelta >= 4) {
      queueTrend = 'rising';
      flowVehicles15 -= Math.min(5, trendDelta * 0.7);
    } else if (trendDelta <= -4) {
      queueTrend = 'falling';
      flowVehicles15 += Math.min(4, Math.abs(trendDelta) * 0.45);
    } else {
      queueTrend = 'steady';
    }
  }

  flowVehicles15 = Math.max(4, Math.min(26, Math.round(flowVehicles15)));
  const servicePerMinute = Math.max(0.25, flowVehicles15 / 15);
  // Wait is derived from QUEUE LENGTH, not from low throughput. Low flow on an empty road
  // means nobody is crossing, not that there is a 20-min queue.
  let wait = queueVehicles <= 0 ? 0 : Math.round(queueVehicles / servicePerMinute + (queueVehicles <= 2 ? 1 : 2));
  // Occupancy floor for bumper-to-bumper undercount — but ONLY when ≥4 REAL vehicles
  // corroborate the full band (never from raw occupied area / shadows alone).
  if (fullness >= 45 && realVehicles >= 4) {
    const occupancyFloor = Math.round(clampNumber((fullness - 38) * 0.7, 0, 42));
    wait = Math.max(wait, occupancyFloor);
  }
  // Diagnostics: the wait BEFORE the evidence ceiling, and whether the ceiling fired.
  const preGuardWait = clampWait(wait);
  // Apply the evidence ceiling LAST — the negative-evidence veto.
  wait = Math.min(wait, evidenceCap);
  const guardApplied = preGuardWait !== null && clampWait(wait) !== preGuardWait;
  // How much REAL evidence supports a queue (0-1). Penalised when area fullness is high but
  // few vehicles are actually detected (the dark-frame / shadow false-positive signature).
  let queueEvidenceScore;
  if (realVehicles <= 2) queueEvidenceScore = clampNumber(realVehicles / 10, 0, 0.2);
  else queueEvidenceScore = clampNumber(0.3 + Math.min(realVehicles, 20) / 20 * 0.7, 0, 1);
  if (fullness >= 45 && realVehicles < 4) queueEvidenceScore = Math.min(queueEvidenceScore, 0.2);
  queueEvidenceScore = Math.round(queueEvidenceScore * 100) / 100;

  let confidence = Math.round(54 + Math.min(16, realVehicles * 1.4) - Math.max(0, fullness - 40) * 0.3 + (queueTrend === 'unknown' ? -4 : 4));
  if (queueBand === 'nema' || queueBand === 'mala') confidence = Math.min(confidence, 52);
  if (realVehicles <= 2) confidence = Math.min(confidence, 48);
  confidence = Math.max(38, Math.min(86, confidence));

  return {
    queueVehicles,
    visibleVehicles: realVehicles,
    queueBand,
    evidenceCap,
    preGuardWait,
    guardApplied,
    queueEvidenceScore,
    flowVehicles15,
    throughputPerHour: Math.max(8, flowVehicles15 * 4),
    wait: clampWait(wait),
    queueTrend,
    trendDelta,
    confidence,
    method: previousSnapshot ? 'snapshot-flow-v3' : 'snapshot-flow-v3-single-frame',
  };
}

function analyzeSnapshotImage(image, camera, direction, previousSnapshot = null, yoloResult = null) {
  const roi = camera.calibration?.roi || { x: 8, y: 12, w: 84, h: 76 };
  const rect = percentToRect(roi, image.width, image.height);
  const gridX = 24;
  const gridY = 16;
  const cellW = Math.max(1, Math.floor(rect.w / gridX));
  const cellH = Math.max(1, Math.floor(rect.h / gridY));
  const darkValues = [];
  const edgeValues = [];
  const cells = [];

  for (let gy = 0; gy < gridY; gy += 1) {
    for (let gx = 0; gx < gridX; gx += 1) {
      const startX = rect.x + gx * cellW;
      const startY = rect.y + gy * cellH;
      let dark = 0;
      let edge = 0;
      let samples = 0;
      for (let py = startY; py < Math.min(rect.y + rect.h - 1, startY + cellH); py += Math.max(1, Math.floor(cellH / 3))) {
        for (let px = startX; px < Math.min(rect.x + rect.w - 1, startX + cellW); px += Math.max(1, Math.floor(cellW / 3))) {
          const gray = pixelGray(image, px, py);
          const gxGrad = Math.abs(gray - pixelGray(image, Math.min(image.width - 1, px + 1), py));
          const gyGrad = Math.abs(gray - pixelGray(image, px, Math.min(image.height - 1, py + 1)));
          if (gray < 132) dark += 1;
          edge += gxGrad + gyGrad;
          samples += 1;
        }
      }
      const darkRatio = samples ? dark / samples : 0;
      const edgeScore = samples ? edge / samples : 0;
      darkValues.push(darkRatio);
      edgeValues.push(edgeScore);
      cells.push({ gx, gy, darkRatio, edgeScore, occupied: false });
    }
  }

  const sortedEdges = [...edgeValues].sort((a, b) => a - b);
  const medianEdge = sortedEdges[Math.floor(sortedEdges.length / 2)] || 0;
  const edgeThreshold = Math.max(15, medianEdge * 1.35);
  const darkThreshold = 0.23;

  cells.forEach((cell) => {
    // Include the foreground row (gy 15) and one more distant row (gy 2): the
    // largest, most reliable queue vehicles sit in the foreground, and queues
    // recede toward the top, so the old gy 3..14 band clipped both ends.
    const roadBandBoost = cell.gy >= 2 && cell.gy <= 15;
    cell.occupied = roadBandBoost && ((cell.edgeScore >= edgeThreshold && cell.darkRatio >= 0.10) || cell.darkRatio >= darkThreshold);
  });

  const cellMap = new Map(cells.map((cell) => [`${cell.gx}:${cell.gy}`, cell]));
  const visited = new Set();
  const components = [];
  const neighbors = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]];

  for (const cell of cells) {
    const startKey = `${cell.gx}:${cell.gy}`;
    if (!cell.occupied || visited.has(startKey)) continue;
    const stack = [cell];
    visited.add(startKey);
    const component = { cells: 0, minX: cell.gx, maxX: cell.gx, minY: cell.gy, maxY: cell.gy, edge: 0, dark: 0 };
    while (stack.length) {
      const current = stack.pop();
      component.cells += 1;
      component.minX = Math.min(component.minX, current.gx);
      component.maxX = Math.max(component.maxX, current.gx);
      component.minY = Math.min(component.minY, current.gy);
      component.maxY = Math.max(component.maxY, current.gy);
      component.edge += current.edgeScore;
      component.dark += current.darkRatio;
      for (const [dx, dy] of neighbors) {
        const key = `${current.gx + dx}:${current.gy + dy}`;
        const next = cellMap.get(key);
        if (!next || !next.occupied || visited.has(key)) continue;
        visited.add(key);
        stack.push(next);
      }
    }
    if (component.cells >= 2) components.push(component);
  }

  const usefulComponents = components
    .filter((component) => component.cells >= 2 && component.maxY >= 3)
    .sort((a, b) => b.cells - a.cells)
    .slice(0, 28);
  const counts = { cars: 0, vans: 0, trucks: 0, buses: 0 };
  usefulComponents.forEach((component) => {
    const type = snapshotComponentType(component, rect.w / gridX, rect.h / gridY);
    if (type === 'truck') counts.trucks += 1;
    else if (type === 'bus') counts.buses += 1;
    else if (type === 'van') counts.vans += 1;
    else counts.cars += 1;
  });

  const calibrationBase = normalizeCounts(camera.calibration?.baselineFrame || {});
  const rawTotal = totalCounts(counts);
  const baselineTotal = totalCounts(calibrationBase);
  const hasSignal = rawTotal > 0;
  const blendedCounts = hasSignal ? {
    cars: Math.max(0, Math.round(counts.cars * 0.86 + calibrationBase.cars * 0.14)),
    vans: Math.max(0, Math.round(counts.vans * 0.86 + calibrationBase.vans * 0.14)),
    trucks: Math.max(0, Math.round(counts.trucks * 0.82 + calibrationBase.trucks * 0.18)),
    buses: Math.max(0, Math.round(counts.buses * 0.82 + calibrationBase.buses * 0.18)),
  } : calibrationBase;
  const visibleTotal = totalCounts(blendedCounts);
  const occupiedCells = cells.filter((cell) => cell.occupied).length;
  const occupancyPct = Math.round((occupiedCells / Math.max(cells.length, 1)) * 100);
  // Lane fullness: a single bumper-to-bumper lane leaves the rest of the frame
  // (the other lane, grass, booths) empty, so whole-frame occupancy understates
  // it. Measure the fullest column third within the road band as the queue-lane
  // signal — this is what lets a one-lane queue trigger the wait floor even when
  // the camera has no per-lane ROI calibration.
  const bandRows = cells.filter((cell) => cell.gy >= 2 && cell.gy <= 15);
  let laneFullnessPct = 0;
  for (let third = 0; third < 3; third += 1) {
    const lo = Math.floor((third * gridX) / 3);
    const hi = Math.floor(((third + 1) * gridX) / 3);
    const bandThird = bandRows.filter((cell) => cell.gx >= lo && cell.gx < hi);
    if (!bandThird.length) continue;
    const occ = bandThird.filter((cell) => cell.occupied).length / bandThird.length;
    laneFullnessPct = Math.max(laneFullnessPct, Math.round(occ * 100));
  }
  const componentDensity = usefulComponents.length / Math.max(1, gridX * gridY / 32);
  // Bumper-to-bumper cars merge into a few connected components, so the typed
  // count (visibleTotal) under-reports a packed queue — a frame with ~9 queued
  // cars was counting only 4. Cross-check with an area estimate from the
  // occupied lane cells (~11 grid cells per vehicle for these ~768x576 frames)
  // and take the larger, so a full lane is never counted as just a couple of
  // cars. Conservative divisor + cap keep empty/striped asphalt from inflating.
  const areaQueue = Math.round(occupiedCells / 11);
  const queueEstimate = Math.min(40, Math.max(visibleTotal, Math.round(areaQueue * 0.85)));
  const confidence = Math.max(
    CAMERA_SNAPSHOT_MIN_CONFIDENCE,
    Math.min(88, Math.round(48 + Math.min(22, usefulComponents.length * 2.2) + Math.min(14, occupancyPct * 0.45) + (hasSignal ? 6 : -6)))
  );

  const laneProfile = buildLaneGroups(blendedCounts, Math.max(1, Math.round(visibleTotal * 0.75)), Math.max(5, Math.round(visibleTotal * 5.8)), confidence, camera.calibration, direction);
  const detections = usefulComponents.slice(0, 18).map((component, index) => {
    const type = snapshotComponentType(component, rect.w / gridX, rect.h / gridY);
    const centerX = rect.x + ((component.minX + component.maxX + 1) / 2) * (rect.w / gridX);
    const centerY = rect.y + ((component.minY + component.maxY + 1) / 2) * (rect.h / gridY);
    const boxW = Math.max(4, (component.maxX - component.minX + 1) * (rect.w / gridX));
    const boxH = Math.max(4, (component.maxY - component.minY + 1) * (rect.h / gridY));
    return {
      id: `${camera.id}-snap-${index}`,
      type,
      label: type === 'truck' ? 'kamion' : type === 'van' ? 'kombi' : type === 'bus' ? 'bus' : 'auto',
      trackId: `S${index + 1}`,
      confidence: Math.max(58, Math.min(92, Math.round(confidence + Math.min(8, component.cells / 2)))),
      crossed: component.maxY < gridY * 0.56,
      x: Math.round((centerX / image.width) * 1000) / 10,
      y: Math.round((centerY / image.height) * 1000) / 10,
      w: Math.round((boxW / image.width) * 1000) / 10,
      h: Math.round((boxH / image.height) * 1000) / 10,
    };
  });

  // Pass REAL typed detections (visibleTotal) AND the area-corroborated estimate
  // (queueEstimate) separately so the flow estimator can veto occupancy-only false waits.
  // ── YOLO + ROI override (V5 §6) ──────────────────────────────────────────
  // When YOLO detections are available, the REAL vehicle evidence comes from boxes filtered
  // by the queue ROI / ignore zones — not the connected-components heuristic. Occupancy/lane
  // fullness stay (secondary), but the evidence-cap now keys off the YOLO in-ROI count, so a
  // shadow-filled frame with zero detected vehicles can never fabricate a wait. Everything
  // downstream (evidence cap, direction/ROI gate, confidence calibration) is unchanged.
  const yolo = (yoloResult && Array.isArray(yoloResult.detections))
    ? applyRoiToDetections(yoloResult.detections, camera.calibration || {}, { minConfidence: YOLO_MIN_CONFIDENCE })
    : null;
  // ── YOLO ROI v2 (polygon queue/ignore) ──────────────────────────────────────────────────────
  // Classify the RAW YOLO detections against the per-camera polygon ROI (explicit config, or one
  // derived from the legacy rect calibration). When calibrated, the QUEUE count comes from vehicles
  // inside the queue polygon (parking / opposite side / off-lane are excluded). Never throws.
  let roiFeaturesV2 = null;
  if (YOLO_ROI_V2_ENABLED && yoloResult && Array.isArray(yoloResult.detections)) {
    try {
      const explicit = YOLO_ROI_CONFIG_ENABLED ? getRoiConfig(camera.id) : null;
      const v2cfg = (explicit && explicit.isActive !== false) ? explicit : rectCalibrationToRoiConfig(camera, camera.crossingId, direction);
      roiFeaturesV2 = computeRoiCameraFeatures(yoloResult.detections, (v2cfg && v2cfg.isActive !== false) ? v2cfg : null, {
        width: image.width, height: image.height, coordSpace: 'percent', isNightOrLowLight: false, qualityScore: null,
      });
    } catch (error) {
      roiFeaturesV2 = { roiCalibrated: false, fallbackReason: `ROI_V2_ERROR:${String(error.message).slice(0, 60)}` };
    }
  }
  const roiCalibratedV2 = Boolean(roiFeaturesV2 && roiFeaturesV2.roiCalibrated);
  // When the v2 polygon ROI is calibrated it is the source of truth for visible/queue counts.
  const effVisible = roiCalibratedV2 ? roiFeaturesV2.visibleVehicleCount : (yolo ? yolo.visibleVehicles : visibleTotal);
  const effQueue = roiCalibratedV2 ? roiFeaturesV2.vehiclesInQueueRoi : (yolo ? yolo.queueVehicles : queueEstimate);
  const effCounts = yolo ? yolo.counts : blendedCounts;

  const flowEstimate = estimateCameraFlowFromSnapshot({ visibleVehicles: effVisible, queueVehicles: effQueue, occupancyPct, laneFullnessPct, componentDensity, direction, previousSnapshot });
  const cameraWait = flowEstimate.wait;
  const blendedConfidence = Math.max(CAMERA_SNAPSHOT_MIN_CONFIDENCE, Math.min(90, Math.round(confidence * 0.62 + flowEstimate.confidence * 0.38)));

  return {
    counts: effCounts,
    rawCounts: counts,
    visibleTotal: effVisible,
    visibleVehicles: flowEstimate.visibleVehicles,
    queueVehicles: flowEstimate.queueVehicles,
    queueBand: flowEstimate.queueBand,
    evidenceCap: flowEstimate.evidenceCap,
    preGuardWait: flowEstimate.preGuardWait,
    guardApplied: flowEstimate.guardApplied,
    queueEvidenceScore: flowEstimate.queueEvidenceScore,
    passed15: flowEstimate.flowVehicles15,
    flowVehicles15: flowEstimate.flowVehicles15,
    throughputPerHour: flowEstimate.throughputPerHour,
    wait: cameraWait,
    waitRangeMin: Math.max(0, cameraWait - (flowEstimate.queueTrend === 'unknown' ? 7 : 5)),
    waitRangeMax: Math.min(360, cameraWait + (flowEstimate.queueTrend === 'rising' ? 12 : 8)),
    queueTrend: flowEstimate.queueTrend,
    trendDelta: flowEstimate.trendDelta,
    confidence: blendedConfidence,
    detections: yolo ? yolo.inRoi : detections,
    laneGroups: laneProfile,
    roi: camera.calibration?.roi || roi,
    width: image.width,
    height: image.height,
    occupancyPct,
    laneFullnessPct,
    componentCount: usefulComponents.length,
    componentDensity: Math.round(componentDensity * 100) / 100,
    // YOLO + ROI diagnostics (null when running the heuristic).
    yoloUsed: Boolean(yolo),
    detectionsBeforeRoi: yolo ? yolo.detectionsBeforeRoi : null,
    detectionsAfterRoi: yolo ? yolo.detectionsAfterRoi : null,
    ignoredDetections: yolo ? yolo.ignored.map((d) => ({ type: d.type, x: d.x, y: d.y, reason: d.reason })) : null,
    passedVehicles: yolo ? yolo.passedVehicles : null,
    countLineCrossings: yolo ? yolo.countLineCrossings : null,
    // ROI v2 polygon features (visible/queue/ignored/outside, roiCalibrated, roiVersion, …) — the
    // rich object surfaced into sourceBreakdown.yoloCamera. null when ROI v2 is off / no detections.
    roiFeatures: roiFeaturesV2,
    method: roiCalibratedV2 ? `yolo-roi-v2${flowEstimate.method.includes('single') ? '-single-frame' : ''}` : (yolo ? `yolo-roi${flowEstimate.method.includes('single') ? '-single-frame' : ''}` : flowEstimate.method),
  };
}

async function runSnapshotCounter(camera, crossingId, direction, previousSnapshot = null, options = {}) {
  if (!CAMERA_SNAPSHOT_COUNTING_ENABLED) return null;
  const { buffer, contentType, url: resolvedImageUrl } = await fetchCameraImage(camera, { forceSnapshot: Boolean(options.forceSnapshot) });

  // Some public camera endpoints occasionally return HTML, an empty payload, a HAK
  // "invalid webcam" PNG/GIF placeholder, or a protected/redirect response. We skip
  // those snapshots (returning null = "camera unavailable") and let calibrated/admin/
  // BIHAMK sources drive the wait estimate, instead of analyzing a placeholder as a real frame.
  if (!isUsableCameraImage(buffer, contentType)) return null;

  const image = decodeJpegImage(buffer);
  // YOLO (when enabled) replaces the heuristic vehicle detection; on any failure it returns
  // null and analyzeSnapshotImage falls back to the connected-components heuristic. In SHADOW
  // mode YOLO runs but is NOT applied to the wait — its ROI result is attached for comparison.
  const yoloResult = await runYoloDetector(camera, crossingId, direction, buffer, contentType).catch(() => ({ detections: null, fallbackReason: 'error', durationMs: 0, count: 0 }));
  const yoloForWait = YOLO_ENABLED ? yoloResult : null;
  const analysis = analyzeSnapshotImage(image, camera, direction, previousSnapshot, yoloForWait);
  // CV/YOLO diagnostics (surfaced in the camera payload so the UI/debug can show whether the real
  // detector or the heuristic was used, and WHY it fell back).
  analysis.cvEnabled = CAMERA_CV_ENABLED || YOLO_ENABLED || YOLO_SHADOW_MODE;
  analysis.cvUsed = Boolean(analysis.yoloUsed);
  analysis.cvSource = analysis.yoloUsed ? 'cv-detector' : 'heuristic';
  analysis.cvFallbackReason = analysis.yoloUsed ? null : (yoloResult?.fallbackReason || (YOLO_ENABLED ? 'no-detections' : 'disabled'));
  analysis.cvDurationMs = Number(yoloResult?.durationMs || 0);
  analysis.cvDetectionsCount = Number(yoloResult?.count || (Array.isArray(yoloResult?.detections) ? yoloResult.detections.length : 0));

  // ── MULTI-FRAME stopped-vs-moving (§4) — flag-gated, timeout-bounded, single-frame fallback ──
  analysis.multiFrame = { multiFrameUsed: false, multiFrameFallbackReason: CAMERA_YOLO_MULTI_FRAME_ENABLED ? null : 'DISABLED' };
  if (CAMERA_YOLO_MULTI_FRAME_ENABLED && Array.isArray(yoloResult?.detections)) {
    const startedMf = Date.now();
    try {
      const explicitMf = YOLO_ROI_CONFIG_ENABLED ? getRoiConfig(camera.id) : null;
      const roiCfgMf = (explicitMf && explicitMf.isActive !== false) ? explicitMf : rectCalibrationToRoiConfig(camera, crossingId, direction);
      const imageMeta = { width: image.width, height: image.height, coordSpace: 'percent' };
      const frames = [yoloResult.detections];
      const frameHashes = [crypto.createHash('sha1').update(buffer).digest('hex')];
      const deadline = startedMf + CAMERA_YOLO_MULTI_FRAME_TIMEOUT_MS;
      for (let i = 1; i < CAMERA_YOLO_FRAME_COUNT && Date.now() < deadline; i += 1) {
        await new Promise((r) => setTimeout(r, CAMERA_YOLO_FRAME_GAP_MS));
        if (Date.now() >= deadline) break;
        const extra = await fetchCameraImage(camera, { forceSnapshot: true }).catch(() => null);
        if (!extra || !isUsableCameraImage(extra.buffer, extra.contentType)) continue;
        const extraHash = crypto.createHash('sha1').update(extra.buffer).digest('hex');
        frameHashes.push(extraHash);
        const yr = await runYoloDetector(camera, crossingId, direction, extra.buffer, extra.contentType).catch(() => null);
        if (yr && Array.isArray(yr.detections)) frames.push(yr.detections);
      }
      analysis.multiFrame = frames.length >= 2
        ? trackStoppedMoving(frames, { roiConfig: roiCfgMf, imageMeta, frameHashes })
        : { multiFrameUsed: true, multiFrameFrameCount: frames.length, stoppedVehicleRatio: null, movingVehicleRatio: null, multiFrameFallbackReason: 'INSUFFICIENT_FRAMES' };
      // STABILITY: a single noisy frame (a missed or extra car) must not swing the estimate. Take the
      // MEDIAN in-queue-ROI vehicle count across the captured frames and use that as the effective
      // count (fed to the band + calibrated wait). Robust to outliers; falls back to the single frame
      // when only one usable frame exists.
      if (frames.length >= 2) {
        const perFrame = frames
          .map((f) => computeRoiCameraFeatures(f, roiCfgMf, imageMeta)?.vehiclesInQueueRoi)
          .filter((n) => Number.isFinite(Number(n)))
          .map(Number);
        if (perFrame.length >= 2) {
          const sorted = [...perFrame].sort((a, b) => a - b);
          analysis.multiFrame.frameQueueCounts = perFrame;
          analysis.multiFrame.medianVehiclesInQueueRoi = sorted[Math.floor((sorted.length - 1) / 2)];
        }
      }
      analysis.multiFrame.multiFrameDurationMs = Date.now() - startedMf;
    } catch (error) {
      analysis.multiFrame = { multiFrameUsed: false, multiFrameFallbackReason: `ERROR:${String(error.message).slice(0, 50)}`, multiFrameDurationMs: Date.now() - startedMf };
    }
  }

  if (!YOLO_ENABLED && YOLO_SHADOW_MODE && Array.isArray(yoloResult?.detections)) {
    const shadow = applyRoiToDetections(yoloResult.detections, camera.calibration || {}, { minConfidence: YOLO_MIN_CONFIDENCE });
    // Compute the v6 wait estimate from the YOLO signals (shadow only — never used for the
    // displayed wait) so the admin can compare it against the legacy heuristic + official.
    const shadowWait = estimateWaitFromCameraSignals({
      queueVehicles: shadow.hasRoi ? shadow.queueVehicles : null,
      flowVehiclesPerMinute: null, // single-frame YOLO has no flow yet (needs frame history)
      calibrationProfile: camera.calibrationProfile || null,
      hasRoi: shadow.hasRoi,
      hasDirection: cameraContributionMode(camera, direction) === 'hard',
      hasCountLine: Boolean(camera.countLine || camera.calibration?.countLine),
    });
    analysis.yoloShadow = {
      queueVehicles: shadow.queueVehicles,
      visibleVehicles: shadow.visibleVehicles,
      detectionsBeforeRoi: shadow.detectionsBeforeRoi,
      detectionsAfterRoi: shadow.detectionsAfterRoi,
      counts: shadow.counts,
      waitEstimateMinutes: shadowWait.waitMinutes,
      waitRange: shadowWait.waitRange,
      reasonCodes: shadowWait.reasonCodes,
    };
  }

  // Multi-frame stale detection via average-hash. A frozen feed or cached placeholder
  // serves the same pixels repeatedly; we compare this frame's hash to the previous
  // one and keep a streak counter. ≥3 consecutive near-identical frames = stale, which
  // suppresses any aggressive wait this camera would otherwise drive (spec §1).
  const imageHash = computeAverageHash((x, y) => pixelGray(image, x, y), image.width, image.height);
  const prevHash = previousSnapshot?.metadata?.imageHash || null;
  const prevStreak = Number(previousSnapshot?.metadata?.staleStreak || 0);
  const frameInfo = detectStaleFrames([imageHash, ...(prevHash ? [prevHash] : [])], { minRepeats: 2, threshold: 2 });
  const staleStreak = (prevHash && frameInfo.repeats >= 2) ? prevStreak + 1 : 0;
  const stale = staleStreak >= 2; // current frame + 2 prior identical = frozen feed
  const motion = frameInfo.motion;
  const contributesHardWait = cameraContributionMode(camera, direction) === 'hard';

  return {
    cameraId: camera.id,
    cameraLabel: camera.label,
    sourceName: camera.source || 'kamera',
    sourceUrl: resolvedImageUrl || camera.url,
    imageStatus: 'ok',
    ...analysis,
    stale,
    motion,
    visualOnly: !contributesHardWait,
    metadata: {
      flowVehicles15: analysis.flowVehicles15,
      passed15: analysis.passed15,
      queueTrend: analysis.queueTrend,
      trendDelta: analysis.trendDelta,
      waitRangeMin: analysis.waitRangeMin,
      waitRangeMax: analysis.waitRangeMax,
      imageHash,
      staleStreak,
      stale,
      motion,
      occupancyPct: analysis.occupancyPct,
      laneFullnessPct: analysis.laneFullnessPct,
    },
    fetchedAt: new Date().toISOString(),
  };
}

function normalizeCameraSnapshot(snapshot) {
  const fetchedAt = snapshot.fetchedAt || new Date().toISOString();
  const bucket = new Date(fetchedAt).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const counts = normalizeCounts(snapshot.counts || {});
  return {
    id: snapshot.id || `${bucket}:${snapshot.crossingId}:${snapshot.direction}:${snapshot.cameraId}`,
    crossingId: snapshot.crossingId,
    direction: snapshot.direction === 'toHr' ? 'toHr' : 'toBih',
    cameraId: snapshot.cameraId,
    cameraLabel: snapshot.cameraLabel || snapshot.label || snapshot.cameraId,
    sourceName: snapshot.sourceName || snapshot.source || 'kamera',
    sourceUrl: snapshot.sourceUrl || snapshot.url || '',
    imageStatus: snapshot.imageStatus || 'ok',
    width: Number(snapshot.width || 0) || null,
    height: Number(snapshot.height || 0) || null,
    roi: snapshot.roi || {},
    counts,
    visibleTotal: Math.max(0, Number(snapshot.visibleTotal ?? totalCounts(counts)) || 0),
    queueVehicles: Math.max(0, Number(snapshot.queueVehicles ?? snapshot.visibleTotal ?? totalCounts(counts)) || 0),
    throughputPerHour: Math.max(0, Number(snapshot.throughputPerHour || 0) || 0),
    passed15: Math.max(0, Number(snapshot.passed15 ?? snapshot.flowVehicles15 ?? snapshot.metadata?.passed15 ?? snapshot.metadata?.flowVehicles15 ?? 0) || 0),
    flowVehicles15: Math.max(0, Number(snapshot.flowVehicles15 ?? snapshot.passed15 ?? snapshot.metadata?.flowVehicles15 ?? snapshot.metadata?.passed15 ?? 0) || 0),
    queueTrend: snapshot.queueTrend || snapshot.metadata?.queueTrend || 'unknown',
    wait: clampWait(snapshot.wait),
    confidence: Math.max(0, Math.min(100, Math.round(Number(snapshot.confidence || 50)))) ,
    method: snapshot.method || 'snapshot-counter',
    metadata: { ...(snapshot.metadata || {}), passed15: snapshot.passed15 ?? snapshot.flowVehicles15 ?? snapshot.metadata?.passed15, flowVehicles15: snapshot.flowVehicles15 ?? snapshot.passed15 ?? snapshot.metadata?.flowVehicles15, queueTrend: snapshot.queueTrend || snapshot.metadata?.queueTrend },
    fetchedAt,
    createdAt: snapshot.createdAt || fetchedAt,
  };
}

async function insertCameraSnapshots(snapshots = []) {
  const rows = snapshots.map(normalizeCameraSnapshot).filter((item) => BORDER_CROSSINGS[item.crossingId] && isKnownCamera(item.crossingId, item.cameraId));
  if (!rows.length) return [];
  if (datastoreMode === 'postgres') {
    const pool = await getPgPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of rows) {
        await client.query(
          `INSERT INTO borderflow_camera_snapshots
             (id, crossing_id, direction, camera_id, camera_label, source_name, source_url, image_status, width, height, roi, counts, visible_total, queue_vehicles, throughput_per_hour, wait_minutes, confidence, method, metadata, fetched_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           ON CONFLICT (id) DO UPDATE SET counts=EXCLUDED.counts, visible_total=EXCLUDED.visible_total,
             queue_vehicles=EXCLUDED.queue_vehicles, throughput_per_hour=EXCLUDED.throughput_per_hour,
             wait_minutes=EXCLUDED.wait_minutes, confidence=EXCLUDED.confidence, method=EXCLUDED.method,
             metadata=EXCLUDED.metadata, fetched_at=EXCLUDED.fetched_at`,
          [item.id, item.crossingId, item.direction, item.cameraId, item.cameraLabel, item.sourceName, item.sourceUrl, item.imageStatus, item.width, item.height, item.roi, item.counts, item.visibleTotal, item.queueVehicles, item.throughputPerHour, item.wait, item.confidence, item.method, item.metadata, item.fetchedAt, item.createdAt]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } else {
    const byId = new Map(cameraSnapshotBuffer.map((item) => [item.id, item]));
    rows.forEach((item) => byId.set(item.id, item));
    cameraSnapshotBuffer.splice(0, cameraSnapshotBuffer.length, ...[...byId.values()].sort((a, b) => String(b.fetchedAt).localeCompare(String(a.fetchedAt))).slice(0, 5000));
  }
  return rows;
}

async function readLatestCameraSnapshots(crossingId, direction, hours = 3) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  if (datastoreMode === 'postgres') {
    const rows = await dbQuery(
      `SELECT DISTINCT ON (camera_id) * FROM borderflow_camera_snapshots
       WHERE crossing_id=$1 AND direction=$2 AND fetched_at >= $3
       ORDER BY camera_id, fetched_at DESC`,
      [crossingId, direction, since]
    );
    return rows.rows.map((row) => ({
      id: row.id,
      crossingId: row.crossing_id,
      direction: row.direction,
      cameraId: row.camera_id,
      cameraLabel: row.camera_label,
      sourceName: row.source_name,
      sourceUrl: row.source_url,
      imageStatus: row.image_status,
      width: row.width,
      height: row.height,
      roi: row.roi || {},
      counts: normalizeCounts(row.counts || {}),
      visibleTotal: Number(row.visible_total || 0),
      queueVehicles: Number(row.queue_vehicles || 0),
      throughputPerHour: Number(row.throughput_per_hour || 0),
      passed15: Number(row.metadata?.passed15 ?? row.metadata?.flowVehicles15 ?? 0) || 0,
      flowVehicles15: Number(row.metadata?.flowVehicles15 ?? row.metadata?.passed15 ?? 0) || 0,
      queueTrend: row.metadata?.queueTrend || 'unknown',
      wait: row.wait_minutes === null || row.wait_minutes === undefined ? null : Number(row.wait_minutes),
      confidence: Number(row.confidence || 0),
      method: row.method,
      metadata: row.metadata || {},
      fetchedAt: isoDate(row.fetched_at),
      createdAt: isoDate(row.created_at),
    }));
  }
  const seen = new Set();
  return cameraSnapshotBuffer
    .filter((item) => item.crossingId === crossingId && item.direction === direction && String(item.fetchedAt || '') >= since)
    .sort((a, b) => String(b.fetchedAt).localeCompare(String(a.fetchedAt)))
    .filter((item) => {
      if (seen.has(item.cameraId)) return false;
      seen.add(item.cameraId);
      return true;
    });
}

function aggregateCameraSnapshots(snapshots = []) {
  if (!snapshots.length) return null;
  const counts = snapshots.reduce((sum, item) => {
    const current = normalizeCounts(item.counts || {});
    sum.cars += current.cars;
    sum.vans += current.vans;
    sum.trucks += current.trucks;
    sum.buses += current.buses;
    return sum;
  }, { cars: 0, vans: 0, trucks: 0, buses: 0 });
  const visibleTotal = snapshots.reduce((sum, item) => sum + Number(item.visibleTotal || totalCounts(item.counts || {})), 0);
  const throughputPerHour = Math.max(0, Math.round(snapshots.reduce((sum, item) => sum + Number(item.throughputPerHour || 0), 0) / Math.max(1, snapshots.length)));
  const flowVehicles15 = Math.max(0, Math.round(snapshots.reduce((sum, item) => sum + Number(item.flowVehicles15 ?? item.passed15 ?? item.metadata?.flowVehicles15 ?? item.metadata?.passed15 ?? 0), 0) / Math.max(1, snapshots.length)));
  const waitSamples = snapshots.filter((item) => item.wait !== null && item.wait !== undefined);
  const wait = waitSamples.length ? Math.round(waitSamples.reduce((sum, item) => sum + Number(item.wait || 0) * Math.max(1, Number(item.confidence || 50)), 0) / Math.max(1, waitSamples.reduce((sum, item) => sum + Math.max(1, Number(item.confidence || 50)), 0))) : null;
  return {
    counts,
    visibleTotal,
    queueVehicles: Math.max(0, Math.round(snapshots.reduce((sum, item) => sum + Number(item.queueVehicles || item.visibleTotal || 0), 0) / Math.max(1, snapshots.length))),
    throughputPerHour,
    passed15: flowVehicles15,
    flowVehicles15,
    wait,
    queueTrend: snapshots.some((item) => item.queueTrend === 'rising' || item.metadata?.queueTrend === 'rising') ? 'rising' : snapshots.some((item) => item.queueTrend === 'falling' || item.metadata?.queueTrend === 'falling') ? 'falling' : 'steady',
    confidence: Math.round(snapshots.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / Math.max(1, snapshots.length)),
    latestAt: snapshots.map((item) => item.fetchedAt).sort().at(-1),
    snapshots,
  };
}

async function buildCameraAnalyticsPayload(crossingId, direction = 'toBih', options = {}) {
  const crossing = BORDER_CROSSINGS[crossingId] || BORDER_CROSSINGS.maljevac;
  const feeds = CAMERA_FEEDS[crossing.id] || [];
  const history = historyWithCameraEvents(crossing, direction);
  const slot = history.find((item) => Number(item.hour) === currentHourInFocusWindow()) || history[0];
  const recentEvents = getRecentCameraEvents(crossing.id, direction, 15);
  const eventMix = sumCounts(recentEvents);
  const hasIngest = recentEvents.length > 0;
  const wait = borderDelay(crossing, direction, 'car');
  const basePassed15 = Math.max(2, Math.round(slot.throughput / 4));
  const baseMix15 = {
    cars: Math.max(1, Math.round(basePassed15 * (slot.cars / Math.max(slot.totalDemand, 1)))),
    vans: Math.max(0, Math.round(basePassed15 * (slot.vans / Math.max(slot.totalDemand, 1)))),
    trucks: Math.max(0, Math.round(basePassed15 * (slot.trucks / Math.max(slot.totalDemand, 1)))),
    buses: Math.max(0, Math.round(basePassed15 * (slot.buses / Math.max(slot.totalDemand, 1)))),
  };
  const vehicleMix15 = hasIngest ? eventMix : baseMix15;
  const passed15 = Math.max(0, vehicleMix15.cars + vehicleMix15.vans + vehicleMix15.trucks + vehicleMix15.buses) || basePassed15;
  const throughputPerHour = Math.max(10, Math.round(passed15 * 4));
  const rhythmSeconds = Math.round(3600 / Math.max(throughputPerHour, 1));
  const queueVehicles = Math.max(0, Math.round((wait / 60) * throughputPerHour * 0.72));
  const detectorResults = await Promise.allSettled(feeds.map((camera) => runCvDetector(camera, crossing.id, direction)));
  const detectorCounts = detectorResults.map((result) => result.status === 'fulfilled' ? result.value : null);
  const cachedCameraSnapshots = await readLatestCameraSnapshots(crossing.id, direction, 2);
  const cachedByCamera = new Map(cachedCameraSnapshots.map((item) => [item.cameraId, item]));
  const nowMs = Date.now();
  const snapshotResults = await Promise.allSettled(feeds.map(async (camera) => {
    const cached = cachedByCamera.get(camera.id);
    const cachedFresh = cached && nowMs - new Date(cached.fetchedAt).getTime() < CAMERA_SNAPSHOT_REFRESH_INTERVAL_MS;
    if (!options.forceSnapshot && cachedFresh) return cached;
    return runSnapshotCounter(camera, crossing.id, direction, cached || null, { forceSnapshot: Boolean(options.forceSnapshot) });
  }));
  const snapshotAnalyses = snapshotResults.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    if (options.storeScan || options.forceSnapshot) console.warn('[snapshot-counter]', feeds[index]?.id, result.reason?.message || String(result.reason));
    return cachedByCamera.get(feeds[index]?.id) || null;
  });
  // CV/YOLO usage summary across this direction's cameras (for the UI/debug panel: is the real
  // detector actually driving, or did we fall back to the heuristic, and why).
  const cvAnalyses = snapshotAnalyses.filter((a) => a && (a.cvUsed !== undefined || a.cvFallbackReason !== undefined));
  const cvUsedAny = cvAnalyses.some((a) => a.cvUsed);
  const cvDurations = cvAnalyses.map((a) => Number(a.cvDurationMs || 0)).filter((n) => n > 0);
  const cvSummary = {
    cvEnabled: CAMERA_CV_ENABLED || YOLO_ENABLED || YOLO_SHADOW_MODE,
    cvUsed: cvUsedAny,
    cvSource: cvUsedAny ? 'cv-detector' : 'heuristic',
    cvFallbackReason: cvUsedAny ? null : (cvAnalyses.find((a) => a.cvFallbackReason)?.cvFallbackReason || (cvEndpoint ? 'no-detections' : 'no-endpoint')),
    cvDurationMs: cvDurations.length ? Math.max(...cvDurations) : 0,
    cvDetectionsCount: cvAnalyses.reduce((sum, a) => sum + Number(a.cvDetectionsCount || 0), 0),
  };
  // ROI v2 + multi-frame features from the direction's wait-driving camera (prefer a roiCalibrated
  // one) — surfaced on analytics so the camera source snapshot + the v2 fusion can consume them.
  let roiFeaturesPrimary = snapshotAnalyses.find((a) => a && a.roiFeatures && a.roiFeatures.roiCalibrated)?.roiFeatures
    || snapshotAnalyses.find((a) => a && a.roiFeatures)?.roiFeatures || null;
  const multiFramePrimary = snapshotAnalyses.find((a) => a && a.multiFrame && a.multiFrame.multiFrameUsed && a.multiFrame.stoppedVehicleRatio !== null)?.multiFrame
    || snapshotAnalyses.find((a) => a && a.multiFrame)?.multiFrame || null;
  // Multi-frame STABILITY: prefer the median in-ROI count across frames over the single-frame count.
  const mfMedian = snapshotAnalyses.find((a) => a && a.multiFrame && Number.isFinite(a.multiFrame.medianVehiclesInQueueRoi))?.multiFrame?.medianVehiclesInQueueRoi;
  if (roiFeaturesPrimary && Number.isFinite(mfMedian)) {
    roiFeaturesPrimary = { ...roiFeaturesPrimary, vehiclesInQueueRoi: mfMedian, multiFrameSmoothed: true };
  }
  const snapshotRows = snapshotAnalyses
    .filter(Boolean)
    .map((snapshot) => ({ ...snapshot, crossingId: crossing.id, direction, metadata: { ...(snapshot.metadata || {}), roi: snapshot.roi, occupancyPct: snapshot.occupancyPct, componentCount: snapshot.componentCount, rawCounts: snapshot.rawCounts } }));
  if (snapshotRows.length) {
    await insertCameraSnapshots(snapshotRows).catch((error) => console.warn('[camera-snapshot-store]', error.message));
  }
  const allSnapshotRows = snapshotRows.length ? snapshotRows : await readLatestCameraSnapshots(crossing.id, direction, 3);
  // Direction safety + stale gating: ONLY cameras that provably show this direction
  // AND are serving a live (non-frozen) frame may drive the hard wait. visualOnly /
  // wrong-direction / stale cameras are still analysed and displayed, but their wait
  // does not enter the fused estimate (spec §1, §2).
  const feedById = new Map(feeds.map((camera) => [camera.id, camera]));
  const waitDrivingRows = allSnapshotRows.filter((row) => {
    const camera = feedById.get(row.cameraId);
    if (!camera) return false;
    if (cameraContributionMode(camera, direction) !== 'hard') return false;
    // Must have a calibrated queue ROI to drive the wait (spec §5) — a default full-frame
    // ROI is not a queue ROI and can fabricate waits. Such cameras stay visual-only until
    // ROI is configured (surfaced by /api/admin/camera/audit before YOLO+ROI).
    if (!cameraHasQueueRoi(camera)) return false;
    if (row.stale || row.metadata?.stale) return false;
    return true;
  });
  const aggregatedSnapshots = aggregateCameraSnapshots(waitDrivingRows.length ? waitDrivingRows : []);
  // Display aggregate + band must be DIRECTION-RELEVANT: a camera that only shows the opposite
  // direction must not contribute its queue to this direction's band/mix. Cameras with no
  // declared direction (ambiguous) still count. The full camera image grid is shown separately.
  const directionRelevantRows = allSnapshotRows.filter((row) => cameraRelevantForDirection(feedById.get(row.cameraId) || {}, direction, feeds));
  const displayAggregate = aggregateCameraSnapshots(directionRelevantRows);

  const laneSignals = feeds.map((camera, index) => {
    const detector = detectorCounts[index];
    const snapshot = snapshotAnalyses[index];
    const seed = deterministicSeed(`${camera.id}-${direction}`);
    const frame = detector || snapshot?.counts || camera.calibration?.baselineFrame || {
      cars: Math.max(0, Math.round(queueVehicles / (9 + index * 2))),
      vans: Math.max(0, Math.round(queueVehicles / (22 + index * 3))),
      trucks: Math.max(0, Math.round(queueVehicles / (36 + index * 4))),
      buses: Math.max(0, Math.round(queueVehicles / (62 + index * 5))),
    };
    const frameTotal = frame.cars + frame.vans + frame.trucks + frame.buses;
    const detections = detector ? buildVehicleDetections(camera, direction, frame) : (snapshot?.detections?.length ? snapshot.detections : buildVehicleDetections(camera, direction, frame));
    const modelBonus = detector ? 5 : snapshot ? 1 : -5;
    const confidence = Math.min(97, Math.max(52, Math.round(snapshot?.confidence || (84 + (seed % 11) + modelBonus))));
    const signalPassed15 = snapshot?.passed15 ?? Math.max(0, Math.round((passed15 / Math.max(feeds.length, 1)) + frameTotal * 0.42));
    return {
      id: camera.id,
      label: camera.label,
      source: camera.source,
      confidence,
      frame,
      visibleTotal: snapshot?.visibleTotal ?? frameTotal,
      detections,
      roi: snapshot?.roi || camera.calibration?.roi,
      laneZones: camera.calibration?.laneZones || [],
      queueAnchor: camera.calibration?.queueAnchor,
      countLine: camera.calibration?.countLine || { x1: 13, y1: 74, x2: 86, y2: 42, label: 'linija prolaska', direction: direction === 'toHr' ? 'BiH → HR' : 'HR → BiH' },
      passed15: signalPassed15,
      throughputPerHour: snapshot?.throughputPerHour,
      wait: snapshot?.wait,
      laneGroups: snapshot?.laneGroups || buildLaneGroups(frame, signalPassed15, wait, confidence, camera.calibration, direction),
      model: detector ? 'cv-endpoint' : snapshot ? 'snapshot-counter' : camera.calibration ? 'calibrated-fallback' : 'vision-fallback',
      snapshot: snapshot ? { occupancyPct: snapshot.occupancyPct, componentCount: snapshot.componentCount, method: snapshot.method, width: snapshot.width, height: snapshot.height } : null,
    };
  });
  const laneProfile = sumLaneGroupsFromEvents(recentEvents) || aggregateLaneProfile(laneSignals);
  // ── COUNT → WAIT CALIBRATION (auto-use the learned rate when this crossing+direction is calibrated)
  // Only when the ROI is TRUSTED and a calibrated model exists; otherwise calibratedWaitMin is null
  // and we keep the heuristic below. This is what turns a trusted count into a data-fitted wait.
  const calibModel = getCalibrationModel(crossing.id, direction);
  const calibCount = roiFeaturesPrimary && roiFeaturesPrimary.roiTrusted ? Number(roiFeaturesPrimary.vehiclesInQueueRoi) : null;
  const calibratedWaitMin = applyCalibratedWait(calibCount, calibModel);
  const calibrationUsed = Number.isFinite(calibratedWaitMin);

  // `cameraWaitDriven` is the linchpin of direction safety: the camera estimate is only a
  // real signal when a provably-correct-direction, non-stale camera actually drove it.
  const cameraWaitDriven = calibrationUsed || Boolean(aggregatedSnapshots && aggregatedSnapshots.wait !== null && aggregatedSnapshots.wait !== undefined);
  const snapshotCounts = displayAggregate?.counts ? normalizeCounts(displayAggregate.counts) : null;
  const liveWait = calibrationUsed ? calibratedWaitMin : (cameraWaitDriven ? clampWait(aggregatedSnapshots.wait) : wait);
  const liveThroughputPerHour = aggregatedSnapshots?.throughputPerHour ? Math.max(8, Number(aggregatedSnapshots.throughputPerHour)) : throughputPerHour;
  const livePassed15 = Math.max(0, Math.round(aggregatedSnapshots?.flowVehicles15 ?? aggregatedSnapshots?.passed15 ?? liveThroughputPerHour / 4));
  const liveRhythmSeconds = Math.round(3600 / Math.max(liveThroughputPerHour, 1));
  const liveQueueVehicles = aggregatedSnapshots?.queueVehicles ?? displayAggregate?.queueVehicles ?? Math.max(0, Math.round((liveWait / 60) * liveThroughputPerHour * 0.72));
  const liveVehicleMix15 = hasIngest ? eventMix : (snapshotCounts || vehicleMix15);
  const hasSnapshotCounter = cameraWaitDriven && Boolean(aggregatedSnapshots?.snapshots?.some((item) => String(item.method || '').includes('snapshot-counter')));
  // Worst (largest) queue band across the cameras shown for this direction — this is
  // the qualitative answer a camera can give even when it cannot count vehicles.
  const displayBand = (() => {
    const rows = displayAggregate?.snapshots || [];
    if (!rows.length) return null;
    let worst = { band: 'nema', label: 'Nema kolone' };
    let worstIdx = -1;
    for (const r of rows) {
      const info = classifyQueueBand({
        occupancyPct: r.metadata?.occupancyPct ?? r.occupancyPct ?? 0,
        laneFullnessPct: r.metadata?.laneFullnessPct ?? 0,
        queueVehicles: r.queueVehicles ?? 0,
        visibleVehicles: r.visibleVehicles ?? r.metadata?.visibleVehicles ?? r.visibleTotal,
        confidence: r.confidence ?? 55,
        stale: r.stale || r.metadata?.stale,
      });
      const idx = QUEUE_BANDS.indexOf(info.band);
      if (idx > worstIdx) { worstIdx = idx; worst = info; }
    }
    return worst;
  })();

  if (options.storeScan) {
    laneSignals.forEach((signal) => {
      cameraEvents.push({
        crossingId: crossing.id,
        direction,
        cameraId: signal.id,
        counts: signal.frame,
        laneGroups: signal.laneGroups,
        timestamp: new Date().toISOString(),
      });
    });
    while (cameraEvents.length > 5000) cameraEvents.shift();
  }

  return {
    ok: true,
    live: true,
    crossingId: crossing.id,
    direction,
    updatedAt: new Date().toISOString(),
    analytics: {
      updatedAt: formatHHMM(),
      state: statusFromWait(liveWait),
      wait: liveWait,
      trend: liveWait >= 65 ? 'rising' : liveWait >= 30 ? 'steady' : 'falling',
      trendLabel: liveWait >= 65 ? 'usporeno' : liveWait >= 30 ? 'pojačano' : 'protočno',
      confidence: Math.min(96, Math.max(58, Math.round(aggregatedSnapshots?.confidence || (86 + (hasIngest ? 5 : 0) + (cvEndpoint ? 4 : 0) + (hasSnapshotCounter ? 2 : 0) - (liveWait > 70 ? 5 : 0))))),
      throughputPerHour: liveThroughputPerHour,
      passed15: livePassed15,
      flowVehicles15: livePassed15,
      rhythmSeconds: liveRhythmSeconds,
      queueVehicles: liveQueueVehicles,
      queueTrend: aggregatedSnapshots?.queueTrend || (liveWait >= 65 ? 'rising' : liveWait <= 12 ? 'falling' : 'steady'),
      waitRangeMin: Math.max(0, liveWait - (hasSnapshotCounter ? 6 : 10)),
      waitRangeMax: Math.min(360, liveWait + (hasSnapshotCounter ? 9 : 14)),
      // Whether the wait is genuinely camera-driven for THIS direction (false ⇒ all
      // cameras here are visual-only/stale/wrong-direction, so it must not be a signal).
      waitIsCameraDriven: cameraWaitDriven,
      // Reliable ⇔ a real, fresh, direction-verified camera drove the wait. When false the
      // shown wait is a model/baseline fallback and must NOT be presented as a live camera
      // estimate (spec P0): the UI shows the qualitative band / "model" instead of a number.
      cameraEstimateReliable: cameraWaitDriven,
      queueBand: displayBand?.band || null,
      queueBandLabel: displayBand?.label || null,
      vehicleMix15: liveVehicleMix15,
      laneProfile,
      laneSignals,
      history,
      dailyTotals: sumCounts(history),
      // source reflects ACTUAL usage: a calibrated count→wait rate when the crossing is calibrated,
      // else cv-detector only when YOLO truly drove a frame this cycle.
      source: calibrationUsed ? 'cv-detector-calibrated' : (hasIngest ? 'camera-ingest' : (cvSummary.cvUsed ? 'cv-detector' : (hasSnapshotCounter ? 'snapshot-counter' : 'baseline-camera-model'))),
      // Count→wait calibration status for THIS crossing+direction (used | learning + why).
      calibration: calibModel
        ? { used: calibrationUsed, calibrated: Boolean(calibModel.calibrated), minutesPerVehicle: calibModel.minutesPerVehicle, mae: calibModel.mae, sampleSize: calibModel.sampleSize, reason: calibModel.reason, count: calibCount }
        : { used: false, calibrated: false, minutesPerVehicle: null, mae: null, sampleSize: 0, reason: 'no-samples', count: calibCount },
      // ROI v2 + multi-frame features (rich) for the v2 fusion + admin debug.
      roiFeatures: roiFeaturesPrimary,
      multiFrame: multiFramePrimary,
      // CV/YOLO diagnostics (flat, for UI/debug): is YOLO enabled, did it run, fallback reason, timing.
      cvEnabled: cvSummary.cvEnabled,
      cvUsed: cvSummary.cvUsed,
      cvSource: cvSummary.cvSource,
      cvFallbackReason: cvSummary.cvFallbackReason,
      cvDurationMs: cvSummary.cvDurationMs,
      cvDetectionsCount: cvSummary.cvDetectionsCount,
      cameraSnapshots: (displayAggregate?.snapshots || []).map((item) => {
        const camera = feedById.get(item.cameraId);
        const snapshotAgeSec = item.fetchedAt ? Math.max(0, Math.round((Date.now() - new Date(item.fetchedAt).getTime()) / 1000)) : null;
        const analysis = buildCameraAnalysis({
          visibleTotal: item.visibleTotal,
          queueVehicles: item.queueVehicles,
          occupancyPct: item.metadata?.occupancyPct ?? item.occupancyPct ?? 0,
          laneFullnessPct: item.metadata?.laneFullnessPct ?? 0,
          flowVehicles15: item.flowVehicles15 ?? item.metadata?.flowVehicles15,
          queueTrend: item.queueTrend || item.metadata?.queueTrend,
          confidence: item.confidence,
          stale: item.stale || item.metadata?.stale,
          motion: item.motion ?? item.metadata?.motion,
          snapshotAgeSec,
          wait: item.wait,
          method: item.method,
          visualOnly: camera ? cameraContributionMode(camera, direction) !== 'hard' : true,
        });
        return {
          cameraId: item.cameraId,
          cameraLabel: item.cameraLabel,
          validForDirections: camera?.validForDirections || [],
          contributionMode: camera ? cameraContributionMode(camera, direction) : 'visual',
          throughputPerHour: item.throughputPerHour,
          passed15: item.passed15 ?? item.metadata?.passed15,
          queueTrend: item.queueTrend || item.metadata?.queueTrend,
          wait: item.wait,
          waitRangeMin: item.metadata?.waitRangeMin,
          waitRangeMax: item.metadata?.waitRangeMax,
          method: item.method,
          fetchedAt: item.fetchedAt,
          // Guard diagnostics for the camera audit.
          preGuardWait: item.preGuardWait ?? null,
          guardApplied: Boolean(item.guardApplied),
          evidenceCap: item.evidenceCap ?? null,
          queueEvidenceScore: item.queueEvidenceScore ?? null,
          // YOLO + ROI diagnostics.
          yoloUsed: Boolean(item.yoloUsed),
          detectionsBeforeRoi: item.detectionsBeforeRoi ?? null,
          detectionsAfterRoi: item.detectionsAfterRoi ?? null,
          ignoredDetections: item.ignoredDetections ?? null,
          passedVehicles: item.passedVehicles ?? null,
          countLineCrossings: item.countLineCrossings ?? null,
          ...analysis,
        };
      }),
      message: liveWait >= 65
        ? 'Protok kroz zonu je usporen i kolona raste u odnosu na ritam prolaska.'
        : liveWait >= 30
          ? 'Protok je pojačan, ali vozila se još kreću u pravilnim intervalima.'
          : 'Protok je uredan i nema ozbiljnog zadržavanja u zoni.',
    },
  };
}

function durationToSeconds(value) {
  if (!value || typeof value !== 'string' || !value.endsWith('s')) return 0;
  return Number(value.slice(0, -1)) || 0;
}

function decodePolyline(encoded) {
  if (!encoded) return [];
  let index = 0;
  const len = encoded.length;
  let lat = 0;
  let lng = 0;
  const points = [];

  while (index < len) {
    let b;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < len);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < len);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return points;
}

function metersToKm(meters) {
  return Number(((meters || 0) / 1000).toFixed(1));
}

const ROUTE_GUARD_ENABLED = process.env.ROUTE_GUARD_ENABLED !== 'false';
const ROUTE_GUARD_DEFAULTS = {
  passDistanceMeters: Number(process.env.ROUTE_GUARD_PASS_METERS || 500),
  maxCrossingDistanceKm: Number(process.env.ROUTE_GUARD_MAX_CROSSING_KM || 8),
};

function degreesToRadians(value) {
  return Number(value || 0) * Math.PI / 180;
}

function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const lat1 = degreesToRadians(a.lat);
  const lat2 = degreesToRadians(b.lat);
  const dLat = degreesToRadians(b.lat - a.lat);
  const dLng = degreesToRadians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function minDistanceToPathMeters(point, path = []) {
  if (!point || !Array.isArray(path) || !path.length) return Infinity;
  return path.reduce((best, current) => Math.min(best, distanceMeters(point, current)), Infinity);
}


function pathDistanceMeters(path = []) {
  if (!Array.isArray(path) || path.length < 2) return 0;
  let total = 0;
  for (let index = 1; index < path.length; index += 1) {
    total += distanceMeters(path[index - 1], path[index]);
  }
  return total;
}

function nearestPathIndex(point, path = []) {
  if (!point || !Array.isArray(path) || !path.length) return -1;
  let bestIndex = 0;
  let bestDistance = Infinity;
  path.forEach((candidate, index) => {
    const currentDistance = distanceMeters(point, candidate);
    if (currentDistance < bestDistance) {
      bestDistance = currentDistance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

// Slice a path to the control zone AND return the original start/end indices so callers can
// remap Google's speedReadingIntervals (which reference original polyline point indices) onto
// the sliced display path. Returns { path, startIndex, endIndex } where indices are into the
// ORIGINAL path. `sliced` is false when no real slice happened (path returned unchanged).
function slicePathAroundPointIndexed(path = [], centerPoint, beforeMeters = 900, afterMeters = 1100) {
  if (!Array.isArray(path) || path.length < 2 || !centerPoint) return { path: path || [], startIndex: 0, endIndex: Math.max(0, (path?.length || 1) - 1), sliced: false };
  const centerIndex = nearestPathIndex(centerPoint, path);
  if (centerIndex < 0) return { path, startIndex: 0, endIndex: path.length - 1, sliced: false };

  let startIndex = centerIndex;
  let walkedBefore = 0;
  while (startIndex > 0 && walkedBefore < beforeMeters) {
    walkedBefore += distanceMeters(path[startIndex], path[startIndex - 1]);
    startIndex -= 1;
  }

  let endIndex = centerIndex;
  let walkedAfter = 0;
  while (endIndex < path.length - 1 && walkedAfter < afterMeters) {
    walkedAfter += distanceMeters(path[endIndex], path[endIndex + 1]);
    endIndex += 1;
  }

  const slice = path.slice(startIndex, endIndex + 1);
  if (slice.length < 2) return { path, startIndex: 0, endIndex: path.length - 1, sliced: false };
  return { path: slice, startIndex, endIndex, sliced: true };
}

function slicePathAroundPoint(path = [], centerPoint, beforeMeters = 900, afterMeters = 1100) {
  return slicePathAroundPointIndexed(path, centerPoint, beforeMeters, afterMeters).path;
}

// Remap Google speedReadingIntervals (referencing ORIGINAL polyline point indices) onto a
// sliced display path that starts at `sliceStart` and ends at `sliceEnd` (original indices).
// Intervals are clipped to the overlap and re-indexed to local (0-based) display coordinates.
// Non-overlapping intervals are dropped. This is the fix for traffic being lost on slicing.
function remapSpeedReadingIntervals(intervals = [], sliceStart = 0, sliceEnd = Infinity) {
  if (!Array.isArray(intervals) || !intervals.length) return [];
  const out = [];
  for (const iv of intervals) {
    const gStart = Number(iv.startPolylinePointIndex ?? 0);
    // Google can omit the end index for the last interval. Treat that as "until the end of
    // the current slice"; the previous implementation defaulted it to start and dropped it.
    const gEnd = iv.endPolylinePointIndex === undefined || iv.endPolylinePointIndex === null
      ? Number(sliceEnd)
      : Number(iv.endPolylinePointIndex);
    if (!Number.isFinite(gStart) || !Number.isFinite(gEnd)) continue;
    const oStart = Math.max(Math.min(gStart, gEnd), sliceStart);
    const oEnd = Math.min(Math.max(gStart, gEnd), sliceEnd);
    if (oEnd <= oStart) continue; // no overlapping segment with the sliced path
    out.push({
      ...iv,
      startPolylinePointIndex: oStart - sliceStart,
      endPolylinePointIndex: oEnd - sliceStart,
      speed: iv.speed || trafficSpeedFromLevel(iv.level),
    });
  }
  return out;
}

// Summarise the traffic segments on a route: counts, worst level, slow/jam metres, affected ratio.
function buildTrafficSummary(trafficSegments = [], totalMeters = 0) {
  const segs = Array.isArray(trafficSegments) ? trafficSegments : [];
  let normalSegmentCount = 0;
  let slowSegmentCount = 0;
  let trafficJamSegmentCount = 0;
  let unknownSegmentCount = 0;
  let slowMeters = 0;
  let jamMeters = 0;
  for (const s of segs) {
    const meters = pathDistanceMeters(s.path || []);
    const level = s.level || trafficSegmentColorSpeed(s.speed);
    if (level === 'jam') { trafficJamSegmentCount += 1; jamMeters += meters; }
    else if (level === 'slow') { slowSegmentCount += 1; slowMeters += meters; }
    else if (level === 'normal') normalSegmentCount += 1;
    else unknownSegmentCount += 1;
  }
  const total = Number(totalMeters) > 0 ? Number(totalMeters) : segs.reduce((sum, s) => sum + pathDistanceMeters(s.path || []), 0);
  const affectedMeters = slowMeters + jamMeters;
  const worstTrafficLevel = trafficJamSegmentCount ? 'TRAFFIC_JAM' : slowSegmentCount ? 'SLOW' : normalSegmentCount ? 'NORMAL' : 'UNKNOWN';
  return {
    hasTrafficIntervals: segs.length > 0,
    trafficIntervalCount: segs.length,
    trafficSegmentCount: segs.length,
    normalSegmentCount,
    slowSegmentCount,
    trafficJamSegmentCount,
    unknownSegmentCount,
    worstTrafficLevel,
    slowMeters: Math.round(slowMeters),
    jamMeters: Math.round(jamMeters),
    affectedMeters: Math.round(affectedMeters),
    affectedRatio: total > 0 ? Math.round((affectedMeters / total) * 100) / 100 : 0,
    trafficSegmentsPreservedAfterRouteGuard: segs.length > 0,
  };
}


function routeAnchorScore(route, anchor = {}, { includeApproachExit = true } = {}) {
  const path = Array.isArray(route?.path) ? route.path : [];
  const points = routePassPoints(anchor, { includeApproachExit });
  if (!path.length || !points.length) return Number.POSITIVE_INFINITY;
  return points.reduce((total, item) => total + Math.min(minDistanceToPathMeters(item.point, path), 50000), 0);
}

function controlZoneSubpath(path = [], startPoint, endPoint) {
  if (!Array.isArray(path) || path.length < 2 || !startPoint || !endPoint) return [];
  const startIndex = nearestPathIndex(startPoint, path);
  const endIndex = nearestPathIndex(endPoint, path);
  if (startIndex < 0 || endIndex < 0) return [];
  const from = Math.min(startIndex, endIndex);
  const to = Math.max(startIndex, endIndex);
  return path.slice(from, to + 1);
}

function routeControlZoneDirectness(route, anchor = {}) {
  const path = Array.isArray(route?.path) ? route.path : [];
  if (!path.length || !anchor?.approachStart || !anchor?.exitPoint) return Number.POSITIVE_INFINITY;
  const segment = controlZoneSubpath(path, anchor.approachStart, anchor.exitPoint);
  if (segment.length < 2) return Number.POSITIVE_INFINITY;
  const segmentDistance = pathDistanceMeters(segment);
  const directDistance = distanceMeters(anchor.approachStart, anchor.exitPoint);
  if (!segmentDistance || !directDistance) return Number.POSITIVE_INFINITY;
  return Number((segmentDistance / Math.max(directDistance, 1)).toFixed(3));
}

function routeAnchorOrderPenalty(route, anchor = {}) {
  const path = Array.isArray(route?.path) ? route.path : [];
  if (!path.length || !anchor?.approachStart || !anchor?.borderPoint || !anchor?.exitPoint) return 0;
  const approachIndex = nearestPathIndex(anchor.approachStart, path);
  const borderIndex = nearestPathIndex(anchor.borderPoint, path);
  const exitIndex = nearestPathIndex(anchor.exitPoint, path);
  if (approachIndex < 0 || borderIndex < 0 || exitIndex < 0) return 0;
  return approachIndex <= borderIndex && borderIndex <= exitIndex ? 0 : 1;
}

function sortCrossingRoutesByAnchorFit(routes = [], anchor = {}) {
  return [...routes]
    .map((route, index) => ({
      route,
      index,
      strictScore: routeAnchorScore(route, anchor, { includeApproachExit: true }),
      borderScore: routeAnchorScore(route, anchor, { includeApproachExit: false }),
      orderPenalty: routeAnchorOrderPenalty(route, anchor),
      directness: routeControlZoneDirectness(route, anchor),
      durationMinutes: Number(route.durationMinutes || 0),
      distanceKm: Number(route.distanceKm || 0),
    }))
    .sort((a, b) => {
      if (a.strictScore !== b.strictScore) return a.strictScore - b.strictScore;
      if (a.orderPenalty !== b.orderPenalty) return a.orderPenalty - b.orderPenalty;
      if (a.directness !== b.directness) return a.directness - b.directness;
      if (a.borderScore !== b.borderScore) return a.borderScore - b.borderScore;
      if (a.durationMinutes !== b.durationMinutes) return a.durationMinutes - b.durationMinutes;
      if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
      return a.index - b.index;
    })
    .map((entry) => entry.route);
}

// A point `extendMeters` out from the border along the border→target road bearing (never shorter
// than the calibrated anchor itself). Pushing the Google request origin/destination further out
// makes Google draw MORE of the REAL road on each side; Google snaps it to the actual carriageway.
function extendedAlongRoad(borderPoint, target, extendMeters) {
  if (!borderPoint || !target || !Number.isFinite(Number(extendMeters))) return target || null;
  const dist = distanceMeters(borderPoint, target);
  const reach = Math.max(dist, Number(extendMeters));
  return pointAlongBearing(borderPoint, target, reach) || target;
}

// Origin/destination for the GOOGLE route request. Prefer an explicit display anchor; else, when a
// displayCorridor.requestExtendMeters is set, extend the precise anchor along the road so Google
// returns a LONGER road-following route on both sides; else the precise anchor.
function routeOriginAnchor(anchor = {}) {
  if (anchor.displayApproachStart) return anchor.displayApproachStart;
  const ext = anchor.routeGuard?.displayCorridor?.requestExtendMeters;
  if (ext && anchor.borderPoint && anchor.approachStart) return extendedAlongRoad(anchor.borderPoint, anchor.approachStart, ext);
  return anchor.approachStart;
}
function routeDestinationAnchor(anchor = {}) {
  if (anchor.displayExitPoint) return anchor.displayExitPoint;
  const ext = anchor.routeGuard?.displayCorridor?.requestExtendMeters;
  if (ext && anchor.borderPoint && anchor.exitPoint) return extendedAlongRoad(anchor.borderPoint, anchor.exitPoint, ext);
  return anchor.exitPoint;
}

// Clean fallback corridor — uses the EXTENDED display anchors when present so even the no-Google
// fallback shows a useful zone that crosses the border (precise anchors otherwise).
function cleanAnchorCorridorPath(anchor = {}) {
  const approach = anchor.displayApproachStart || anchor.approachStart;
  const exit = anchor.displayExitPoint || anchor.exitPoint;
  return [approach, anchor.borderPoint, exit].filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)));
}

function routeWiggleRatio(path = [], anchor = {}) {
  const distance = pathDistanceMeters(path);
  // Compare against the DISPLAY-anchor span (the route is requested between those), so extending the
  // zone does not, by itself, inflate the wiggle ratio and trip the city-loop guard.
  const a = anchor?.displayApproachStart || anchor?.approachStart;
  const b = anchor?.displayExitPoint || anchor?.exitPoint;
  const direct = a && b ? distanceMeters(a, b) : 0;
  if (!distance || !direct) return 1;
  return distance / Math.max(direct, 1);
}

function makeMapFriendlyControlZoneRoute(route, anchor = {}) {
  const guard = anchor.routeGuard || {};
  const dc = guard.displayCorridor || null;
  // Longer-but-still-focused control zone. A displayCorridor.sliceMeters widens BOTH sides equally so
  // the HR side is never cut short; otherwise per-anchor displayBefore/After apply.
  let beforeMeters = Number(dc?.sliceMeters || guard.displayBeforeMeters || process.env.ROUTE_DISPLAY_BEFORE_METERS || 1300);
  let afterMeters = Number(dc?.sliceMeters || guard.displayAfterMeters || process.env.ROUTE_DISPLAY_AFTER_METERS || 1300);
  const hrExtra = Number(process.env.ROUTE_HR_SIDE_EXTRA_METERS || guard.hrSideExtraMeters || 0);
  if (route.direction === 'toHr') afterMeters += hrExtra;
  else beforeMeters += hrExtra;

  const maxDisplayMeters = Number(guard.displayMaxMeters || process.env.ROUTE_DISPLAY_MAX_METERS || 3400);
  let slice = slicePathAroundPointIndexed(route.path || [], anchor.borderPoint, beforeMeters, afterMeters);
  let displayPath = slice.path;
  let displayDistanceMeters = pathDistanceMeters(displayPath);

  // Strict cap: if Google's sliced road still spans too much city/approach, reslice tightly around
  // the border. This keeps the visual honest and prevents "random" anchors far from the crossing.
  if (displayDistanceMeters > maxDisplayMeters && maxDisplayMeters > 300) {
    const totalWindow = Math.max(300, beforeMeters + afterMeters);
    const scale = maxDisplayMeters / totalWindow;
    const cappedBefore = Math.max(150, beforeMeters * scale);
    const cappedAfter = Math.max(150, afterMeters * scale);
    slice = slicePathAroundPointIndexed(route.path || [], anchor.borderPoint, cappedBefore, cappedAfter);
    displayPath = slice.path;
    displayDistanceMeters = pathDistanceMeters(displayPath);
  }

  let displayGeometrySource = 'google-sliced-control-zone';
  let displayGeometryWarnings = [];
  let usedFallbackCorridor = false;

  // PREFER Google's REAL road-following polyline. Only fall back to a clean straight corridor when the
  // Google geometry is genuinely BROKEN — doesn't cross the border, loops / U-turns, is too wiggly, or
  // is a stub. The straight corridor is the emergency, never the default (a straight line that ignores
  // the road is worse than a slightly short one).
  const quality = validateDisplayPathQuality(displayPath, anchor, {
    minSideMeters: dc?.minSideMeters || 300,
    minTotalMeters: dc?.minGoogleMeters || 900,
    maxWiggleRatio: dc?.maxWiggleRatio || 1.8,
    nearToleranceM: guard.passDistanceMeters ? Math.max(600, Number(guard.passDistanceMeters)) : 700,
    maxTurnDeg: dc?.maxTurnDeg || 150,
  });
  if (!displayPath.length || displayDistanceMeters <= 0 || !quality.ok) {
    const corridor = dc
      ? buildCalibratedCorridor(anchor, { minPerSideMeters: dc.fallbackPerSideMeters || 1100, maxPerSideMeters: dc.fallbackMaxPerSideMeters || 1700 })
      : cleanAnchorCorridorPath(anchor);
    if (corridor.length >= 2) {
      displayPath = corridor;
      displayDistanceMeters = pathDistanceMeters(displayPath);
      usedFallbackCorridor = true;
      displayGeometrySource = 'clean-anchor-corridor';
      displayGeometryWarnings = [`Google ruta nije bila uredna (${(quality.reasons || ['nije dostupna']).join(', ')}); prikazana je čista kalibrirana zona koja prelazi granicu.`];
      slice = { startIndex: 0, endIndex: Math.max(0, (route.path || []).length - 1) };
    }
  }
  if (!displayPath.length || displayDistanceMeters <= 0) return route;
  // Preserve Google's traffic: remap the original speedReadingIntervals onto the sliced path
  // (this is exactly where they used to be thrown away). The sliced path is around the border,
  // so the resulting segments are the NEAR-BORDER traffic — what matters for the wait. A manual
  // corridor has different geometry than Google's polyline, so we colour it UNIFORMLY by the route's
  // overall level instead of mis-mapping per-segment intervals onto it.
  const sourceTrafficIntervals = extractSpeedReadingIntervals(route);
  const remappedIntervals = usedFallbackCorridor ? [] : remapSpeedReadingIntervals(sourceTrafficIntervals, slice.startIndex, slice.endIndex);
  let displayTrafficSegments;
  if (usedFallbackCorridor) {
    // The straight fallback corridor has different geometry than Google's polyline, so colour it
    // uniformly by the route's overall level instead of mis-mapping per-segment intervals.
    const overallLevel = route.level || delayLevel(Number(route.delayMinutes || 0), Number(route.ratio || 1));
    const hadTraffic = sourceTrafficIntervals.length > 0 || Number(route.delayMinutes || 0) > 0;
    displayTrafficSegments = hadTraffic ? [{ path: displayPath, level: overallLevel, speed: trafficSpeedFromLevel(overallLevel) }] : [];
  } else {
    displayTrafficSegments = buildTrafficSegments(displayPath, remappedIntervals);
  }
  const displayTrafficSummary = buildTrafficSummary(displayTrafficSegments, displayDistanceMeters);

  const originalDistanceMeters = Number(route.distanceMeters || pathDistanceMeters(route.path || []) || displayDistanceMeters);
  const ratio = Math.max(0.1, Math.min(1, displayDistanceMeters / Math.max(originalDistanceMeters, 1)));
  const durationMinutes = Math.max(1, Math.round(Number(route.durationMinutes || 1) * ratio));
  const staticMinutes = Math.max(1, Math.round(Number(route.staticMinutes || route.durationMinutes || 1) * ratio));
  const delayMinutes = Math.max(0, Math.round(Number(route.delayMinutes || 0) * ratio));

  return {
    ...route,
    rawDistanceKm: route.distanceKm,
    rawDurationMinutes: route.durationMinutes,
    rawPathPoints: Array.isArray(route.path) ? route.path.length : 0,
    path: displayPath,
    distanceMeters: Math.round(displayDistanceMeters),
    distanceKm: metersToKm(displayDistanceMeters),
    durationMinutes,
    staticMinutes,
    delayMinutes,
    ratio: staticMinutes ? Number((durationMinutes / staticMinutes).toFixed(2)) : route.ratio,
    level: delayLevel(delayMinutes, staticMinutes ? durationMinutes / staticMinutes : route.ratio),
    speedReadingIntervals: remappedIntervals,
    trafficSegments: displayTrafficSegments,
    trafficSummary: displayTrafficSummary,
    label: route.primary ? 'Provjerena zona' : (route.variantLabel || 'Alternativni prilaz'),
    labelPosition: anchor.borderPoint || displayPath[Math.floor(displayPath.length / 2)] || displayPath[0],
    displayMode: 'control_zone',
    displayGeometrySource,
    displayGeometryWarnings,
    displayWiggleRatio: Math.round(routeWiggleRatio(displayPath, anchor) * 10) / 10,
    // Structured, tidy display geometry for the UI: explicit anchors + a simplified corridor
    // polyline + a measurement-zone ribbon polygon. The UI prefers these over the raw path so the
    // map shows a clean "Provjerena zona" instead of wiggly off-road artifacts (Problem D).
    displayZone: buildMeasurementZone({ path: displayPath, anchor, direction: route.direction }),
    displayNote: 'Na karti je prikazana čista provjerena zona oko prijelaza, bez udaljenih početnih/završnih sidara i bez sirovih Google vijuganja.',
  };
}

function routePassPoints(anchor = {}, { includeApproachExit = true } = {}) {
  const points = [];
  if (includeApproachExit && anchor.approachStart) points.push({ key: 'approachStart', label: anchor.fromLabel || 'prilaz', point: anchor.approachStart });
  if (anchor.borderPoint) points.push({ key: 'borderPoint', label: 'checkpoint', point: anchor.borderPoint });
  if (includeApproachExit && anchor.exitPoint) points.push({ key: 'exitPoint', label: anchor.toLabel || 'izlaz', point: anchor.exitPoint });
  return points;
}

function validateRouteGuard(route, crossing, direction = 'toBih', context = 'crossing') {
  const anchor = crossing?.anchors?.[direction] || crossing?.anchors?.toBih;
  const guard = anchor?.routeGuard || null;
  const metrics = {};
  const warnings = [];
  const errors = [];

  // Only crossings with manually calibrated production anchors should be guarded strictly.
  // Generic generated anchors are fine for demo/fallback but must not reject routes.
  if (!ROUTE_GUARD_ENABLED || !anchor || !guard) {
    return { ok: true, enabled: ROUTE_GUARD_ENABLED, configured: Boolean(guard), warnings, errors, metrics };
  }

  const passDistanceMeters = guard.passDistanceMeters || ROUTE_GUARD_DEFAULTS.passDistanceMeters;
  const includeApproachExit = guard.validateApproachExit !== false;
  const requiredPoints = routePassPoints(anchor, { includeApproachExit });
  if (!requiredPoints.length) return { ok: true, enabled: ROUTE_GUARD_ENABLED, configured: true, warnings, errors, metrics };

  // Hard rule: the route must pass close to the manually calibrated points.
  // This catches the real production problem: Google snapping to the wrong road/pin.
  for (const item of requiredPoints) {
    const distance = minDistanceToPathMeters(item.point, route.path || []);
    metrics[item.key] = Math.round(distance);
    if (!Number.isFinite(distance) || distance > passDistanceMeters) {
      errors.push(`${item.label} nije na ruti (${Number.isFinite(distance) ? Math.round(distance) : '∞'} m od polilinije)`);
    }
  }

  if (context === 'crossing') {
    const maxCrossingDistanceKm = guard.maxCrossingDistanceKm || ROUTE_GUARD_DEFAULTS.maxCrossingDistanceKm;
    const hardMaxCrossingDistanceKm = guard.hardMaxCrossingDistanceKm || Math.max(maxCrossingDistanceKm * 2, maxCrossingDistanceKm + 4);
    metrics.routeDistanceKm = Number(route.distanceKm || 0);
    metrics.maxCrossingDistanceKm = maxCrossingDistanceKm;
    metrics.hardMaxCrossingDistanceKm = hardMaxCrossingDistanceKm;
    if (route.distanceKm && route.distanceKm > hardMaxCrossingDistanceKm) {
      errors.push(`ruta je ekstremno preduga za kontrolnu zonu (${route.distanceKm} km > ${hardMaxCrossingDistanceKm} km)`);
    } else if (route.distanceKm && route.distanceKm > maxCrossingDistanceKm) {
      // Soft warning only. Some border approaches (especially Maljevac) naturally return
      // a slightly longer Google path because the legal drivable road is not a straight line.
      warnings.push(`ruta je malo dulja od očekivane kontrolne zone (${route.distanceKm} km > ${maxCrossingDistanceKm} km), ali prolazi kroz kalibrirane točke`);
    }
  }

  const failOpen = guard.rejectOnFail === false || guard.failOpen === true || guard.enforcement === 'warn';
  const blockingErrors = [...errors];
  if (failOpen && blockingErrors.length) {
    warnings.push(...blockingErrors.map((issue) => `Route guard upozorenje (ne blokira prikaz): ${issue}`));
  }

  return {
    ok: failOpen || blockingErrors.length === 0,
    enabled: true,
    failOpen,
    passDistanceMeters,
    warnings,
    errors: failOpen ? [] : blockingErrors,
    ignoredErrors: failOpen ? blockingErrors : [],
    metrics,
  };
}

function guardedRoutes(routes, crossing, direction, context = 'crossing') {
  const withGuard = routes.map((route) => {
    const guard = validateRouteGuard(route, crossing, direction, context);
    return { ...route, routeGuard: guard, routeQuality: guard.ok ? 'verified' : 'rejected' };
  });
  return {
    accepted: withGuard.filter((route) => route.routeGuard?.ok),
    rejected: withGuard.filter((route) => !route.routeGuard?.ok),
  };
}

function delayLevel(delayMinutes, ratio) {
  if (delayMinutes >= 8 || ratio >= 1.45) return 'heavy';
  if (delayMinutes >= 3 || ratio >= 1.18) return 'slow';
  return 'normal';
}

function routeUnavailablePayload(reason = 'Ruta trenutno nije dostupna.', extra = {}) {
  return {
    ok: false,
    live: false,
    updatedAt: new Date().toISOString(),
    note: reason,
    routes: [],
    ...extra,
  };
}

function suggestedAlternativeFor(crossing, direction = 'toBih') {
  const replacementId = crossing?.routeStatusHint?.replacementCrossingId;
  const alternative = replacementId ? BORDER_CROSSINGS[replacementId] : null;
  if (!alternative) return null;
  const anchor = alternative.anchors?.[direction] || alternative.anchors?.toBih || {};
  return {
    crossingId: alternative.id,
    crossingName: alternative.name,
    shortName: alternative.shortName,
    label: `Prikaži ${alternative.shortName}`,
    zone: {
      from: anchor.fromLabel,
      border: alternative.name,
      to: anchor.toLabel,
      label: anchor.label,
    },
  };
}

function routeClosedPayload(crossing, direction = 'toBih', reason = 'Ruta preko ovog prijelaza trenutno izgleda zatvorena ili preusmjerena.', extra = {}) {
  const anchor = crossing.anchors?.[direction] || crossing.anchors?.toBih || {};
  return {
    ok: true,
    live: true,
    closed: true,
    routeUnavailable: true,
    routeStatus: 'closed_or_blocked',
    direction,
    crossingId: crossing.id,
    crossing: crossing.name,
    zone: {
      from: anchor.fromLabel,
      border: crossing.name,
      to: anchor.toLabel,
      label: anchor.label,
    },
    source: 'Google Routes API + route guard',
    updatedAt: new Date().toISOString(),
    note: reason,
    reopenPolicy: 'Aplikacija ponovno provjerava rutu svake 2 minute; čim Google vrati validnu putanju kroz kalibrirane točke, ruta će se automatski prikazati bez novog deploya.',
    suggestedCrossing: suggestedAlternativeFor(crossing, direction),
    routes: [],
    ...extra,
  };
}

function isLikelyClosedOrBlockedRoute(error, crossing, direction = 'toBih') {
  const anchor = crossing?.anchors?.[direction] || crossing?.anchors?.toBih || {};
  const guard = anchor.routeGuard || {};
  const hardMax = Number(guard.hardMaxCrossingDistanceKm || Math.max(Number(guard.maxCrossingDistanceKm || 0) * 2, Number(guard.maxCrossingDistanceKm || 0) + 4));
  const rejected = Array.isArray(error?.rejectedRoutes) ? error.rejectedRoutes : [];
  const extremeDetour = rejected.some((route) => Number(route.distanceKm || 0) > Math.max(8, hardMax || 0));
  const message = String(error?.message || '');
  const googleNoRoute = /ZERO_RESULTS|NO_ROUTE|no route|route.*not.*found|cannot be calculated|not possible/i.test(message);
  return extremeDetour || googleNoRoute;
}

function routePendingPayload(crossing, direction = 'toBih', reason = 'Ruta se ne prikazuje dok ne potvrdimo stvarnu cestovnu liniju.', extra = {}) {
  const anchor = crossing.anchors?.[direction] || crossing.anchors?.toBih || {};
  return {
    ok: true,
    live: false,
    direction,
    crossingId: crossing.id,
    crossing: crossing.name,
    zone: {
      from: anchor.fromLabel,
      border: crossing.name,
      to: anchor.toLabel,
      label: anchor.label,
    },
    updatedAt: new Date().toISOString(),
    source: 'route-verification-pending',
    routeStatus: 'pending_verification',
    routeHidden: true,
    note: reason,
    routes: [],
    ...extra,
  };
}

function buildFallbackCrossingRoute(crossing, direction = 'toBih', reason = 'Google Routes trenutno nije vratio sigurnu cestovnu liniju. Da mapa ne izgleda nepouzdano, rutu ne crtamo dok ne stigne validirana putanja.', extra = {}) {
  return routePendingPayload(crossing, direction, reason, extra);
}

function buildCalibratedControlZoneRoute(crossing, direction = 'toBih', reason = 'Google trenutno ne vraća traffic rutu, pa prikazujemo ručno kalibriranu zonu prijelaza.', extra = {}) {
  const anchor = crossing.anchors?.[direction] || crossing.anchors?.toBih || {};
  const path = [anchor.approachStart, anchor.borderPoint, anchor.exitPoint].filter(Boolean);
  const distanceMetersValue = Math.max(1, Math.round(pathDistanceMeters(path)));
  const durationMinutes = Math.max(1, Math.round((distanceMetersValue / 1000 / 35) * 60));
  const route = {
    id: `${crossing.id}-calibrated-zone`,
    label: 'Kalibrirana zona',
    description: 'Ručna sigurnosna zona prijelaza',
    primary: true,
    crossingId: crossing.id,
    crossingName: crossing.name,
    direction,
    encodedPolyline: '',
    path,
    durationMinutes,
    staticMinutes: durationMinutes,
    delayMinutes: 0,
    ratio: 1,
    distanceKm: metersToKm(distanceMetersValue),
    distanceMeters: distanceMetersValue,
    level: 'unknown',
    speedReadingIntervals: [],
    trafficSegments: [],
    source: 'calibrated-control-zone',
    routeQuality: 'calibrated-fallback',
    routeGuard: { ok: true, enabled: false, fallback: true, warnings: ['Google route nije dostupan; prikaz je ručno kalibrirana zona.'], errors: [], metrics: {} },
    displayMode: 'control_zone',
    displayNote: 'Google trenutno ne vraća pouzdanu lokalnu putanju za ovu zonu. Ovo nije oznaka zatvaranja, nego privremeni prikaz kalibrirane dionice.',
    zone: {
      from: anchor.fromLabel,
      border: crossing.name,
      to: anchor.toLabel,
      label: anchor.label,
    },
  };

  return {
    ok: true,
    live: false,
    direction,
    crossingId: crossing.id,
    crossing: crossing.name,
    zone: route.zone,
    updatedAt: new Date().toISOString(),
    source: 'calibrated-control-zone',
    routeStatus: 'calibrated_fallback',
    displayMode: 'control_zone',
    note: reason,
    routes: path.length >= 2 ? [route] : [],
    ...extra,
  };
}

function trafficSegmentColorSpeed(speed) {
  if (speed === 'TRAFFIC_JAM') return 'jam';
  if (speed === 'SLOW') return 'slow';
  if (speed === 'NORMAL') return 'normal';
  return 'unknown';
}

function trafficSegmentSeverity(speedOrLevel) {
  const level = trafficSegmentColorSpeed(speedOrLevel);
  if (level === 'jam') return 2;
  if (level === 'slow') return 1;
  if (level === 'normal') return 0;
  return null;
}

function trafficSpeedFromLevel(level = '') {
  if (level === 'jam') return 'TRAFFIC_JAM';
  if (level === 'slow') return 'SLOW';
  if (level === 'normal') return 'NORMAL';
  return 'SPEED_UNSPECIFIED';
}

function extractSpeedReadingIntervals(route = {}) {
  if (Array.isArray(route.speedReadingIntervals) && route.speedReadingIntervals.length) return route.speedReadingIntervals;
  // Defensive fallback: if a route was already normalized before another display/slicing pass,
  // the original Google array may be missing while trafficSegments still carry the original
  // point indexes. Convert those back into Google-like intervals instead of silently turning
  // the route blue again. No segment is fabricated here; this only preserves existing signal.
  if (!Array.isArray(route.trafficSegments) || !route.trafficSegments.length) return [];
  return route.trafficSegments
    .map((segment) => ({
      startPolylinePointIndex: segment.startPolylinePointIndex,
      endPolylinePointIndex: segment.endPolylinePointIndex,
      speed: segment.speed || trafficSpeedFromLevel(segment.level),
    }))
    .filter((segment) => Number.isFinite(Number(segment.startPolylinePointIndex)) && Number.isFinite(Number(segment.endPolylinePointIndex)));
}

function buildTrafficSegments(pathPoints, intervals = []) {
  if (!Array.isArray(pathPoints) || pathPoints.length < 2 || !Array.isArray(intervals) || !intervals.length) return [];

  return intervals
    .map((interval, index) => {
      const start = Math.max(0, Math.min(pathPoints.length - 1, Number(interval.startPolylinePointIndex ?? 0)));
      const endRaw = interval.endPolylinePointIndex === undefined || interval.endPolylinePointIndex === null
        ? pathPoints.length - 1
        : Number(interval.endPolylinePointIndex);
      const end = Math.max(0, Math.min(pathPoints.length - 1, endRaw));
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      const segmentPath = pathPoints.slice(from, to + 1);
      const speed = interval.speed || 'SPEED_UNSPECIFIED';

      return {
        id: `traffic-${index + 1}`,
        speed,
        level: trafficSegmentColorSpeed(speed),
        severity: trafficSegmentSeverity(speed),
        startPolylinePointIndex: from,
        endPolylinePointIndex: to,
        path: segmentPath.length >= 2 ? segmentPath : [],
      };
    })
    .filter((segment) => segment.path.length >= 2);
}

function latLngWaypoint(point, options = {}) {
  const waypoint = {
    location: {
      latLng: {
        latitude: point.lat,
        longitude: point.lng,
      },
    },
  };
  if (options.via) waypoint.via = true;
  return waypoint;
}

function addressWaypoint(address) {
  return { address };
}

function routeRequest({ origin, destination, intermediates = [], alternatives = true }) {
  return {
    origin,
    destination,
    intermediates,
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
    departureTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    computeAlternativeRoutes: alternatives,
    languageCode: 'hr-HR',
    units: 'METRIC',
    polylineQuality: 'HIGH_QUALITY',
    extraComputations: ['TRAFFIC_ON_POLYLINE'],
  };
}

async function fetchRoutes(body) {
  const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': serverKey,
      'X-Goog-FieldMask': [
        'routes.duration',
        'routes.staticDuration',
        'routes.distanceMeters',
        'routes.description',
        'routes.polyline.encodedPolyline',
        'routes.travelAdvisory.speedReadingIntervals',
      ].join(','),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Routes API ${response.status}: ${text.slice(0, 240)}`);
  }

  return response.json();
}

function normalizeRoute(route, index, meta = {}) {
  const durationSeconds = durationToSeconds(route.duration);
  const staticSeconds = durationToSeconds(route.staticDuration);
  const durationMinutes = Math.max(0, Math.round(durationSeconds / 60));
  const staticMinutes = Math.max(0, Math.round(staticSeconds / 60));
  const delayMinutes = Math.max(0, durationMinutes - staticMinutes);
  const ratio = staticSeconds ? durationSeconds / staticSeconds : 1;
  const encoded = route.polyline?.encodedPolyline || '';
  const pathPoints = decodePolyline(encoded);

  return {
    id: meta.id || `google-route-${index + 1}`,
    label: meta.label || (index === 0 ? 'Preporučena ruta' : `Alternativa ${index + 1}`),
    description: route.description || '',
    primary: meta.primary ?? index === 0,
    encodedPolyline: encoded,
    path: pathPoints,
    durationMinutes,
    staticMinutes,
    delayMinutes,
    ratio: Number(ratio.toFixed(2)),
    distanceKm: metersToKm(route.distanceMeters || 0),
    distanceMeters: route.distanceMeters || 0,
    level: delayLevel(delayMinutes, ratio),
    speedReadingIntervals: route.travelAdvisory?.speedReadingIntervals || [],
    trafficSegments: buildTrafficSegments(pathPoints, route.travelAdvisory?.speedReadingIntervals || []),
    trafficSummary: buildTrafficSummary(buildTrafficSegments(pathPoints, route.travelAdvisory?.speedReadingIntervals || []), route.distanceMeters || 0),
    source: 'Google Routes API',
    ...meta,
  };
}

function vehicleKey(value = 'car') {
  if (value === 'truck') return 'truck';
  if (value === 'bus') return 'bus';
  return 'car';
}

function normalizeTripText(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const TRIP_PLACE_COORDS = [
  { keys: ['zagreb', 'hrvatska', 'croatia'], lat: 45.815, lng: 15.981 },
  { keys: ['split'], lat: 43.508, lng: 16.440 },
  { keys: ['rijeka'], lat: 45.327, lng: 14.442 },
  { keys: ['osijek'], lat: 45.555, lng: 18.695 },
  { keys: ['munchen', 'muenchen', 'münchen', 'minhen', 'bavarska'], lat: 48.137, lng: 11.575 },
  { keys: ['stuttgart'], lat: 48.775, lng: 9.182 },
  { keys: ['frankfurt'], lat: 50.110, lng: 8.682 },
  { keys: ['koln', 'köln', 'cologne'], lat: 50.938, lng: 6.960 },
  { keys: ['dortmund'], lat: 51.514, lng: 7.465 },
  { keys: ['berlin', 'njemacka', 'njemačka', 'germany', 'deutschland'], lat: 52.520, lng: 13.405 },
  { keys: ['bec', 'beč', 'vienna', 'wien', 'austria', 'österreich'], lat: 48.208, lng: 16.373 },
  { keys: ['ljubljana', 'slovenija', 'slovenia'], lat: 46.056, lng: 14.505 },
  { keys: ['sarajevo', 'bosna', 'bih', 'bosnia', 'herzegovina'], lat: 43.856, lng: 18.413 },
  { keys: ['banja luka', 'banjaluka'], lat: 44.772, lng: 17.191 },
  { keys: ['cazin'], lat: 44.966, lng: 15.943 },
  { keys: ['bihac', 'bihać'], lat: 44.812, lng: 15.868 },
  { keys: ['tuzla'], lat: 44.538, lng: 18.676 },
  { keys: ['zenica'], lat: 44.203, lng: 17.907 },
  { keys: ['mostar'], lat: 43.343, lng: 17.808 },
];

const BIH_TRIP_WORDS = ['bih', 'bosna', 'bosnia', 'herzegovina', 'sarajevo', 'banja luka', 'banjaluka', 'cazin', 'bihac', 'bihać', 'tuzla', 'zenica', 'mostar', 'travnik', 'prijedor', 'doboj'];
const NORTH_WEST_TRIP_WORDS = ['hrvatska', 'croatia', 'zagreb', 'split', 'rijeka', 'osijek', 'njemacka', 'njemačka', 'germany', 'deutschland', 'munchen', 'muenchen', 'münchen', 'minhen', 'stuttgart', 'frankfurt', 'berlin', 'koln', 'köln', 'dortmund', 'austria', 'österreich', 'wien', 'vienna', 'bec', 'beč', 'slovenija', 'slovenia', 'ljubljana'];

function textHasTripPlace(value, words) {
  const text = normalizeTripText(value);
  return words.some((word) => text.includes(normalizeTripText(word)));
}

function inferJourneyDirection(origin, destination) {
  const originIsBih = textHasTripPlace(origin, BIH_TRIP_WORDS);
  const destinationIsBih = textHasTripPlace(destination, BIH_TRIP_WORDS);
  const originIsNorthWest = textHasTripPlace(origin, NORTH_WEST_TRIP_WORDS);
  const destinationIsNorthWest = textHasTripPlace(destination, NORTH_WEST_TRIP_WORDS);
  if (originIsBih && destinationIsNorthWest) return 'toHr';
  if (originIsNorthWest && destinationIsBih) return 'toBih';
  return null;
}

function matchTripCoord(value) {
  const text = normalizeTripText(value);
  return TRIP_PLACE_COORDS.find((place) => place.keys.some((key) => text.includes(normalizeTripText(key)))) || null;
}

function estimateFallbackTripBaseMinutes(origin, destination) {
  const from = matchTripCoord(origin);
  const to = matchTripCoord(destination);
  const distance = from && to ? distanceMeters(from, to) / 1000 : 0;
  if (!distance) return 90;
  const drivingKm = distance * 1.22;
  return Math.max(55, Math.round((drivingKm / 82) * 60));
}

function borderDelay(crossing, direction = 'toBih', vehicle = 'car') {
  const key = vehicleKey(vehicle);
  return crossing.waits?.[direction]?.[key] ?? crossing.waits?.[direction]?.car ?? 0;
}

async function buildFallbackJourneyOptions(direction, vehicle, origin = '', destination = '') {
  const store = await readAppStore();
  const baseTripMinutes = estimateFallbackTripBaseMinutes(origin, destination);
  const options = await Promise.all(Object.values(BORDER_CROSSINGS)
    .map(async (crossing, index) => {
      const anchor = crossing.anchors[direction] || crossing.anchors.toBih;
      const borderSignal = await effectiveBorderSignal(crossing, direction, vehicle, store);
      const delayKnown = borderSignal.displayReady !== false && Number.isFinite(Number(borderSignal.wait));
      const delay = delayKnown ? Number(borderSignal.wait) : 0;
      const seed = deterministicSeed(`${crossing.id}-${direction}-${vehicle}`);
      const extraDrive = Number(crossing.extraDriveFromMainRoute ?? 0);
      const routeDurationMinutes = baseTripMinutes + extraDrive + Math.round(index * 2.5) + (seed % 9);
      const distanceKm = Number((70 + index * 8.4 + (seed % 23) / 10).toFixed(1));
      return {
        id: crossing.id,
        crossingId: crossing.id,
        crossingName: crossing.name,
        shortName: crossing.shortName,
        direction,
        vehicle: vehicleKey(vehicle),
        routeDurationMinutes,
        borderDelayMinutes: delayKnown ? delay : null,
        borderZastojMinutes: delayKnown ? delay : null,
        borderDelayKnown: delayKnown,
        waitUnknown: !delayKnown,
        borderSource: { label: borderSignal.label, sourceType: borderSignal.sourceType, confidence: borderSignal.confidence, note: borderSignal.note },
        totalMinutes: routeDurationMinutes + delay,
        distanceKm,
        googleDelayMinutes: 0,
        level: delayKnown ? delayLevel(Math.max(0, delay - 20), 1) : 'unknown',
        source: 'fallback-estimate',
        zone: {
          from: anchor.fromLabel,
          border: crossing.name,
          to: anchor.toLabel,
          label: anchor.label,
        },
      };
    }));
  return options.sort((a, b) => a.totalMinutes - b.totalMinutes);
}

async function computeCrossingRoutes(crossingId, direction = 'toBih') {
  const crossing = BORDER_CROSSINGS[crossingId];
  if (!crossing) {
    const error = new Error(`Nepoznat prijelaz: ${crossingId}`);
    error.statusCode = 404;
    throw error;
  }
  const anchor = crossing.anchors[direction] || crossing.anchors.toBih;
  if (!anchor.routeGuard) {
    return routePendingPayload(crossing, direction, 'Za ovaj prijelaz zasad prikazujemo čekanje, kamere i prometni sloj. Cestovnu liniju ćemo uključiti čim prođe provjeru, da mapa ne bi pokazivala čudnu ili krivu putanju.');
  }

  // Resolve Google's route with progressively relaxed intermediate constraints.
  // For some motorway/bridge crossings (Bijača A1, Gornji Varoš A5 new bridge,
  // old Stara Gradiška bridge) Google returns ZERO_RESULTS when the borderPoint
  // is forced as a strict via-waypoint — the point may sit on a road segment
  // Google's routing engine treats as unreachable from arbitrary directions.
  // Crossings can opt out of the via-intermediate primary attempt by setting
  // routeGuard.useViaIntermediate === false; in that case we go straight to the
  // free approachStart → exitPoint request and rely on the looser pass-distance
  // check to validate that the polyline still threads the actual border zone.
  const useVia = anchor.routeGuard?.useViaIntermediate !== false;
  const retryWithoutVia = anchor.routeGuard?.retryWithoutVia !== false;

  // Request between the EXTENDED display anchors so the route covers more real road on both sides.
  // The route guard still validates the polyline against the precise approachStart/border/exitPoint.
  const reqOrigin = routeOriginAnchor(anchor);
  const reqDestination = routeDestinationAnchor(anchor);
  const attempts = [];
  if (useVia) {
    attempts.push({
      label: 'via-intermediate',
      body: routeRequest({
        origin: latLngWaypoint(reqOrigin),
        destination: latLngWaypoint(reqDestination),
        intermediates: [latLngWaypoint(anchor.borderPoint, { via: true })],
        alternatives: true,
      }),
    });
  }
  if (retryWithoutVia) {
    attempts.push({
      label: 'stopover-intermediate',
      body: routeRequest({
        origin: latLngWaypoint(reqOrigin),
        destination: latLngWaypoint(reqDestination),
        intermediates: [latLngWaypoint(anchor.borderPoint)],
        alternatives: true,
      }),
    });
  }
  // Final fallback: drop the borderPoint intermediate entirely. For short
  // crossings the natural approach → exit route always goes through the border
  // zone, and the route guard will validate the polyline against the calibrated
  // borderPoint anchor (within the configured passDistanceMeters tolerance).
  attempts.push({
    label: 'no-intermediate',
    body: routeRequest({
      origin: latLngWaypoint(reqOrigin),
      destination: latLngWaypoint(reqDestination),
      intermediates: [],
      alternatives: true,
    }),
  });

  let data = null;
  let lastError = null;
  for (const attempt of attempts) {
    try {
      data = await fetchRoutes(attempt.body);
      if (Array.isArray(data?.routes) && data.routes.length) break;
      // Treat empty-routes response the same as an error so we move to the next attempt.
      lastError = new Error(`Routes API ${attempt.label}: nije vratio rute.`);
      data = null;
    } catch (error) {
      lastError = error;
      data = null;
    }
  }
  if (!data) throw lastError || new Error('Routes API nije vratio rute ni za jedan pokušaj.');

  const rawRoutes = (data.routes || [])
    .map((route, index) => normalizeRoute(route, index, {
      id: `${crossing.id}-route-${index + 1}`,
      crossingId: crossing.id,
      crossingName: crossing.name,
      direction,
      zone: {
        from: anchor.fromLabel,
        border: crossing.name,
        to: anchor.toLabel,
        label: anchor.label,
      },
    }))
    .filter((route) => route.path.length);

  if (!rawRoutes.length) throw new Error('Routes API nije vratio upotrebljivu putanju.');

  const { accepted, rejected } = guardedRoutes(rawRoutes, crossing, direction, 'crossing');
  if (!accepted.length) {
    const reason = [...(rejected[0]?.routeGuard?.errors || []), ...(rejected[0]?.routeGuard?.warnings || [])].join('; ') || 'ruta nije prošla kroz ručno kalibrirane točke prijelaza';
    console.warn('[route-guard/rejected]', {
      crossingId: crossing.id,
      direction,
      reason,
      rejectedRoutes: rejected.map((route) => ({ id: route.id, distanceKm: route.distanceKm, routeGuard: route.routeGuard })),
    });
    const error = new Error(`Route guard odbio rutu za ${crossing.shortName}: ${reason}`);
    error.rejectedRoutes = rejected.map((route) => ({ id: route.id, distanceKm: route.distanceKm, routeGuard: route.routeGuard }));
    throw error;
  }

  const rankedAccepted = sortCrossingRoutesByAnchorFit(accepted, anchor);

  // Optional secondary routes (e.g. Vidovdanska side-street approach). Each variant
  // overrides approachStart and/or exitPoint while keeping the same borderPoint, so we
  // surface congestion on alternate corridors that share the same physical checkpoint.
  const variantSpecs = Array.isArray(anchor.additionalRoutes) ? anchor.additionalRoutes : [];
  const variantRoutes = [];
  for (const [variantIndex, variant] of variantSpecs.entries()) {
    const variantApproach = variant.approachStart || anchor.approachStart;
    const variantExit = variant.exitPoint || anchor.exitPoint;
    if (!variantApproach || !variantExit) continue;
    try {
      const variantData = await fetchRoutes(routeRequest({
        origin: latLngWaypoint(variantApproach),
        destination: latLngWaypoint(variantExit),
        intermediates: anchor.borderPoint ? [latLngWaypoint(anchor.borderPoint)] : [],
        alternatives: false,
      }));
      const variantRaw = (variantData?.routes || [])
        .map((route, index) => normalizeRoute(route, index, {
          id: `${crossing.id}-variant-${variantIndex + 1}-${index + 1}`,
          crossingId: crossing.id,
          crossingName: crossing.name,
          direction,
          variantLabel: variant.label,
          variantDescription: variant.description,
          zone: {
            from: variant.fromLabel || anchor.fromLabel,
            border: crossing.name,
            to: variant.toLabel || anchor.toLabel,
            label: variant.label || anchor.label,
          },
        }))
        .filter((route) => route.path.length);
      const { accepted: variantAccepted } = guardedRoutes(variantRaw, crossing, direction, 'crossing');
      if (variantAccepted.length) variantRoutes.push(variantAccepted[0]);
    } catch (variantError) {
      console.warn('[route-variant/failed]', { crossingId: crossing.id, direction, variant: variant.label, reason: variantError.message });
    }
  }

  const combinedRoutes = [...rankedAccepted, ...variantRoutes];
  const displayRoutes = combinedRoutes.map((route, index) => makeMapFriendlyControlZoneRoute({ ...route, primary: index === 0 }, anchor));
  // Honest traffic-availability flag: true only when Google actually returned speed-reading
  // intervals for at least one drawn route. When false the lines are plain blue because there
  // is no live density data — NOT because the road is provably clear. The UI uses this to say
  // "promet podaci nedostupni" instead of implying everything is flowing.
  const trafficAvailable = displayRoutes.some((route) => (route.trafficSegments || []).length > 0 || route.trafficSummary?.hasTrafficIntervals);

  return {
    ok: true,
    live: true,
    direction,
    crossingId: crossing.id,
    crossing: crossing.name,
    zone: {
      from: anchor.fromLabel,
      border: crossing.name,
      to: anchor.toLabel,
      label: anchor.label,
    },
    updatedAt: new Date().toISOString(),
    source: 'Google Routes API + route guard',
    displayMode: 'control_zone',
    trafficAvailable,
    note: rejected.length ? `${rejected.length} Google alternativa je odbačena jer ne prolazi kroz kalibrirane točke prijelaza. Na karti prikazujemo samo provjerenu zonu oko granice.` : 'Na karti prikazujemo samo provjerenu cestovnu zonu oko prijelaza, bez umjetnih početnih i završnih točaka.',
    rejectedRoutes: process.env.NODE_ENV === 'production' ? undefined : rejected.map((route) => ({ id: route.id, distanceKm: route.distanceKm, routeGuard: route.routeGuard })),
    routes: displayRoutes,
  };
}

async function computeJourneyOption(crossing, direction, originText, destinationText, vehicle) {
  const anchor = crossing.anchors[direction] || crossing.anchors.toBih;
  let data;
  try {
    data = await fetchRoutes(routeRequest({
      origin: addressWaypoint(originText),
      destination: addressWaypoint(destinationText),
      // Production route guard: for a trip via Maljevac/Gradiška we force the side-specific
      // approach, checkpoint and exit anchors in order. This prevents Google from using a
      // random nearby pin or a parallel local road as the crossing waypoint.
      intermediates: anchor.routeGuard ? [
        latLngWaypoint(anchor.approachStart, { via: true }),
        latLngWaypoint(anchor.borderPoint, { via: true }),
        latLngWaypoint(anchor.exitPoint, { via: true }),
      ] : [latLngWaypoint(anchor.borderPoint, { via: true })],
      alternatives: false,
    }));
  } catch (error) {
    if (!anchor.routeGuard || anchor.routeGuard?.retryWithoutVia === false) throw error;
    data = await fetchRoutes(routeRequest({
      origin: addressWaypoint(originText),
      destination: addressWaypoint(destinationText),
      intermediates: [
        latLngWaypoint(anchor.approachStart),
        latLngWaypoint(anchor.borderPoint),
        latLngWaypoint(anchor.exitPoint),
      ],
      alternatives: false,
    }));
  }

  const route = normalizeRoute(data.routes?.[0] || {}, 0, {
    id: `${crossing.id}-journey`,
    label: `Preko ${crossing.shortName}`,
    crossingId: crossing.id,
    crossingName: crossing.name,
    direction,
    zone: {
      from: anchor.fromLabel,
      border: crossing.name,
      to: anchor.toLabel,
      label: anchor.label,
    },
  });

  if (!route.path.length) throw new Error(`Nema putanje za ${crossing.shortName}`);
  const guard = validateRouteGuard(route, crossing, direction, 'journey');
  if (!guard.ok) throw new Error(`Ruta preko ${crossing.shortName} nije prošla route guard: ${[...(guard.errors || []), ...(guard.warnings || [])].join('; ')}`);

  const routeForSignal = { ...route, routeGuard: guard, routeQuality: 'verified' };
  const googleSource = buildGoogleSnapshotFromRoute(crossing, direction, {
    routes: [routeForSignal],
    source: 'Google Routes API',
    note: 'Svježa ruta iz usporedbe putovanja.',
  });
  const borderSignal = await effectiveBorderSignal(crossing, direction, vehicle, null, googleSource ? [googleSource] : []);
  const delayKnown = borderSignal.displayReady !== false && Number.isFinite(Number(borderSignal.wait));
  const delay = delayKnown ? Number(borderSignal.wait) : 0;
  return {
    id: crossing.id,
    crossingId: crossing.id,
    crossingName: crossing.name,
    shortName: crossing.shortName,
    direction,
    vehicle: vehicleKey(vehicle),
    routeDurationMinutes: route.durationMinutes,
    borderDelayMinutes: delayKnown ? delay : null,
    borderZastojMinutes: delayKnown ? delay : null,
    borderDelayKnown: delayKnown,
    waitUnknown: !delayKnown,
    borderSource: { label: borderSignal.label, sourceType: borderSignal.sourceType, confidence: borderSignal.confidence, note: borderSignal.note },
    totalMinutes: route.durationMinutes + delay,
    distanceKm: route.distanceKm,
    googleDelayMinutes: route.delayMinutes,
    level: delayKnown ? delayLevel(route.delayMinutes + Math.max(0, delay - 20), route.ratio) : delayLevel(route.delayMinutes, route.ratio),
    route: routeForSignal,
    routeGuard: guard,
    routeQuality: 'verified',
    zone: route.zone,
  };
}

function safeError(error) {
  return process.env.NODE_ENV === 'production' ? undefined : error.message;
}




app.get('/api/camera-image/:crossingId/:cameraId', async (req, res) => {
  const crossingId = String(req.params.crossingId || '').trim();
  const cameraId = String(req.params.cameraId || '').trim();
  if (!crossingId || !BORDER_CROSSINGS[crossingId]) {
    res.status(404).json({ ok: false, error: 'Prijelaz nije pronađen.' });
    return;
  }

  const camera = findKnownCamera(crossingId, cameraId);
  if (!camera?.url) {
    res.status(404).json({ ok: false, error: 'Kamera nije pronađena za ovaj prijelaz.' });
    return;
  }

  try {
    const image = await fetchCameraImage(camera, { timeoutMs: CAMERA_SNAPSHOT_TIMEOUT_MS });
    if (!String(image.contentType || '').startsWith('image/')) {
      res.status(502).json({ ok: false, note: 'Izvor kamere nije vratio sliku.' });
      return;
    }
    // Do not forward HAK's "invalid webcam" placeholder (PNG/GIF) to the UI — surface a
    // graceful "unavailable" so the client shows the offline state instead of a red error image.
    if (!isUsableCameraImage(image.buffer, image.contentType)) {
      res.status(502).json({ ok: false, note: 'Kamera trenutno nije dostupna (izvor vraća zamjensku sliku).' });
      return;
    }
    res.setHeader('Content-Type', image.contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=20, stale-while-revalidate=40');
    res.send(image.buffer);
  } catch (error) {
    console.warn('[camera-image-proxy]', crossingId, cameraId, error.message);
    res.status(502).json({ ok: false, note: 'Slika kamere trenutno nije dostupna.', error: safeError(error) });
  }
});

app.get('/api/camera-snapshots/:crossingId', async (req, res) => {
  const crossingId = String(req.params.crossingId || '').trim();
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';
  if (!crossingId || !BORDER_CROSSINGS[crossingId]) {
    res.status(404).json({ ok: false, error: 'Prijelaz nije pronađen.' });
    return;
  }
  const crossing = BORDER_CROSSINGS[crossingId];
  try {
    // Public endpoint only reads stored snapshots. Admin camera scan performs forced refresh.
    const snapshots = await readLatestCameraSnapshots(crossing.id, direction, Number(req.query.hours || 6) || 6);
    res.json({
      ok: true,
      crossingId: crossing.id,
      direction,
      countingEnabled: CAMERA_SNAPSHOT_COUNTING_ENABLED,
      source: datastoreMode === 'postgres' ? 'postgres-camera-snapshots' : 'memory-camera-snapshots',
      aggregate: aggregateCameraSnapshots(snapshots),
      snapshots,
    });
  } catch (error) {
    console.error('[camera-snapshots]', error);
    res.status(500).json({ ok: false, note: 'Snapshot očitanja trenutno nisu dostupna.', error: safeError(error) });
  }
});

app.get('/api/camera-analytics/:crossingId', async (req, res) => {
  const crossingId = String(req.params.crossingId || '').trim();
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';
  if (!crossingId || !BORDER_CROSSINGS[crossingId]) {
    res.status(404).json({ ok: false, error: 'Prijelaz nije pronađen.' });
    return;
  }

  try {
    res.json(await buildCameraAnalyticsPayload(crossingId, direction));
  } catch (error) {
    console.error('[camera-analytics]', error);
    res.status(500).json({ ok: false, live: false, note: 'Analitika kamera trenutno nije dostupna.', error: safeError(error) });
  }
});

app.get('/api/camera-history/:crossingId', async (req, res) => {
  const crossingId = String(req.params.crossingId || '').trim();
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';
  if (!crossingId || !BORDER_CROSSINGS[crossingId]) {
    res.status(404).json({ ok: false, error: 'Prijelaz nije pronađen.' });
    return;
  }
  const crossing = BORDER_CROSSINGS[crossingId];
  const history = historyWithCameraEvents(crossing, direction);
  const totals = sumCounts(history);
  const laneProfile = sumLaneGroupsFromEvents(getRecentCameraEvents(crossing.id, direction, 60));

  res.json({
    ok: true,
    live: true,
    crossingId: crossing.id,
    direction,
    updatedAt: new Date().toISOString(),
    totals,
    laneProfile,
    history,
  });
});

app.post('/api/camera-scan/:crossingId', authRequired, adminRequired, writeLimiter, async (req, res) => {
  const crossingId = String(req.params.crossingId || '').trim();
  const direction = req.body?.direction === 'toHr' ? 'toHr' : 'toBih';
  if (!crossingId || !BORDER_CROSSINGS[crossingId]) {
    res.status(404).json({ ok: false, error: 'Prijelaz nije pronađen.' });
    return;
  }

  try {
    // A manual scan must re-fetch the live frame, never reuse a 2–5 min cached snapshot.
    const payload = await buildCameraAnalyticsPayload(crossingId, direction, { storeScan: true, forceSnapshot: true });
    res.json({ ...payload, stored: true });
  } catch (error) {
    console.error('[camera-scan]', error);
    res.status(500).json({ ok: false, live: false, note: 'Očitanje kamera trenutno nije dostupno.', error: safeError(error) });
  }
});

app.post('/api/camera-ingest', writeLimiter, (req, res) => {
  const incomingApiKey = String(req.headers['x-api-key'] || '').trim();
  if (!cameraIngestApiKey || incomingApiKey !== cameraIngestApiKey) {
    return res.status(401).json({ ok: false, note: 'API ključ je potreban za ingest.' });
  }

  const crossingId = String(req.body.crossingId || '').trim();
  const direction = req.body.direction === 'toHr' ? 'toHr' : 'toBih';
  const cameraId = String(req.body.cameraId || '').trim();
  const counts = normalizeCounts(req.body.counts || {});
  const laneGroups = normalizeLaneGroups(req.body.laneGroups || req.body.lanes || {});
  const timestamp = parseIngestTimestamp(req.body.timestamp);

  if (!crossingId || !BORDER_CROSSINGS[crossingId]) {
    res.status(400).json({ ok: false, note: 'Nepoznat granični prijelaz.' });
    return;
  }

  if (!cameraId || !isKnownCamera(crossingId, cameraId)) {
    res.status(400).json({ ok: false, note: 'Nepoznata kamera za odabrani prijelaz.' });
    return;
  }

  if (!timestamp) {
    res.status(400).json({ ok: false, note: 'Neispravan timestamp očitanja.' });
    return;
  }

  if (countPayloadTooLarge(counts)) {
    res.status(400).json({ ok: false, note: 'Očitanje je izvan očekivanog raspona.' });
    return;
  }

  cameraEvents.push({
    crossingId,
    direction,
    cameraId,
    counts,
    laneGroups,
    timestamp: timestamp.toISOString(),
  });

  // Keep the in-memory buffer bounded for local deployments. Production can persist the same event shape to Postgres/TimescaleDB.
  while (cameraEvents.length > 5000) cameraEvents.shift();

  res.json({ ok: true, stored: true, totalEvents: cameraEvents.length });
});

app.get('/api/routes/:crossingId', async (req, res) => {
  const crossingId = String(req.params.crossingId || '').trim();
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';

  if (!crossingId || !BORDER_CROSSINGS[crossingId]) {
    res.status(404).json({ ok: false, error: 'Prijelaz nije pronađen.' });
    return;
  }
  const crossing = BORDER_CROSSINGS[crossingId];
  const store = await readAppStore();
  const statusOverride = getStoredStatusOverride(store, crossing.id, direction);
  const statusPayload = statusOverrideRoutePayload(crossing, direction, statusOverride);
  if (statusPayload) {
    res.json(statusPayload);
    return;
  }

  if (!serverKey) {
    res.json(buildFallbackCrossingRoute(crossing, direction, 'Google Routes ključ nije postavljen; rutu ne crtamo da ne bismo prikazali liniju izvan stvarne ceste.'));
    return;
  }

  try {
    const payload = await computeCrossingRoutes(crossingId, direction);
    // Production reliability: whenever a user opens a crossing we just fetched fresh
    // Google traffic data for it. Persist that as a Google source snapshot so the wait
    // estimator stops relying on an aged scheduler snapshot (previously the route panel
    // showed a 1-min blue road while the wait still said 45 min from an 8h-old run).
    try {
      const googleSnap = buildGoogleSnapshotFromRoute(crossing, direction, payload);
      if (googleSnap) await insertSourceSnapshots([googleSnap]);
    } catch (snapErr) {
      console.warn('[routes-api/google-snapshot-cache]', snapErr.message);
    }
    res.json(payload);
  } catch (error) {
    console.error('[routes-api]', error);
    if (isLikelyClosedOrBlockedRoute(error, crossing, direction) && crossing.routeStatusHint?.replacementCrossingId) {
      res.json(routeClosedPayload(crossing, direction, 'Stara ruta preko ovog prijelaza ne vraća pouzdanu putanju. Ako ideš na područje Gradiške, koristi novi prijelaz Gornji Varoš / Gradiška Novi Most.', {
        error: safeError(error),
      }));
      return;
    }

    // Gradiška-specific guard: when Google cannot return a real cross-border route
    // (e.g. old bridge closed / construction), the calibrated control zone is
    // misleading because users see a zig-zag local path. Mark the route as
    // unavailable and point users at Gornji Varoš instead of drawing a zone.
    if (crossing.id === 'gradiska' && isLikelyClosedOrBlockedRoute(error, crossing, direction)) {
      const replacement = BORDER_CROSSINGS['gornji-varos'];
      const replacementAnchor = replacement?.anchors?.[direction] || replacement?.anchors?.toBih || {};
      const payload = routeClosedPayload(
        crossing,
        direction,
        'Ruta preko Gradiške trenutno nije dostupna — moguće je da je most zatvoren ili Google ne može izračunati legalan prelazak. Koristi Gornji Varoš (Novi Most) ako ideš na područje Gradiške.',
        {
          error: safeError(error),
          source: 'routes-api-gradiska-unavailable',
          routeStatus: 'route_unavailable',
        }
      );
      if (replacement) {
        payload.suggestedCrossing = {
          crossingId: replacement.id,
          crossingName: replacement.name,
          shortName: replacement.shortName,
          label: `Prikaži ${replacement.shortName}`,
          zone: {
            from: replacementAnchor.fromLabel,
            border: replacement.name,
            to: replacementAnchor.toLabel,
            label: replacementAnchor.label,
          },
        };
      }
      res.json(payload);
      return;
    }

    res.json(buildCalibratedControlZoneRoute(crossing, direction, 'Google Routes/route guard trenutno nisu vratili sigurnu cestovnu putanju, ali prijelaz ne označavamo kao zatvoren. Prikazujemo ručno kalibriranu zonu dok Google ne vrati validnu lokalnu rutu.', {
      source: 'routes-api-calibrated-fallback',
      error: safeError(error),
    }));
  }
});

app.get('/api/trip-options', async (req, res) => {
  const origin = String(req.query.origin || '').trim();
  const destination = String(req.query.destination || '').trim();
  const requestedDirection = req.query.direction === 'toHr' ? 'toHr' : req.query.direction === 'toBih' ? 'toBih' : null;
  // Explicit direction from the query must win. Only fall back to text inference when the
  // caller did not state a direction — otherwise we would silently swap HR→BiH and BiH→HR
  // for an Osijek→Tuzla style trip just because of a place-name hit.
  const direction = requestedDirection || inferJourneyDirection(origin, destination) || 'toBih';
  const vehicle = vehicleKey(req.query.vehicle);

  if (!origin || !destination) {
    res.status(400).json({ ok: false, note: 'Unesi polazište i odredište.', options: [] });
    return;
  }

  if (!serverKey) {
    const options = await buildFallbackJourneyOptions(direction, vehicle, origin, destination);
    res.json({
      ok: true,
      live: false,
      origin,
      destination,
      direction,
      vehicle,
      updatedAt: new Date().toISOString(),
      options,
      best: options[0] || null,
      note: 'Google Routes ključ nije postavljen; rute su procjena, a čekanje se prikazuje samo ako postoji live izvor/admin/dojava/kamera.',
    });
    return;
  }

  const crossings = Object.values(BORDER_CROSSINGS);
  const results = await Promise.allSettled(
    crossings.map((crossing) => computeJourneyOption(crossing, direction, origin, destination, vehicle))
  );

  const options = results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
    .sort((a, b) => a.totalMinutes - b.totalMinutes);

  const finalOptions = options.length ? options : await buildFallbackJourneyOptions(direction, vehicle, origin, destination);

  res.json({
    ok: finalOptions.length > 0,
    live: options.length > 0,
    origin,
    destination,
    direction,
    vehicle,
    updatedAt: new Date().toISOString(),
    options: finalOptions,
    best: finalOptions[0] || null,
    failures: process.env.NODE_ENV === 'production' ? undefined : results.filter((result) => result.status === 'rejected').map((result) => result.reason?.message || String(result.reason)),
    note: options.length ? 'Usporedba ruta je ažurirana.' : 'Google Routes nije vratio rute; čekanje se prikazuje samo ako postoji live izvor/admin/dojava/kamera.',
  });
});

// Backward-compatible endpoint used by older UI parts.
app.get('/api/traffic/maljevac', async (req, res) => {
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';
  if (!serverKey) {
    res.json({ ...routeUnavailablePayload('Route integracija trenutno nije dostupna.', { direction, crossingId: 'maljevac' }), segments: [] });
    return;
  }
  try {
    const payload = await computeCrossingRoutes('maljevac', direction);
    res.json({ ...payload, segments: [] });
  } catch (error) {
    console.error('[traffic-api]', error);
    res.json({ ...routeUnavailablePayload('Route integracija trenutno nije dostupna.', { direction, crossingId: 'maljevac' }), segments: [], error: safeError(error) });
  }
});

const distPath = path.resolve(__dirname, '..', 'dist');
app.use(express.static(distPath));
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) next(err);
  });
});

export {
  app,
  initializeDatastore,
  // Exposed for unit tests of pure helpers (no I/O).
  parseDirectionalWaitsFromText,
  isSoftUpperBoundSource,
  sanitizeLegacyPublicSignal,
  applyTrafficSanityCaps,
  googleLooksClear,
  googleLooksSlow,
  googleLooksHeavy,
  cameraLooksClear,
  cameraShowsQueue,
  ageDecayMultiplier,
  trimmedMeanCameraSignal,
  crossSourceAgreement,
  emaSmoothWait,
  isUsableCameraImage,
  withHakImageFallbacks,
  CAMERA_FEEDS,
  BORDER_CROSSINGS,
  PUBLIC_SOURCE_TARGETS,
  effectiveBorderSignal,
  estimateCameraFlowFromSnapshot,
  analyzeSnapshotImage,
  buildCameraAnalyticsPayload,
  inferCameraDirections,
  cameraRelevantForDirection,
  buildCameraAudit,
  // Public-source text parsing (exposed for unit tests — the HAK/BIHAMK blob bleed bug).
  extractBihamkSection,
  allPublicSourceNames,
  // Snapshot hygiene + CV/YOLO (exposed for unit tests).
  isSuspiciousLegacyPublicSnapshot,
  pruneSuspiciousPublicSourceSnapshots,
  runYoloDetector,
  // Google traffic-aware route helpers (exposed for unit tests).
  buildTrafficSegments,
  buildTrafficSummary,
  extractSpeedReadingIntervals,
  remapSpeedReadingIntervals,
  makeMapFriendlyControlZoneRoute,
  routeOriginAnchor,
  routeDestinationAnchor,
  // Exposed for integration tests (mint an admin token against the seeded admin user).
  signToken,
};

function assertProductionSafety() {
  if (process.env.NODE_ENV !== 'production') return;
  const blockers = [];
  if (sessionSecret === weakDefaultSecret) {
    blockers.push('SESSION_SECRET nije postavljen — koristi se razvojna vrijednost. Postavi dugačak slučajan secret prije production deploya.');
  }
  const adminPass = process.env.BORDERFLOW_ADMIN_PASSWORD || '';
  if (!adminPass || adminPass === 'change-this-admin-password') {
    blockers.push('BORDERFLOW_ADMIN_PASSWORD nije postavljen ili koristi default vrijednost. Postavi jak admin password.');
  }
  if (process.env.BORDERFLOW_DEMO_USER_PASSWORD === 'change-this-user-password') {
    blockers.push('BORDERFLOW_DEMO_USER_PASSWORD koristi default vrijednost. Promijeni ili ukloni demo user seed prije production deploya.');
  }
  if (allowPublicRegistration) {
    console.warn('[startup] ALLOW_PUBLIC_REGISTRATION=true u produkciji — svatko može stvoriti račun. Razmisli o isključivanju.');
  }
  if (!configuredCorsOrigins.length) {
    console.warn('[startup] CORS_ORIGINS nije postavljen — API prihvaća zahtjeve s bilo kojeg originala. Za produkciju postavi popis dopuštenih domena (npr. CORS_ORIGINS=https://prijelazradar.hr).');
  }
  if (!serverKey) {
    console.warn('[startup] GOOGLE_MAPS_SERVER_KEY nije postavljen — Google rute neće raditi, prikazuju se samo kalibrirane/fallback zone.');
  }
  if (blockers.length) {
    console.error('\n[startup] Production safety check FAILED:');
    for (const blocker of blockers) console.error('  - ' + blocker);
    console.error('\nAplikacija se neće pokrenuti dok se ovi blokeri ne riješe.\n');
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  assertProductionSafety();
  initializeDatastore()
    .then(() => {
      app.listen(port, () => {
        console.log(`PrijelazRadar backend running on http://localhost:${port}`);
        console.log(`Datastore: ${datastoreMode}`);
        console.log(serverKey ? 'Routes API server key: configured' : 'Routes API server key: missing');
        // Shed any stale/legacy snapshots left over from before this deploy (auto cleanup):
        // age-based prune + the suspicious legacy public-text bleed artifacts from the old parser.
        pruneStaleSourceSnapshots().then((n) => { if (n) console.log(`[prune-source-snapshots] removed ${n} stale snapshot(s) on startup`); }).catch(() => {});
        if (PRUNE_SUSPICIOUS_PUBLIC_SNAPSHOTS) pruneSuspiciousPublicSourceSnapshots().catch(() => {});
        // Config-based camera sanity report (no network) — surfaces which cameras must be
        // manually configured (ROI / direction) before YOLO + ROI, and which are wait-capable.
        buildCameraAudit({ configOnly: true }).then(({ summary, all }) => {
          const needConfig = all.filter((c) => c.warnings.includes('missing_queue_roi') || c.warnings.includes('direction_not_verified'));
          console.log(`[camera-audit] ${summary.uniqueCameras} cameras / ${summary.totalEntries} camera×direction entries`);
          console.log(`[camera-audit] config wait-capable: ${summary.waitCapable} · visual-only: ${summary.visualOnly} · missing ROI: ${summary.missingQueueRoi} · direction unverified: ${all.filter((c) => c.warnings.includes('direction_not_verified')).length}`);
          if (needConfig.length) console.log('[camera-audit] needs manual config before YOLO+ROI:', [...new Set(needConfig.map((c) => `${c.crossingId}/${c.cameraId}`))].join(', '));
        }).catch((e) => console.warn('[camera-audit] startup report failed:', e.message));
      });
    })
    .catch((error) => {
      console.error('[startup] Datastore initialization failed:', error);
      process.exit(1);
    });
}
