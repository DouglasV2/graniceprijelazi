-- Local/pilot seed you can run immediately after sql/001_schema.sql.
-- Login email: admin@borderflow.app
-- Initial password: change-this-admin-password
-- Change this password before any real public deployment.

INSERT INTO borderflow_users (id, name, email, role, password_hash, created_at)
VALUES (
  'admin-access',
  'Admin',
  'admin@borderflow.app',
  'admin',
  'pbkdf2_sha256$130000$187bd81f5480e0baf939be2743be91c1$1a0d3f8dc98c31f6c82b645f0e680c10d2eef0b68447526184428ed8b2d81103',
  NOW()
)
ON CONFLICT (email) DO UPDATE SET
  name = EXCLUDED.name,
  role = EXCLUDED.role,
  password_hash = EXCLUDED.password_hash;

INSERT INTO borderflow_audit (id, type, details, created_at)
VALUES ('seed-admin-local', 'admin_seeded_from_sql', '{"source":"sql/002_seed_local_admin.sql"}'::jsonb, NOW())
ON CONFLICT (id) DO NOTHING;
