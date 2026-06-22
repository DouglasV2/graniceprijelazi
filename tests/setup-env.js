// Test environment defaults.
// Must run before server/index.js is imported so that the listener is skipped
// and external fetches stay disabled.
process.env.NODE_ENV = 'test';
process.env.SOURCE_FETCH_ENABLED = 'false';
process.env.CAMERA_SNAPSHOT_COUNTING_ENABLED = 'false';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'borderflow-test-secret';
process.env.PORT = process.env.PORT || '0';
// Pin Google keys to empty *before* server/index.js runs dotenv.config().
// dotenv does not overwrite existing process.env keys, so setting them to ''
// here keeps the server on its no-key fallback path during tests. We don't
// want to hit Google Routes from CI.
process.env.GOOGLE_MAPS_SERVER_KEY = '';
process.env.GOOGLE_MAPS_API_KEY = '';
// Block any real outbound HTTP from the server during tests.
process.env.DATABASE_URL = '';
// Pin the seeded admin/demo identities so the JSON store is seeded deterministically,
// regardless of the developer's shell/.env. Tests sign tokens for admin@borderflow.app,
// so the seed MUST use that address (a shell BORDERFLOW_ADMIN_EMAIL would otherwise break auth).
process.env.BORDERFLOW_ADMIN_EMAIL = 'admin@borderflow.app';
process.env.BORDERFLOW_ADMIN_PASSWORD = 'change-this-admin-password';
process.env.BORDERFLOW_DEMO_USER_EMAIL = 'user@borderflow.app';
process.env.BORDERFLOW_DEMO_USER_PASSWORD = 'change-this-user-password';
// Enable Google Sign-In in tests (the real JWKS verifier is stubbed via setGoogleIdVerifier).
process.env.GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || 'test-client.apps.googleusercontent.com';
