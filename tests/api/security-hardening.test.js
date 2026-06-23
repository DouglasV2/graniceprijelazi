// Security-hardening regression tests. Behavioural where we can drive it through supertest (CSP header,
// malformed-JSON handling, ingest auth), source-scan where the behaviour only triggers in a real
// deployment (NODE_ENV=test is intentionally NOT a "real deployment", so the startup gate and the
// unsigned-webhook fail-closed can't be exercised in-process). These lock in the fixes from the
// 2026-06-23 security pass so they can't silently regress.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getApp } from '../helpers/app-loader.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const server = readFileSync(join(root, 'server', 'index.js'), 'utf8');
const cv = readFileSync(join(root, 'cv-detector', 'app.py'), 'utf8');
const appSource = readFileSync(join(root, 'src', 'App.jsx'), 'utf8');

let app;
beforeAll(async () => { app = await getApp(); });

describe('CSP locks script-src to self + Google (no unsafe-inline)', () => {
  it('serves a CSP whose script-src has NO unsafe-inline but style-src still does (Maps needs it)', async () => {
    const res = await request(app).get('/health');
    const csp = res.headers['content-security-policy'] || '';
    expect(csp).toBeTruthy();
    const scriptSrc = csp.split(';').map((s) => s.trim()).find((d) => d.startsWith('script-src')) || '';
    const styleSrc = csp.split(';').map((s) => s.trim()).find((d) => d.startsWith('style-src')) || '';
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'"); // an injected inline <script> can't run
    expect(styleSrc).toContain("'unsafe-inline'");       // Google Maps SDK injects styles
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });
});

describe('terminal error handler never leaks a stack trace', () => {
  it('malformed JSON returns a generic JSON 400, not a SyntaxError stack', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "x",');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error).toBe('Neočekivana greška.');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/SyntaxError|Unexpected token|at \w+ \(/); // no error class / stack frames
  });
});

describe('camera-ingest is locked when no API key is configured', () => {
  it('rejects ingest without a matching x-api-key', async () => {
    const res = await request(app)
      .post('/api/camera-ingest')
      .send({ crossingId: 'maljevac', cameraId: 'x', counts: {} });
    expect(res.status).toBe(401);
  });
});

describe('source-level security invariants (server)', () => {
  it('trusts a FIXED number of proxy hops (real client IP for the rate limiter), never `true`', () => {
    expect(server).toMatch(/app\.set\('trust proxy', Number\(process\.env\.TRUST_PROXY_HOPS \|\| 1\)\)/);
  });
  it('the per-device session hash no longer falls back to the spoofable X-Forwarded-For header', () => {
    expect(server).not.toMatch(/req\.headers\['x-forwarded-for'\]/);
  });
  it('the Stripe webhook fails closed (no unsigned req.body) on a real deployment', () => {
    expect(server).toMatch(/else if \(looksLikeRealDeployment\(\)\) \{/);
    expect(server).toMatch(/STRIPE_WEBHOOK_SECRET missing while billing is enabled/);
  });
  it('the startup gate blocks a weak session secret + billing-without-webhook-secret on any real deployment', () => {
    expect(server).toMatch(/function looksLikeRealDeployment\(\)/);
    expect(server).toMatch(/if \(!deployed\) return;/);
    expect(server).toMatch(/omogućuje krivotvorenje admin tokena/);
    expect(server).toMatch(/BILLING_ENABLED && !STRIPE_WEBHOOK_SECRET/);
  });
  it('the camera-ingest API key is compared in constant time', () => {
    expect(server).toMatch(/!timingSafeEqualStr\(incomingApiKey, cameraIngestApiKey\)/);
  });
  it('a terminal error handler is registered to swallow stacks', () => {
    expect(server).toMatch(/app\.use\(\(err, req, res, next\) =>/);
    expect(server).toMatch(/'\[unhandled\]'/);
  });
});

describe('source-level security invariants (cv-detector SSRF)', () => {
  it('the imageUrl fallback is guarded against SSRF (scheme + allow-list + private-IP block, no redirects)', () => {
    expect(cv).toMatch(/def _is_public_http_url\(url: str\) -> bool:/);
    expect(cv).toMatch(/is_private or .*is_loopback or .*is_link_local/);
    expect(cv).toMatch(/if not _is_public_http_url\(url\):/);
    expect(cv).toMatch(/allow_redirects=False/);
  });
  it('the detector fails closed when no auth token is configured and uses a constant-time compare', () => {
    expect(cv).toMatch(/ALLOW_NO_AUTH/);
    expect(cv).toMatch(/hmac\.compare_digest/);
    expect(cv).toMatch(/auth not configured/);
  });
});

describe('source-level security invariants (frontend XSS hardening)', () => {
  it('map InfoWindow/marker builders escape interpolated values (no raw innerHTML interpolation)', () => {
    expect(appSource).toMatch(/function escapeHtml\(/);
    expect(appSource).toMatch(/\$\{escapeHtml\(crossing\.name\)\}/);
    expect(appSource).toMatch(/\$\{escapeHtml\(sourceMeta\.label\)\}/);
    expect(appSource).toMatch(/\$\{escapeHtml\(route\.label\)\}/);
    // The previously-raw interpolations must no longer appear unescaped in the builders.
    expect(appSource).not.toMatch(/<strong>\$\{crossing\.name\}<\/strong>/);
  });
});
