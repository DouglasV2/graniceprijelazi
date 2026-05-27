-- 1) Prvo generiraj hash:
--    node scripts/create-password-hash.mjs "tvoja-admin-lozinka"
--
-- 2) Kopiraj dobiveni hash u password_hash ispod i pokreni:
--    psql "$DATABASE_URL" -f sql/002_seed_admin_template.sql

INSERT INTO borderflow_users (id, name, email, role, password_hash, created_at)
VALUES (
  'admin-access',
  'Admin',
  'admin@borderflow.app',
  'admin',
  'REPLACE_WITH_GENERATED_HASH',
  NOW()
)
ON CONFLICT (email) DO UPDATE SET
  name = EXCLUDED.name,
  role = EXCLUDED.role,
  password_hash = EXCLUDED.password_hash;

INSERT INTO borderflow_audit (id, type, details, created_at)
VALUES ('seed-admin-manual', 'admin_seeded_from_sql', '{"source":"sql/002_seed_admin_template.sql"}'::jsonb, NOW())
ON CONFLICT (id) DO NOTHING;
