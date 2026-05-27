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
