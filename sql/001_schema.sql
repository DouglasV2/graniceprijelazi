CREATE TABLE IF NOT EXISTS borderflow_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS borderflow_admin_overrides (
  key TEXT PRIMARY KEY,
  crossing_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('toBih', 'toHr')),
  wait_minutes INTEGER NOT NULL CHECK (wait_minutes BETWEEN 0 AND 360),
  actor_user_id TEXT REFERENCES borderflow_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_borderflow_overrides_crossing_direction
  ON borderflow_admin_overrides (crossing_id, direction);


CREATE TABLE IF NOT EXISTS borderflow_status_overrides (
  key TEXT PRIMARY KEY,
  crossing_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('toBih', 'toHr')),
  status TEXT NOT NULL CHECK (status IN ('open', 'busy', 'closed', 'redirected', 'unknown')),
  note TEXT,
  replacement_crossing_id TEXT,
  actor_user_id TEXT REFERENCES borderflow_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_borderflow_status_overrides_crossing_direction
  ON borderflow_status_overrides (crossing_id, direction);

CREATE TABLE IF NOT EXISTS borderflow_driver_reports (
  id TEXT PRIMARY KEY,
  crossing_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('toBih', 'toHr')),
  wait_minutes INTEGER NOT NULL CHECK (wait_minutes BETWEEN 0 AND 360),
  message TEXT,
  user_id TEXT REFERENCES borderflow_users(id) ON DELETE SET NULL,
  user_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_borderflow_reports_crossing_created
  ON borderflow_driver_reports (crossing_id, created_at DESC);

CREATE TABLE IF NOT EXISTS borderflow_audit (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  actor_user_id TEXT REFERENCES borderflow_users(id) ON DELETE SET NULL,
  actor_snapshot JSONB,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_borderflow_audit_created
  ON borderflow_audit (created_at DESC);

CREATE TABLE IF NOT EXISTS borderflow_route_searches (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES borderflow_users(id) ON DELETE SET NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('toBih', 'toHr')),
  vehicle TEXT NOT NULL CHECK (vehicle IN ('car', 'truck', 'bus')),
  best_crossing_id TEXT,
  best_crossing_name TEXT,
  total_minutes INTEGER NOT NULL DEFAULT 0,
  live BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_borderflow_route_searches_user_created
  ON borderflow_route_searches (user_id, created_at DESC);

ALTER TABLE borderflow_driver_reports
  ADD COLUMN IF NOT EXISTS report_type TEXT NOT NULL DEFAULT 'ok';

CREATE TABLE IF NOT EXISTS borderflow_history_snapshots (
  id TEXT PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  crossing_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('toBih', 'toHr')),
  hour TEXT NOT NULL,
  cars INTEGER NOT NULL DEFAULT 0,
  vans INTEGER NOT NULL DEFAULT 0,
  trucks INTEGER NOT NULL DEFAULT 0,
  buses INTEGER NOT NULL DEFAULT 0,
  total_demand INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  throughput INTEGER NOT NULL DEFAULT 0,
  rhythm_seconds INTEGER NOT NULL DEFAULT 0,
  queue_vehicles INTEGER NOT NULL DEFAULT 0,
  wait_minutes INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'camera-model',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (snapshot_date, crossing_id, direction, hour)
);

CREATE INDEX IF NOT EXISTS idx_borderflow_history_lookup
  ON borderflow_history_snapshots (crossing_id, direction, snapshot_date DESC, hour ASC);

