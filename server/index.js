import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import jpeg from 'jpeg-js';
import { fileURLToPath } from 'url';

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
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
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
      toBih: {
        label: 'HR → BiH',
        fromLabel: 'Maljevac · HR prilaz kontroli',
        toLabel: 'Velika Kladuša · BiH izlaz iz kontrole',
        approachStart: { lat: 45.19985, lng: 15.79042 },
        borderPoint: { lat: 45.19583, lng: 15.79639 },
        exitPoint: { lat: 45.19295, lng: 15.80155 },
        routeGuard: { maxCrossingDistanceKm: 2.8, hardMaxCrossingDistanceKm: 5.5, passDistanceMeters: 500, validateApproachExit: true, displayBeforeMeters: 650, displayAfterMeters: 850 },
      },
      toHr: {
        label: 'BiH → HR',
        fromLabel: 'Velika Kladuša · BiH prilaz kontroli',
        toLabel: 'Maljevac · HR izlaz iz kontrole',
        approachStart: { lat: 45.19295, lng: 15.80155 },
        borderPoint: { lat: 45.19583, lng: 15.79639 },
        exitPoint: { lat: 45.19985, lng: 15.79042 },
        routeGuard: { maxCrossingDistanceKm: 2.8, hardMaxCrossingDistanceKm: 5.5, passDistanceMeters: 500, validateApproachExit: true, displayBeforeMeters: 650, displayAfterMeters: 850 },
      },
    },
  },
  gradiska: {
    id: 'gradiska',
    name: 'GP Gradiška',
    shortName: 'Gradiška',
    routeStatusHint: {
      replacementCrossingId: 'gornji-varos',
      message: 'Ako stari most/ruta Stara Gradiška nije prohodna, korisniku se nudi novi most Gornji Varoš – Gradiška.',
    },
    waits: {
      toBih: { car: 32, truck: 65, bus: 42 },
      toHr: { car: 40, truck: 80, bus: 55 },
    },
    anchors: {
      toBih: {
        label: 'HR → BiH',
        fromLabel: 'Stara Gradiška · HR prilaz',
        toLabel: 'Gradiška · BiH izlaz',
        approachStart: { lat: 45.15084, lng: 17.24510 },
        borderPoint: { lat: 45.14720, lng: 17.25040 },
        exitPoint: { lat: 45.14267, lng: 17.25690 },
        routeGuard: { maxCrossingDistanceKm: 12, hardMaxCrossingDistanceKm: 24, passDistanceMeters: 700, validateApproachExit: true },
      },
      toHr: {
        label: 'BiH → HR',
        fromLabel: 'Gradiška · BiH prilaz',
        toLabel: 'Stara Gradiška · HR izlaz',
        approachStart: { lat: 45.14267, lng: 17.25690 },
        borderPoint: { lat: 45.14720, lng: 17.25040 },
        exitPoint: { lat: 45.15084, lng: 17.24510 },
        routeGuard: { maxCrossingDistanceKm: 12, hardMaxCrossingDistanceKm: 24, passDistanceMeters: 700, validateApproachExit: true },
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
      toBih: {
        label: 'HR → BiH',
        fromLabel: 'Gornji Varoš · HR prilaz',
        toLabel: 'Gradiška Novi Most · BiH izlaz',
        approachStart: { lat: 45.1572, lng: 17.2014 },
        borderPoint: { lat: 45.1500, lng: 17.2170 },
        exitPoint: { lat: 45.1426, lng: 17.2320 },
        routeGuard: { maxCrossingDistanceKm: 7, hardMaxCrossingDistanceKm: 16, passDistanceMeters: 850, validateApproachExit: true, displayBeforeMeters: 950, displayAfterMeters: 1250 },
      },
      toHr: {
        label: 'BiH → HR',
        fromLabel: 'Gradiška Novi Most · BiH prilaz',
        toLabel: 'Gornji Varoš · HR izlaz',
        approachStart: { lat: 45.1426, lng: 17.2320 },
        borderPoint: { lat: 45.1500, lng: 17.2170 },
        exitPoint: { lat: 45.1572, lng: 17.2014 },
        routeGuard: { maxCrossingDistanceKm: 7, hardMaxCrossingDistanceKm: 16, passDistanceMeters: 850, validateApproachExit: true, displayBeforeMeters: 950, displayAfterMeters: 1250 },
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
      toBih: {
        label: 'HR → BiH',
        fromLabel: 'Nova Sela · HR prilaz',
        toLabel: 'Bijača · BiH izlaz',
        approachStart: { lat: 43.12390, lng: 17.55400 },
        borderPoint: { lat: 43.12340, lng: 17.56780 },
        exitPoint: { lat: 43.12300, lng: 17.58200 },
        routeGuard: { maxCrossingDistanceKm: 6, hardMaxCrossingDistanceKm: 14, passDistanceMeters: 700, validateApproachExit: true, displayBeforeMeters: 950, displayAfterMeters: 1150 },
      },
      toHr: {
        label: 'BiH → HR',
        fromLabel: 'Bijača · BiH prilaz',
        toLabel: 'Nova Sela · HR izlaz',
        approachStart: { lat: 43.12300, lng: 17.58200 },
        borderPoint: { lat: 43.12340, lng: 17.56780 },
        exitPoint: { lat: 43.12390, lng: 17.55400 },
        routeGuard: { maxCrossingDistanceKm: 6, hardMaxCrossingDistanceKm: 14, passDistanceMeters: 700, validateApproachExit: true, displayBeforeMeters: 950, displayAfterMeters: 1150 },
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
    { id: 'gra-hak-page', label: 'Bosanska Gradiška / HAK', source: 'HAK', url: 'https://m.hak.hr/kamera.asp?g=2&k=185' },
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
      url: 'https://m.hak.hr/kamera.asp?g=2&k=303',
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
      url: 'https://m.hak.hr/kamera.asp?g=2&k=303',
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
    { id: 'bij-hak-page', label: 'Nova Sela / Bijača', source: 'HAK', url: 'https://m.hak.hr/kamera.asp?g=2&k=137' },
  ],
};


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
  maxCrossingDistanceKm: 6,
  hardMaxCrossingDistanceKm: 14,
  passDistanceMeters: 750,
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

function addCrossing({ id, name, shortName, lat, lng, waits, hrLabel, bihLabel, cameras, anchors }) {
  BORDER_CROSSINGS[id] = {
    id,
    name,
    shortName,
    waits,
    anchors: anchors || routeAnchors(lat, lng, hrLabel, bihLabel, name),
  };
  CAMERA_FEEDS[id] = cameras.map((camera) => ({
    source: 'HAK',
    ...camera,
    calibration: camera.calibration || {
      roi: { x: 14, y: 18, w: 74, h: 66, rotate: -10 },
      queueAnchor: { x: 58, y: 62 },
      countLine: { x1: 14, y1: 74, x2: 86, y2: 40, label: 'linija prolaska' },
      baselineFrame: { cars: 5, vans: 1, trucks: 1, buses: 0 },
    },
  }));
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
        routeGuard: { maxCrossingDistanceKm: 6, hardMaxCrossingDistanceKm: 14, passDistanceMeters: 750, validateApproachExit: true, displayBeforeMeters: 900, displayAfterMeters: 1100 },
      },
      toHr: {
        label: 'BiH → HR',
        fromLabel: 'Orašje · BiH prilaz kontroli',
        toLabel: 'Županja · HR izlaz iz kontrole',
        approachStart: { lat: 45.0315, lng: 18.7028 },
        borderPoint: { lat: 45.0405, lng: 18.7030 },
        exitPoint: { lat: 45.0508, lng: 18.7028 },
        routeGuard: { maxCrossingDistanceKm: 6, hardMaxCrossingDistanceKm: 14, passDistanceMeters: 750, validateApproachExit: true, displayBeforeMeters: 900, displayAfterMeters: 1100 },
      },
    },
    cameras: [
      { id: 'ora-hak-zupanja', label: 'Županja', url: 'https://m.hak.hr/kamera.asp?g=2&k=44' },
      { id: 'ora-hak-bih', label: 'BIH Orašje', url: 'https://m.hak.hr/kamera.asp?g=2&k=183' },
      { id: 'ora-bihamk', label: 'Orašje / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere' },
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
        routeGuard: { maxCrossingDistanceKm: 6, hardMaxCrossingDistanceKm: 14, passDistanceMeters: 750, validateApproachExit: true, displayBeforeMeters: 950, displayAfterMeters: 1150 },
      },
      toHr: {
        label: 'BiH → HR',
        fromLabel: 'Brod · BiH prilaz kontroli',
        toLabel: 'Slavonski Brod · HR izlaz iz kontrole',
        approachStart: { lat: 45.1395, lng: 18.0028 },
        borderPoint: { lat: 45.1497, lng: 18.0033 },
        exitPoint: { lat: 45.1597, lng: 18.0035 },
        routeGuard: { maxCrossingDistanceKm: 6, hardMaxCrossingDistanceKm: 14, passDistanceMeters: 750, validateApproachExit: true, displayBeforeMeters: 950, displayAfterMeters: 1150 },
      },
    },
    cameras: [
      { id: 'bro-hak-slavonski', label: 'Slavonski Brod', url: 'https://m.hak.hr/kamera.asp?g=2&k=140' },
      { id: 'bro-hak-bih', label: 'BIH Bosanski Brod', url: 'https://m.hak.hr/kamera.asp?g=2&k=184' },
      { id: 'bro-bihamk', label: 'Brod / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere' },
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
      guard: { maxCrossingDistanceKm: 5, hardMaxCrossingDistanceKm: 12, passDistanceMeters: 700, displayBeforeMeters: 800, displayAfterMeters: 1000 },
    }),
    cameras: [{ id: 'sam-hak', label: 'Slavonski Šamac', url: 'https://m.hak.hr/kamera.asp?g=2&k=300' }],
  },
  {
    id: 'svilaj', name: 'GP Svilaj', shortName: 'Svilaj', lat: 45.10810, lng: 18.31310, hrLabel: 'Svilaj', bihLabel: 'Odžak',
    waits: { toBih: { car: 20, truck: 50, bus: 25 }, toHr: { car: 26, truck: 58, bus: 30 } },
    // Corridor Vc bridge calibration: Svilaj HR checkpoint ≈ 45.11475,18.32206; Svilaj/Odžak BiH checkpoint ≈ 45.10147,18.30414.
    anchors: calibratedAnchors({
      hrLabel: 'Svilaj', bihLabel: 'Odžak',
      approachHr: { lat: 45.11475, lng: 18.32206 },
      borderPoint: { lat: 45.10810, lng: 18.31310 },
      exitBih: { lat: 45.10147, lng: 18.30414 },
      guard: { maxCrossingDistanceKm: 7, hardMaxCrossingDistanceKm: 16, passDistanceMeters: 900, displayBeforeMeters: 1000, displayAfterMeters: 1300 },
    }),
    cameras: [{ id: 'svi-hak', label: 'Svilaj', url: 'https://m.hak.hr/kamera.asp?g=2&k=211' }],
  },
  {
    id: 'izacic', name: 'GP Izačić', shortName: 'Izačić', lat: 44.87558, lng: 15.76418, hrLabel: 'Ličko Petrovo Selo', bihLabel: 'Izačić',
    waits: { toBih: { car: 36, truck: 62, bus: 44 }, toHr: { car: 78, truck: 115, bus: 86 } },
    anchors: calibratedAnchors({
      hrLabel: 'Ličko Petrovo Selo', bihLabel: 'Izačić',
      approachHr: { lat: 44.87770, lng: 15.76120 },
      borderPoint: { lat: 44.87558, lng: 15.76418 },
      exitBih: { lat: 44.87335, lng: 15.76665 },
      guard: { maxCrossingDistanceKm: 4, hardMaxCrossingDistanceKm: 10, passDistanceMeters: 650, displayBeforeMeters: 700, displayAfterMeters: 900 },
    }),
    cameras: [
      { id: 'iza-hak-bih', label: 'BIH Izačić', url: 'https://m.hak.hr/kamera.asp?g=2&k=179' },
      { id: 'iza-bihamk', label: 'Izačić / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere' },
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
      guard: { maxCrossingDistanceKm: 5, hardMaxCrossingDistanceKm: 12, passDistanceMeters: 750, displayBeforeMeters: 850, displayAfterMeters: 1050 },
    }),
    cameras: [
      { id: 'kam-hak', label: 'Kamensko', url: 'https://m.hak.hr/kamera.asp?g=2&k=192' },
      { id: 'kam-bihamk', label: 'Kamensko / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere' },
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
      guard: { maxCrossingDistanceKm: 5, hardMaxCrossingDistanceKm: 12, passDistanceMeters: 750, displayBeforeMeters: 800, displayAfterMeters: 1050 },
    }),
    cameras: [
      { id: 'pri-hak-arzano', label: 'Aržano', url: 'https://m.hak.hr/kamera.asp?g=2&k=193' },
      { id: 'pri-hak-bih', label: 'BIH Prisika', url: 'https://m.hak.hr/kamera.asp?g=2&k=180' },
      { id: 'pri-bihamk', label: 'Prisika / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere' },
    ],
  },
  {
    id: 'vinjani-donji', name: 'GP Vinjani Donji', shortName: 'Vinjani Donji', lat: 43.42261, lng: 17.27443, hrLabel: 'Vinjani Donji', bihLabel: 'Gorica',
    waits: { toBih: { car: 37, truck: 58, bus: 42 }, toHr: { car: 29, truck: 52, bus: 34 } },
    anchors: calibratedAnchors({
      hrLabel: 'Vinjani Donji', bihLabel: 'Gorica',
      approachHr: { lat: 43.42261, lng: 17.27443 },
      borderPoint: { lat: 43.42235, lng: 17.27500 },
      exitBih: { lat: 43.42210, lng: 17.27561 },
      guard: { maxCrossingDistanceKm: 3, hardMaxCrossingDistanceKm: 8, passDistanceMeters: 600, displayBeforeMeters: 600, displayAfterMeters: 750 },
    }),
    cameras: [{ id: 'vd-hak', label: 'Vinjani Donji', url: 'https://m.hak.hr/kamera.asp?g=2&k=39' }],
  },
  {
    id: 'vinjani-gornji', name: 'GP Vinjani Gornji', shortName: 'Vinjani Gornji', lat: 43.45998, lng: 17.28453, hrLabel: 'Vinjani Gornji', bihLabel: 'Orahovlje',
    waits: { toBih: { car: 24, truck: 42, bus: 28 }, toHr: { car: 27, truck: 46, bus: 30 } },
    anchors: calibratedAnchors({
      hrLabel: 'Vinjani Gornji', bihLabel: 'Orahovlje',
      approachHr: { lat: 43.45998, lng: 17.28453 },
      borderPoint: { lat: 43.45945, lng: 17.28610 },
      exitBih: { lat: 43.45895, lng: 17.28765 },
      guard: { maxCrossingDistanceKm: 4, hardMaxCrossingDistanceKm: 10, passDistanceMeters: 650, displayBeforeMeters: 700, displayAfterMeters: 850 },
    }),
    cameras: [{ id: 'vg-hak', label: 'Vinjani Gornji', url: 'https://m.hak.hr/kamera.asp?g=2&k=282' }],
  },
  {
    id: 'crveni-grm', name: 'GP Crveni Grm', shortName: 'Crveni Grm', lat: 43.16035, lng: 17.47755, hrLabel: 'Prolog', bihLabel: 'Crveni Grm',
    waits: { toBih: { car: 26, truck: 48, bus: 30 }, toHr: { car: 33, truck: 54, bus: 36 } },
    anchors: calibratedAnchors({
      hrLabel: 'Prolog', bihLabel: 'Crveni Grm',
      approachHr: { lat: 43.15920, lng: 17.47690 },
      borderPoint: { lat: 43.16035, lng: 17.47755 },
      exitBih: { lat: 43.16154, lng: 17.47846 },
      guard: { maxCrossingDistanceKm: 4, hardMaxCrossingDistanceKm: 10, passDistanceMeters: 650, displayBeforeMeters: 700, displayAfterMeters: 900 },
    }),
    cameras: [
      { id: 'cg-hak-bih', label: 'BIH Crveni Grm', url: 'https://m.hak.hr/kamera.asp?g=2&k=181' },
      { id: 'cg-bihamk', label: 'Crveni Grm / BIHAMK', source: 'BIHAMK', url: 'https://bihamk.ba/spi/kamere' },
    ],
  },
].forEach(addCrossing);

const cameraEvents = [];
const cameraSnapshotBuffer = [];
const cvEndpoint = process.env.CAMERA_CV_ENDPOINT || '';
const cvApiKey = process.env.CAMERA_CV_API_KEY || '';
const CAMERA_SNAPSHOT_COUNTING_ENABLED = process.env.CAMERA_SNAPSHOT_COUNTING_ENABLED !== 'false';
const CAMERA_SNAPSHOT_TIMEOUT_MS = Math.max(1500, Number(process.env.CAMERA_SNAPSHOT_TIMEOUT_MS || 4500));
const CAMERA_SNAPSHOT_MIN_CONFIDENCE = Math.max(35, Math.min(95, Number(process.env.CAMERA_SNAPSHOT_MIN_CONFIDENCE || 46)));
const CAMERA_SNAPSHOT_REFRESH_INTERVAL_MS = Math.max(2, Number(process.env.CAMERA_SNAPSHOT_REFRESH_INTERVAL_MINUTES || 5)) * 60 * 1000;

const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyPrefix: 'auth' });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 45, keyPrefix: 'write' });

const SOURCE_FETCH_ENABLED = process.env.SOURCE_FETCH_ENABLED !== 'false';
const SOURCE_REFRESH_INTERVAL_MS = Math.max(2, Number(process.env.SOURCE_REFRESH_INTERVAL_MINUTES || 10)) * 60 * 1000;
const SOURCE_FETCH_TIMEOUT_MS = Math.max(1500, Number(process.env.SOURCE_FETCH_TIMEOUT_MS || 4500));
let sourceRefreshState = { lastRunAt: 0, running: null, lastError: '' };