CREATE TABLE IF NOT EXISTS borderflow_source_snapshots (
  id TEXT PRIMARY KEY,
  crossing_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('toBih', 'toHr')),
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'public-source',
  source_url TEXT,
  raw_status TEXT,
  raw_text TEXT,
  raw_wait_min INTEGER CHECK (raw_wait_min IS NULL OR raw_wait_min BETWEEN 0 AND 360),
  normalized_wait_min INTEGER CHECK (normalized_wait_min IS NULL OR normalized_wait_min BETWEEN 0 AND 360),
  confidence INTEGER NOT NULL DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),
  weight NUMERIC NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_borderflow_source_snapshots_lookup
  ON borderflow_source_snapshots (crossing_id, direction, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_borderflow_source_snapshots_source
  ON borderflow_source_snapshots (source_name, fetched_at DESC);

CREATE TABLE IF NOT EXISTS borderflow_camera_snapshots (
  id TEXT PRIMARY KEY,
  crossing_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('toBih', 'toHr')),
  camera_id TEXT NOT NULL,
  camera_label TEXT,
  source_name TEXT,
  source_url TEXT,
  image_status TEXT NOT NULL DEFAULT 'ok',
  width INTEGER,
  height INTEGER,
  roi JSONB NOT NULL DEFAULT '{}'::jsonb,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  visible_total INTEGER NOT NULL DEFAULT 0,
  queue_vehicles INTEGER NOT NULL DEFAULT 0,
  throughput_per_hour INTEGER NOT NULL DEFAULT 0,
  wait_minutes INTEGER CHECK (wait_minutes IS NULL OR wait_minutes BETWEEN 0 AND 360),
  confidence INTEGER NOT NULL DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),
  method TEXT NOT NULL DEFAULT 'snapshot-counter',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_borderflow_camera_snapshots_lookup
  ON borderflow_camera_snapshots (crossing_id, direction, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_borderflow_camera_snapshots_camera
  ON borderflow_camera_snapshots (camera_id, fetched_at DESC);

-- ── Accuracy tracking (the core KPI: predicted vs actual wait) ────────────────
CREATE TABLE IF NOT EXISTS borderflow_prediction_accuracy (
  id TEXT PRIMARY KEY,
  crossing_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('toBih', 'toHr')),
  predicted_wait INTEGER,
  actual_wait INTEGER,
  confidence_level TEXT,
  confidence_score INTEGER,
  source_mix JSONB NOT NULL DEFAULT '{}'::jsonb,
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'measured-session'
);

CREATE INDEX IF NOT EXISTS idx_borderflow_prediction_accuracy_lookup
  ON borderflow_prediction_accuracy (crossing_id, direction, predicted_at DESC);

-- ── Measured wait sessions (driver joins queue → crosses; truest ground truth) ─
CREATE TABLE IF NOT EXISTS borderflow_measured_sessions (
  id TEXT PRIMARY KEY,
  crossing_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('toBih', 'toHr')),
  user_id TEXT REFERENCES borderflow_users(id) ON DELETE SET NULL,
  anonymous BOOLEAN NOT NULL DEFAULT TRUE,
  predicted_wait_at_start INTEGER,
  actual_wait INTEGER,
  gps_verified BOOLEAN NOT NULL DEFAULT FALSE,
  start_gps JSONB,
  end_gps JSONB,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finished', 'cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_borderflow_measured_sessions_lookup
  ON borderflow_measured_sessions (crossing_id, direction, started_at DESC);

-- ── Per-camera ROI v2 configs (queue polygon counting). Production source of truth when a DB is
--    configured; otherwise the committed STATIC_ROI_CONFIGS + runtime file overrides are used. ──
CREATE TABLE IF NOT EXISTS borderflow_camera_roi_configs (
  id TEXT PRIMARY KEY,
  camera_id TEXT NOT NULL UNIQUE,
  crossing_id TEXT,
  direction TEXT CHECK (direction IS NULL OR direction IN ('toBih', 'toHr')),
  queue_polygon_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ignore_polygons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  lane_polygons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  booth_line_json JSONB,
  border_line_json JSONB,
  meters_per_pixel NUMERIC,
  camera_reliability NUMERIC NOT NULL DEFAULT 0.7,
  night_reliability NUMERIC NOT NULL DEFAULT 0.45,
  roi_version TEXT NOT NULL DEFAULT 'db-1',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_borderflow_camera_roi_configs_active
  ON borderflow_camera_roi_configs (is_active, camera_id);

-- ── Alert subscriptions (push-ready; transport configured separately) ─────────
CREATE TABLE IF NOT EXISTS borderflow_alert_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES borderflow_users(id) ON DELETE SET NULL,
  crossing_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('toBih', 'toHr')),
  drop_below INTEGER,
  rise_above INTEGER,
  push_token TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_borderflow_alert_subscriptions_lookup
  ON borderflow_alert_subscriptions (crossing_id, direction, active);