const PUBLIC_SOURCE_TARGETS = {
  maljevac: {
    bihamkNames: ['Velika Kladuša', 'GP Velika Kladuša', 'Maljevac', 'VELIKA KLADUŠA - MALJEVAC'],
    preferred: ['BIHAMK', 'Google Routes', 'Kamera'],
  },
  gradiska: {
    bihamkNames: ['Gradiška', 'Gradiska', 'GP Gradiška', 'Gradina'],
    preferred: ['BIHAMK', 'AMS RS', 'Google Routes', 'Kamera'],
    amsRsUrl: 'https://ams-rs.com/granicni-prelaz-gradiska/',
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
        'User-Agent': 'PrijelazRadar/1.0 staging-pilot (+https://borderflow.local)',
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

function extractBihamkSection(text, names = []) {
  const normalized = normalizeAscii(text);
  const namePositions = names
    .map((name) => normalizeAscii(name))
    .map((name) => normalized.indexOf(name))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  if (!namePositions.length) return '';
  const start = Math.max(0, namePositions[0] - 80);
  const after = normalized.slice(namePositions[0] + 8);
  const nextGpRelative = after.search(/\bgp\s+[a-z]/i);
  const end = nextGpRelative > 120 ? namePositions[0] + 8 + nextGpRelative : Math.min(text.length, namePositions[0] + 760);
  return text.slice(start, end).trim();
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
  if (/pojacan\w*\s+(?:je\s+)?izlaz/.test(normalized)) push(exitDirection, 45, sourceSide === 'hr' ? 'Pojačan izlaz iz HR' : 'Pojačan izlaz iz BiH/RS', 76, 1.05);
  if (/pojacan\w*\s+(?:je\s+)?ulaz/.test(normalized)) push(entryDirection, 45, sourceSide === 'hr' ? 'Pojačan ulaz u HR' : 'Pojačan ulaz u BiH/RS', 76, 1.05);

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
  Object.entries(PUBLIC_SOURCE_TARGETS).forEach(([crossingId, config]) => {
    const section = extractBihamkSection(text, config.bihamkNames || []);
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
        metadata: { adapter: 'bihamk-border-status', crossingNames: config.bihamkNames || [], ...(signal.metadata || {}) },
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
  Object.entries(PUBLIC_SOURCE_TARGETS).forEach(([crossingId, config]) => {
    const names = config.hakNames || config.bihamkNames || [];
    const section = extractBihamkSection(text, names);
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
        metadata: { adapter: 'hak-border-status', crossingNames: names, sourceSide: 'hr', ...(signal.metadata || {}) },
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
      metadata: { adapter: 'ams-rs-border-status', crossingNames: config.bihamkNames || [], sourceSide: 'bih-rs', scopeNote: 'AMS RS signal is treated as RS-side only, not a full BiH-wide official status.', ...(signal.metadata || {}) },
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

async function buildCameraSourceSnapshots() {
  const targets = Object.values(BORDER_CROSSINGS).filter((crossing) => (CAMERA_FEEDS[crossing.id] || []).length);
  const jobs = [];
  for (const crossing of targets) {
    for (const direction of ['toBih', 'toHr']) jobs.push({ crossingId: crossing.id, direction });
  }
  const results = await Promise.allSettled(jobs.map(async ({ crossingId, direction }) => {
    const payload = await buildCameraAnalyticsPayload(crossingId, direction, { storeScan: true });
    const analytics = payload.analytics || {};
    const actualSnapshots = analytics.cameraSnapshots || [];
    const hasActualSnapshot = actualSnapshots.some((item) => item?.method && String(item.method).includes('snapshot-counter'));
    const hasIngestOrCv = ['camera-ingest', 'cv-detector'].includes(String(analytics.source || ''));
    if (!hasActualSnapshot && !hasIngestOrCv) return null;
    return {
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
        waitRangeMin: analytics.waitRangeMin,
        waitRangeMax: analytics.waitRangeMax,
        vehicleMix15: analytics.vehicleMix15,
        source: analytics.source,
        snapshots: actualSnapshots.map((item) => ({ cameraId: item.cameraId, method: item.method, confidence: item.confidence, fetchedAt: item.fetchedAt })),
      },
      fetchedAt: new Date().toISOString(),
    };
  }));
  return results
    .map((result) => result.status === 'fulfilled' ? result.value : null)
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
  const clear = level === 'normal' && delayMinutes <= 2 && ratio < 1.12;
  const slow = level === 'slow' || delayMinutes > 2 || ratio >= 1.12;
  const heavy = level === 'heavy' || delayMinutes >= 8 || ratio >= 1.35;

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
  return /ni(?:je|su)\s+duz\w*\s+od\s+\d{1,3}\s*(?:minuta|min|m)/.test(text)
    || /(?:zadrzavanj\w+|cekanj\w+)\s+(?:\w+\s+)?do\s+\d{1,3}\s*(?:minuta|min)\b/.test(text);
}

function googleLooksClear(signal = null) {
  if (!signal) return false;
  const { delayMinutes, ratio, level } = trafficMeta(signal);
  return level === 'normal' && delayMinutes <= 2 && ratio < 1.12;
}

function googleLooksSlow(signal = null) {
  if (!signal) return false;
  const { delayMinutes, ratio, level } = trafficMeta(signal);
  return level === 'slow' || delayMinutes > 2 || ratio >= 1.12;
}

function googleLooksHeavy(signal = null) {
  if (!signal) return false;
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
  return wait >= 18 || queue >= 16;
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

function applyTrafficSanityCaps(wait, { googleSignal = null, cameraSignal = null, publicSignals = [], reportAvg = null } = {}) {
  let finalWait = clampWait(wait);
  if (finalWait === null) return { wait: null, adjusted: false, reason: '' };

  const hasDriverReports = reportAvg !== null;
  const softPublicOnly = publicSignals.length > 0 && publicSignals.every(isSoftUpperBoundSource);
  const hasHardPublic = publicSignals.some((item) => !isSoftUpperBoundSource(item) && Number(item.normalizedWaitMin || 0) >= 20);
  const clearGoogle = googleLooksClear(googleSignal);
  const clearCamera = cameraLooksClear(cameraSignal);
  const strongCameraQueue = cameraShowsQueue(cameraSignal);

  if (hasDriverReports || googleLooksHeavy(googleSignal)) return { wait: finalWait, adjusted: false, reason: '' };

  if (clearGoogle && softPublicOnly && (!cameraSignal || clearCamera)) {
    const capped = Math.min(finalWait, cameraSignal ? 12 : 14);
    return { wait: capped, adjusted: capped !== finalWait, reason: 'Google promet je normalan, a javni izvor daje samo gornju granicu; procjena je spuštena na nisko/umjereno čekanje.' };
  }

  if (clearGoogle && clearCamera && !hasHardPublic) {
    const capped = Math.min(finalWait, 15);
    return { wait: capped, adjusted: capped !== finalWait, reason: 'Google i kamera zajedno pokazuju protočnost; veća procjena je ograničena.' };
  }

  if (clearGoogle && !strongCameraQueue && softPublicOnly) {
    const capped = Math.min(finalWait, 16);
    return { wait: capped, adjusted: capped !== finalWait, reason: 'Google je plav/normalan pa se BIHAMK/HAK/AMS tekst “do 30 min” tretira kao gornja granica, ne kao stvarnih 25–30 min.' };
  }

  if (clearGoogle && cameraSignal && !strongCameraQueue && !hasHardPublic) {
    const capped = Math.min(finalWait, 20);
    return { wait: capped, adjusted: capped !== finalWait, reason: 'Google ne vidi cestovni zastoj; bez jake kamere ili tvrdog javnog izvora čekanje se ne diže visoko.' };
  }

  // Camera overrides clear Google only when it shows strong queue (possible local congestion Google missed).
  if (clearGoogle && strongCameraQueue) {
    const capped = Math.min(finalWait, 25);
    return { wait: capped, adjusted: capped !== finalWait, reason: 'Kamera pokazuje kolonu iako je Google promet normalan — mogući lokalni zastoj koji Google nije zabilježio. Čekanje ograničeno na 25 min.' };
  }

  // Last-resort: if Google is clear, never allow > 25 min regardless of other soft signals.
  if (clearGoogle && finalWait > 25) {
    return { wait: 25, adjusted: true, reason: 'Google plava ruta je sanity check — bez crvenog/narančastog prometa, dojava ili jakih signala, procjena se ograničava na 25 min.' };
  }

  return { wait: finalWait, adjusted: false, reason: '' };
}

async function buildGoogleTrafficSnapshots() {
  if (!GOOGLE_TRAFFIC_ESTIMATE_ENABLED || !serverKey) return [];
  const jobs = [];
  for (const crossing of Object.values(BORDER_CROSSINGS)) {
    for (const direction of ['toBih', 'toHr']) jobs.push({ crossing, direction });
  }
  const snapshots = await mapWithConcurrency(jobs, GOOGLE_TRAFFIC_REFRESH_CONCURRENCY, async ({ crossing, direction }) => {
    const payload = await computeCrossingRoutes(crossing.id, direction);
    const route = payload.routes?.[0];
    if (!route) return null;
    const googleDelay = Math.max(0, Number(route.delayMinutes || 0));
    const ratio = Math.max(0.1, Number(route.ratio || 1) || 1);
    const estimate = estimateWaitFromGoogleRoute(route);
    const estimatedWait = clampWait(estimate.wait);
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
      },
      fetchedAt: new Date().toISOString(),
    };
  });
  return snapshots.filter(Boolean);
}

async function refreshProductionSources({ force = false } = {}) {
  if (!SOURCE_FETCH_ENABLED) return { ok: true, skipped: true, reason: 'SOURCE_FETCH_ENABLED=false', snapshots: [] };
  const now = Date.now();
  if (!force && sourceRefreshState.running) return sourceRefreshState.running;
  if (!force && now - sourceRefreshState.lastRunAt < SOURCE_REFRESH_INTERVAL_MS) return { ok: true, skipped: true, reason: 'fresh-enough', snapshots: [] };

  sourceRefreshState.running = (async () => {
    const results = await Promise.allSettled([
      fetchHakSnapshots(),
      fetchBihamkSnapshots(),
      fetchAmsRsSnapshots(),
      buildCameraSourceSnapshots(),
      buildGoogleTrafficSnapshots(),
    ]);
    const snapshots = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason?.message || String(result.reason));
    const stored = await insertSourceSnapshots(snapshots);
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

async function effectiveBorderSignal(crossing, direction = 'toBih', vehicle = 'car', storeInput = null) {
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

  const latestSources = await readLatestSourceSnapshots(crossing.id, direction, 8);
  const publicSignals = latestSources.filter((item) => !['camera-snapshot-model', 'google-traffic-estimate'].includes(item.sourceType) && item.normalizedWaitMin !== null && item.normalizedWaitMin !== undefined);
  const cameraSignal = choosePublicSourceSignal(latestSources.filter((item) => item.sourceType === 'camera-snapshot-model'));
  const googleSignal = choosePublicSourceSignal(latestSources.filter((item) => item.sourceType === 'google-traffic-estimate'));
  const reports = reportSignals(store, crossing.id, direction, 2);
  const reportAvg = reports.length ? Math.round(reports.reduce((sum, item) => sum + Number(item.wait || 0), 0) / reports.length) : null;

  const candidates = [];
  publicSignals.forEach((item) => {
    const softUpperBound = isSoftUpperBoundSource(item);
    candidates.push({
      wait: waitForVehicle(item.normalizedWaitMin, multiplier, vehicle),
      weight: Math.max(0.1, Number(item.weight || 1)) * Math.max(35, Number(item.confidence || 70)) * (softUpperBound ? 0.82 : 1.15),
      label: sourceDisplayName(item.sourceName),
      sourceType: item.sourceType,
      softUpperBound,
      updatedAt: item.fetchedAt,
    });
  });
  if (cameraSignal) candidates.push({
    wait: waitForVehicle(cameraSignal.normalizedWaitMin ?? staticWait, multiplier, vehicle),
    weight: Math.max(0.1, Number(cameraSignal.weight || 0.72)) * Math.max(35, Number(cameraSignal.confidence || 58)) * (publicSignals.length ? 0.9 : 1.08) * (googleLooksClear(googleSignal) && cameraLooksClear(cameraSignal) ? 1.18 : 1),
    label: 'Kamera',
    sourceType: cameraSignal.sourceType,
    updatedAt: cameraSignal.fetchedAt,
  });
  if (googleSignal) candidates.push({
    wait: waitForVehicle(googleSignal.normalizedWaitMin ?? staticWait, multiplier, vehicle),
    weight: Math.max(0.1, Number(googleSignal.weight || 0.84)) * Math.max(35, Number(googleSignal.confidence || 62)) * (publicSignals.length ? 0.86 : 1.02),
    label: 'Google',
    sourceType: googleSignal.sourceType,
    updatedAt: googleSignal.fetchedAt,
  });
  if (reportAvg !== null && reports.length >= 2) candidates.push({
    wait: waitForVehicle(reportAvg, multiplier, vehicle),
    weight: Math.min(90, 32 + reports.length * 9),
    label: 'Dojave',
    sourceType: 'driver-reports',
    updatedAt: reports[0]?.createdAt || new Date().toISOString(),
  });

  const blendedWait = weightedWait(candidates);
  if (blendedWait !== null) {
    const sanity = applyTrafficSanityCaps(blendedWait, { googleSignal, cameraSignal, publicSignals, reportAvg });
    const finalWait = sanity.wait;
    const range = estimateRangeFromSignals(finalWait, { googleSignal, cameraSignal, publicSignals, reports });
    const signalNames = uniqueSignalNames(candidates);
    const hasMultipleOfficialSources = uniqueSignalNames(candidates.filter((item) => item.sourceType === 'public-text-status')).length > 1;
    const combined = signalNames.length > 1 || hasMultipleOfficialSources;
    const bestCandidate = [...candidates].sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0))[0];
    const googleClearNote = googleLooksClear(googleSignal) ? ' Google plavo/normalno ne znači 0 min, ali sprječava visoku procjenu bez kamere, dojava ili tvrdog javnog signala.' : '';
    return {
      wait: finalWait,
      rangeMin: range.rangeMin,
      rangeMax: range.rangeMax,
      confidenceHint: range.confidenceHint,
      label: combined ? 'Kombinirana procjena' : (bestCandidate.label === 'Google' ? 'Google procjena' : bestCandidate.label === 'Kamera' ? 'Kamera procjena' : `${bestCandidate.label} procjena`),
      className: combined ? 'combined' : (bestCandidate.label === 'Google' ? 'google' : bestCandidate.label === 'Kamera' ? 'camera' : 'official'),
      sourceType: combined ? 'combined-estimate' : bestCandidate.sourceType,
      confidence: Math.min(96, Math.round(Math.max(...candidates.map((item) => Number(item.weight || 0))) / 1.2 + (combined ? 5 : 0))),
      hasGoogleSignal: Boolean(googleSignal),
      hasCameraSignal: Boolean(cameraSignal),
      hasStrongCameraQueue: cameraShowsQueue(cameraSignal),
      hasSoftUpperBoundPublic: publicSignals.length > 0 && publicSignals.every(isSoftUpperBoundSource),
      note: sanity.adjusted
        ? `${sanity.reason}${googleClearNote}`
        : combined
          ? `Procjena spaja ${signalNames.join(' + ')}; Google je protočni sanity-check, kamera je queue/flow signal, a javni “do X min” tretira se kao gornja granica.${googleClearNote}`
          : `${bestCandidate.label} je trenutno najjači izvor za ovaj smjer.${googleClearNote}`,
      signals: latestSources,
      updatedAt: candidates.map((item) => item.updatedAt).filter(Boolean).sort().at(-1) || new Date().toISOString(),
    };
  }

  if (reportAvg !== null) {
    return {
      wait: clampWait(reportAvg * (vehicleKey(vehicle) === 'car' ? 1 : multiplier)),
      label: 'Dojave vozača',
      className: 'reports',
      sourceType: 'driver-reports',
      confidence: Math.min(78, 52 + reports.length * 8),
      note: `Prosjek ${reports.length} svježih dojava vozača.`,
      signals: [],
      updatedAt: reports[0]?.createdAt || new Date().toISOString(),
    };
  }

  return {
    wait: staticWait,
    rangeMin: Math.max(0, staticWait - 12),
    rangeMax: Math.min(360, staticWait + 12),
    label: serverKey ? 'Google procjena' : 'Planerska procjena',
    className: serverKey ? 'google' : 'estimate',
    sourceType: serverKey ? 'google-traffic-estimate-pending' : 'planner-estimate',
    confidence: serverKey ? 44 : 38,
    displayReady: true,
    note: serverKey
      ? 'Koristi se privremena procjena dok ne stigne svježa Google Routes provjera za ovaj prijelaz.'
      : 'Google Routes ključ nije postavljen; koristi se konzervativna planerska procjena dok ne stigne javni izvor, kamera ili dojava.',
    signals: latestSources,
    updatedAt: new Date().toISOString(),
  };
}

async function effectiveBorderDelay(crossing, direction = 'toBih', vehicle = 'car', store = null) {
  const signal = await effectiveBorderSignal(crossing, direction, vehicle, store);
  return signal.wait;
}

async function buildEffectiveWaitMaps(store) {
  const effectiveWaits = {};
  const waitSources = {};
  for (const crossing of Object.values(BORDER_CROSSINGS)) {
    for (const direction of ['toBih', 'toHr']) {
      const signal = await effectiveBorderSignal(crossing, direction, 'car', store);
      const key = `${crossing.id}:${direction}`;
      if (signal.displayReady !== false && Number.isFinite(Number(signal.wait))) {
        effectiveWaits[key] = signal.wait;
      }
      waitSources[key] = {
        label: signal.label,
        className: signal.className,
        note: signal.note,
        confidence: signal.confidence,
        confidenceHint: signal.confidenceHint,
        rangeMin: signal.rangeMin,
        rangeMax: signal.rangeMax,
        sourceType: signal.sourceType,
        hasGoogleSignal: signal.hasGoogleSignal,
        hasCameraSignal: signal.hasCameraSignal,
        hasStrongCameraQueue: signal.hasStrongCameraQueue,
        hasSoftUpperBoundPublic: signal.hasSoftUpperBoundPublic,
        displayReady: signal.displayReady !== false,
        updatedAt: signal.updatedAt,
      };
    }
  }
  return { effectiveWaits, waitSources };
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

app.post('/api/auth/register', authLimiter, async (req, res) => {
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
  refreshProductionSources({ force: false }).catch((error) => {
    console.warn('[source-refresh/public-state]', error.message);
  });
  const store = await readAppStore();
  const { effectiveWaits, waitSources } = await buildEffectiveWaitMaps(store);
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
      lastRunAt: sourceRefreshState.lastRunAt ? new Date(sourceRefreshState.lastRunAt).toISOString() : null,
      lastError: sourceRefreshState.lastError || '',
    },
    reportsCount: store.reports.length,
    lastReports: store.reports.slice(0, 12),
    crossings: Object.values(BORDER_CROSSINGS).map((crossing) => ({
      id: crossing.id,
      name: crossing.name,
      shortName: crossing.shortName,
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
// Shows exactly why finalWait is what it is.
app.get('/api/debug/wait', async (req, res) => {
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
// Used for regression testing after changes to the calculation logic.
app.get('/api/debug/wait-scenarios', async (req, res) => {
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
  const seed = deterministicSeed(`${snapshot.id}-${wait}`);
  const cameraMeta = snapshot.metadata || {};
  const throughputFromMeta = Number(cameraMeta.throughputPerHour || 0);
  const baseThroughput = throughputFromMeta || Math.max(10, Math.round(170 * Math.max(0.22, 0.88 - wait / 180)));
  const cars = Math.max(0, Math.round(baseThroughput * (0.68 + (seed % 7) / 100)));
  const vans = Math.max(0, Math.round(baseThroughput * (0.09 + (seed % 4) / 100)));
  const trucks = Math.max(0, Math.round(baseThroughput * (0.17 + (seed % 5) / 100)));
  const buses = Math.max(0, Math.round(baseThroughput * 0.025));
  const totalDemand = cars + vans + trucks + buses;
  const passed = Math.max(1, baseThroughput);
  const queueVehicles = Math.max(0, Math.round((wait / 60) * passed * 0.72));
  const source = snapshot.sourceType === 'camera-snapshot-model'
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
    rhythmSeconds: Math.round(3600 / Math.max(passed, 1)),
    queueVehicles,
    wait,
    source,
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
  const crossingId = req.params.crossingId || 'maljevac';
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';
  const days = clampHistoryDays(req.query.days);
  const crossing = BORDER_CROSSINGS[crossingId] || BORDER_CROSSINGS.maljevac;
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
    totals: sumCounts(history),
    note: history.length
      ? 'Povijest je građena iz source snapshotova spremljenih u bazu.'
      : 'Za odabrani dan još nema spremljenih source snapshotova. Povijest se puni kako scheduler/refresh dohvaća izvore.',
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
      path: datastoreMode === 'postgres' ? 'DATABASE_URL' : (process.env.NODE_ENV === 'production' ? 'data/runtime-store.json' : storePath),
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

function isKnownCamera(crossingId, cameraId) {
  return (CAMERA_FEEDS[crossingId] || []).some((camera) => camera.id === cameraId);
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

  const response = await fetch(cvEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cvApiKey ? { Authorization: `Bearer ${cvApiKey}` } : {}),
    },
    body: JSON.stringify({
      cameraId: camera.id,
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


function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function estimateCameraFlowFromSnapshot({ visibleTotal = 0, occupancyPct = 0, componentDensity = 0, direction = 'toBih', previousSnapshot = null } = {}) {
  const queueVehicles = Math.max(0, Math.round(Number(visibleTotal || 0)));
  const occupancyLoad = clampNumber(Number(occupancyPct || 0) / 45, 0, 1.6);
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
  let wait = queueVehicles <= 0 ? 0 : Math.round(queueVehicles / servicePerMinute + (queueVehicles <= 2 ? 1 : 2));
  if (queueVehicles > 14 && flowVehicles15 <= 10) wait += 4;
  const confidence = Math.max(44, Math.min(86, Math.round(58 + Math.min(16, queueVehicles * 1.1) - Math.max(0, occupancyPct - 34) * 0.35 + (queueTrend === 'unknown' ? -4 : 4))));

  return {
    queueVehicles,
    flowVehicles15,
    throughputPerHour: Math.max(8, flowVehicles15 * 4),
    wait: clampWait(wait),
    queueTrend,
    trendDelta,
    confidence,
    method: previousSnapshot ? 'snapshot-flow-v2' : 'snapshot-flow-v2-single-frame',
  };
}

function analyzeSnapshotImage(image, camera, direction, previousSnapshot = null) {
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
    const roadBandBoost = cell.gy >= 3 && cell.gy <= 14;
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
  const componentDensity = usefulComponents.length / Math.max(1, gridX * gridY / 32);
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

  const flowEstimate = estimateCameraFlowFromSnapshot({ visibleTotal, occupancyPct, componentDensity, direction, previousSnapshot });
  const cameraWait = flowEstimate.wait;
  const blendedConfidence = Math.max(CAMERA_SNAPSHOT_MIN_CONFIDENCE, Math.min(90, Math.round(confidence * 0.62 + flowEstimate.confidence * 0.38)));

  return {
    counts: blendedCounts,
    rawCounts: counts,
    visibleTotal,
    queueVehicles: flowEstimate.queueVehicles,
    passed15: flowEstimate.flowVehicles15,
    flowVehicles15: flowEstimate.flowVehicles15,
    throughputPerHour: flowEstimate.throughputPerHour,
    wait: cameraWait,
    waitRangeMin: Math.max(0, cameraWait - (flowEstimate.queueTrend === 'unknown' ? 7 : 5)),
    waitRangeMax: Math.min(360, cameraWait + (flowEstimate.queueTrend === 'rising' ? 12 : 8)),
    queueTrend: flowEstimate.queueTrend,
    trendDelta: flowEstimate.trendDelta,
    confidence: blendedConfidence,
    detections,
    laneGroups: laneProfile,
    roi: camera.calibration?.roi || roi,
    width: image.width,
    height: image.height,
    occupancyPct,
    componentCount: usefulComponents.length,
    componentDensity: Math.round(componentDensity * 100) / 100,
    method: flowEstimate.method,
  };
}

async function runSnapshotCounter(camera, crossingId, direction, previousSnapshot = null) {
  if (!CAMERA_SNAPSHOT_COUNTING_ENABLED) return null;
  if (!/\.jpe?g(?:$|\?)/i.test(camera.url || '')) return null;
  const { buffer, contentType } = await fetchBinaryWithTimeout(camera.url);

  // Some HAK URLs keep a .jpg path but occasionally return HTML, an empty payload,
  // or a protected/redirect response. jpeg-js then fails with "SOI not found".
  // For staging we silently skip that snapshot and let calibrated/admin/BIHAMK
  // sources drive the wait estimate instead of spamming the console.
  const isJpegPayload = buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8;
  if (!isJpegPayload || (!contentType.includes('image') && !contentType.includes('jpeg'))) return null;

  const image = decodeJpegImage(buffer);
  const analysis = analyzeSnapshotImage(image, camera, direction, previousSnapshot);
  return {
    cameraId: camera.id,
    cameraLabel: camera.label,
    sourceName: camera.source || 'kamera',
    sourceUrl: camera.url,
    imageStatus: 'ok',
    ...analysis,
    metadata: {
      flowVehicles15: analysis.flowVehicles15,
      passed15: analysis.passed15,
      queueTrend: analysis.queueTrend,
      trendDelta: analysis.trendDelta,
      waitRangeMin: analysis.waitRangeMin,
      waitRangeMax: analysis.waitRangeMax,
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
    return runSnapshotCounter(camera, crossing.id, direction, cached || null);
  }));
  const snapshotAnalyses = snapshotResults.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    if (options.storeScan || options.forceSnapshot) console.warn('[snapshot-counter]', feeds[index]?.id, result.reason?.message || String(result.reason));
    return cachedByCamera.get(feeds[index]?.id) || null;
  });
  const snapshotRows = snapshotAnalyses
    .filter(Boolean)
    .map((snapshot) => ({ ...snapshot, crossingId: crossing.id, direction, metadata: { ...(snapshot.metadata || {}), roi: snapshot.roi, occupancyPct: snapshot.occupancyPct, componentCount: snapshot.componentCount, rawCounts: snapshot.rawCounts } }));
  if (snapshotRows.length) {
    await insertCameraSnapshots(snapshotRows).catch((error) => console.warn('[camera-snapshot-store]', error.message));
  }
  const aggregatedSnapshots = aggregateCameraSnapshots(snapshotRows.length ? snapshotRows : await readLatestCameraSnapshots(crossing.id, direction, 3));

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
  const snapshotCounts = aggregatedSnapshots?.counts ? normalizeCounts(aggregatedSnapshots.counts) : null;
  const liveWait = aggregatedSnapshots?.wait !== null && aggregatedSnapshots?.wait !== undefined ? clampWait(aggregatedSnapshots.wait) : wait;
  const liveThroughputPerHour = aggregatedSnapshots?.throughputPerHour ? Math.max(8, Number(aggregatedSnapshots.throughputPerHour)) : throughputPerHour;
  const livePassed15 = Math.max(0, Math.round(aggregatedSnapshots?.flowVehicles15 ?? aggregatedSnapshots?.passed15 ?? liveThroughputPerHour / 4));
  const liveRhythmSeconds = Math.round(3600 / Math.max(liveThroughputPerHour, 1));
  const liveQueueVehicles = aggregatedSnapshots?.queueVehicles ?? Math.max(0, Math.round((liveWait / 60) * liveThroughputPerHour * 0.72));
  const liveVehicleMix15 = hasIngest ? eventMix : (snapshotCounts || vehicleMix15);
  const hasSnapshotCounter = Boolean(aggregatedSnapshots?.snapshots?.some((item) => String(item.method || '').includes('snapshot-counter')));

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
      vehicleMix15: liveVehicleMix15,
      laneProfile,
      laneSignals,
      history,
      dailyTotals: sumCounts(history),
      source: hasIngest ? 'camera-ingest' : (cvEndpoint ? 'cv-detector' : (hasSnapshotCounter ? 'snapshot-counter' : 'baseline-camera-model')),
      cameraSnapshots: aggregatedSnapshots?.snapshots?.map((item) => ({
        cameraId: item.cameraId,
        cameraLabel: item.cameraLabel,
        visibleTotal: item.visibleTotal,
        queueVehicles: item.queueVehicles,
        throughputPerHour: item.throughputPerHour,
        passed15: item.passed15 ?? item.metadata?.passed15,
        flowVehicles15: item.flowVehicles15 ?? item.metadata?.flowVehicles15,
        queueTrend: item.queueTrend || item.metadata?.queueTrend,
        wait: item.wait,
        waitRangeMin: item.metadata?.waitRangeMin,
        waitRangeMax: item.metadata?.waitRangeMax,
        confidence: item.confidence,
        method: item.method,
        fetchedAt: item.fetchedAt,
      })) || [],
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

function slicePathAroundPoint(path = [], centerPoint, beforeMeters = 900, afterMeters = 1100) {
  if (!Array.isArray(path) || path.length < 2 || !centerPoint) return path || [];
  const centerIndex = nearestPathIndex(centerPoint, path);
  if (centerIndex < 0) return path;

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

  const sliced = path.slice(startIndex, endIndex + 1);
  return sliced.length >= 2 ? sliced : path;
}

function makeMapFriendlyControlZoneRoute(route, anchor = {}) {
  const guard = anchor.routeGuard || {};
  const beforeMeters = Number(guard.displayBeforeMeters || process.env.ROUTE_DISPLAY_BEFORE_METERS || 850);
  const afterMeters = Number(guard.displayAfterMeters || process.env.ROUTE_DISPLAY_AFTER_METERS || 1050);
  const displayPath = slicePathAroundPoint(route.path || [], anchor.borderPoint, beforeMeters, afterMeters);
  const displayDistanceMeters = pathDistanceMeters(displayPath);
  if (!displayPath.length || displayDistanceMeters <= 0) return route;

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
    trafficSegments: buildTrafficSegments(displayPath, []),
    label: route.primary ? 'Provjerena zona' : 'Alternativni prilaz',
    displayMode: 'control_zone',
    displayNote: 'Na karti je namjerno prikazana samo provjerena dionica oko prijelaza, bez čudnih početnih i završnih točaka.',
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
  const includeApproachExit = context !== 'journey' || guard.validateApproachExit !== false;
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

  return {
    ok: errors.length === 0,
    enabled: true,
    passDistanceMeters,
    warnings,
    errors,
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

function trafficSegmentColorSpeed(speed) {
  if (speed === 'TRAFFIC_JAM') return 'jam';
  if (speed === 'SLOW') return 'slow';
  if (speed === 'NORMAL') return 'normal';
  return 'unknown';
}

function buildTrafficSegments(pathPoints, intervals = []) {
  if (!Array.isArray(pathPoints) || pathPoints.length < 2 || !Array.isArray(intervals) || !intervals.length) return [];

  return intervals
    .map((interval, index) => {
      const start = Math.max(0, Number(interval.startPolylinePointIndex ?? 0));
      const end = Math.min(pathPoints.length - 1, Number(interval.endPolylinePointIndex ?? pathPoints.length - 1));
      const segmentPath = pathPoints.slice(start, end + 1);

      return {
        id: `traffic-${index + 1}`,
        speed: interval.speed || 'SPEED_UNSPECIFIED',
        level: trafficSegmentColorSpeed(interval.speed),
        startPolylinePointIndex: start,
        endPolylinePointIndex: end,
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
      const routeDurationMinutes = baseTripMinutes + crossing.extraDriveFromMainRoute + Math.round(index * 2.5) + (seed % 9);
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
  const crossing = BORDER_CROSSINGS[crossingId] || BORDER_CROSSINGS.maljevac;
  const anchor = crossing.anchors[direction] || crossing.anchors.toBih;
  if (!anchor.routeGuard) {
    return routePendingPayload(crossing, direction, 'Za ovaj prijelaz zasad prikazujemo čekanje, kamere i prometni sloj. Cestovnu liniju ćemo uključiti čim prođe provjeru, da mapa ne bi pokazivala čudnu ili krivu putanju.');
  }
  const body = routeRequest({
    origin: latLngWaypoint(anchor.approachStart),
    destination: latLngWaypoint(anchor.exitPoint),
    // Force Google to go through the actual border control zone, not through a nearby snapped pin.
    intermediates: [latLngWaypoint(anchor.borderPoint, { via: true })],
    alternatives: true,
  });

  const data = await fetchRoutes(body);
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
    const error = new Error(`Route guard odbio rutu za ${crossing.shortName}: ${reason}`);
    error.rejectedRoutes = rejected.map((route) => ({ id: route.id, distanceKm: route.distanceKm, routeGuard: route.routeGuard }));
    throw error;
  }

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
    note: rejected.length ? `${rejected.length} Google alternativa je odbačena jer ne prolazi kroz kalibrirane točke prijelaza. Na karti prikazujemo samo provjerenu zonu oko granice.` : 'Na karti prikazujemo samo provjerenu cestovnu zonu oko prijelaza, bez umjetnih početnih i završnih točaka.',
    rejectedRoutes: process.env.NODE_ENV === 'production' ? undefined : rejected.map((route) => ({ id: route.id, distanceKm: route.distanceKm, routeGuard: route.routeGuard })),
    routes: accepted.map((route, index) => makeMapFriendlyControlZoneRoute({ ...route, primary: index === 0 }, anchor)),
  };
}

async function computeJourneyOption(crossing, direction, originText, destinationText, vehicle) {
  const anchor = crossing.anchors[direction] || crossing.anchors.toBih;
  const data = await fetchRoutes(routeRequest({
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

  const borderSignal = await effectiveBorderSignal(crossing, direction, vehicle);
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
    route: { ...route, routeGuard: guard, routeQuality: 'verified' },
    routeGuard: guard,
    routeQuality: 'verified',
    zone: route.zone,
  };
}

function safeError(error) {
  return process.env.NODE_ENV === 'production' ? undefined : error.message;
}



app.get('/api/camera-snapshots/:crossingId', async (req, res) => {
  const crossingId = req.params.crossingId || 'maljevac';
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';
  const crossing = BORDER_CROSSINGS[crossingId] || BORDER_CROSSINGS.maljevac;
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
  const crossingId = req.params.crossingId || 'maljevac';
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';

  try {
    res.json(await buildCameraAnalyticsPayload(crossingId, direction));
  } catch (error) {
    console.error('[camera-analytics]', error);
    res.status(500).json({ ok: false, live: false, note: 'Analitika kamera trenutno nije dostupna.', error: safeError(error) });
  }
});

app.get('/api/camera-history/:crossingId', async (req, res) => {
  const crossingId = req.params.crossingId || 'maljevac';
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';
  const crossing = BORDER_CROSSINGS[crossingId] || BORDER_CROSSINGS.maljevac;
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
  const crossingId = req.params.crossingId || 'maljevac';
  const direction = req.body?.direction === 'toHr' ? 'toHr' : 'toBih';

  try {
    const payload = await buildCameraAnalyticsPayload(crossingId, direction, { storeScan: true });
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
  const crossingId = req.params.crossingId || 'maljevac';
  const direction = req.query.direction === 'toHr' ? 'toHr' : 'toBih';

  const crossing = BORDER_CROSSINGS[crossingId] || BORDER_CROSSINGS.maljevac;
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
    res.json(await computeCrossingRoutes(crossingId, direction));
  } catch (error) {
    console.error('[routes-api]', error);
    if (isLikelyClosedOrBlockedRoute(error, crossing, direction)) {
      res.json(routeClosedPayload(crossing, direction, 'Google trenutačno ne vraća lokalnu putanju kroz ovaj prijelaz; to obično znači da je most/granična ruta zatvorena, privremeno blokirana ili preusmjerena.', {
        error: safeError(error),
      }));
      return;
    }
    res.json(buildFallbackCrossingRoute(crossing, direction, 'Google Routes/route guard trenutno nisu vratili sigurnu cestovnu putanju; rutu ne crtamo dok ne bude validirana.', {
      source: 'routes-api-fallback',
      error: safeError(error),
    }));
  }
});

app.get('/api/trip-options', async (req, res) => {
  const origin = String(req.query.origin || '').trim();
  const destination = String(req.query.destination || '').trim();
  const requestedDirection = req.query.direction === 'toHr' ? 'toHr' : req.query.direction === 'toBih' ? 'toBih' : null;
  const direction = inferJourneyDirection(origin, destination) || requestedDirection || 'toBih';
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

initializeDatastore()
  .then(() => {
    app.listen(port, () => {
      console.log(`PrijelazRadar backend running on http://localhost:${port}`);
      console.log(`Datastore: ${datastoreMode}`);
      console.log(serverKey ? 'Routes API server key: configured' : 'Routes API server key: missing');
    });
  })
  .catch((error) => {
    console.error('[startup] Datastore initialization failed:', error);
    process.exit(1);
  });
