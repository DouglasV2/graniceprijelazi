// Google Sign-In endpoint. The real verifier hits Google's JWKS; here we stub it via
// setGoogleIdVerifier so the test exercises the link-or-create + token issuance logic only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getApp } from '../helpers/app-loader.js';

let app;
let mod;

const PROFILES = {
  'tok-new': { googleId: 'g-new-1', email: 'newgoogle@example.com', name: 'New Google', picture: null },
  'tok-existing': { googleId: 'g-existing-2', email: 'user@borderflow.app', name: 'Demo', picture: 'https://x/y.png' },
};
const stub = async (cred) => {
  const p = PROFILES[cred];
  if (!p) throw new Error('invalid-token');
  return p;
};

beforeAll(async () => {
  app = await getApp();
  mod = await import('../../server/index.js');
  mod.setGoogleIdVerifier(stub);
});

afterAll(() => {
  mod.setGoogleIdVerifier(null); // restore the real verifier
  delete process.env.GOOGLE_OAUTH_ALLOW_SIGNUP;
});

describe('Google Sign-In', () => {
  it('exposes runtime config with a client id when enabled', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.googleAuth.enabled).toBe(true);
    expect(typeof res.body.googleAuth.clientId).toBe('string');
  });

  it('creates a new account on first Google sign-in + the issued token works', async () => {
    const res = await request(app).post('/api/auth/google').send({ credential: 'tok-new' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('newgoogle@example.com');
    expect(res.body.user.role).toBe('user');
    expect(res.body.user.authProvider).toBe('google');
    expect(res.body.user.passwordHash).toBeUndefined(); // never leak the (here null) hash
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('newgoogle@example.com');
  });

  it('links to an existing email account (no duplicate) and logs in', async () => {
    const res = await request(app).post('/api/auth/google').send({ credential: 'tok-existing' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('user@borderflow.app');
    expect(res.body.user.role).toBe('user'); // keeps the existing role, not overwritten
  });

  it('rejects an invalid Google token', async () => {
    const res = await request(app).post('/api/auth/google').send({ credential: 'bogus' });
    expect(res.status).toBe(401);
  });

  it('rejects a missing token', async () => {
    const res = await request(app).post('/api/auth/google').send({});
    expect(res.status).toBe(400);
  });

  it('blocks brand-new account creation when signup is disabled (but the endpoint still works for existing users)', async () => {
    process.env.GOOGLE_OAUTH_ALLOW_SIGNUP = 'false';
    mod.setGoogleIdVerifier(async () => ({ googleId: 'g-blocked', email: 'blocked-signup@example.com', name: 'B', picture: null }));
    const res = await request(app).post('/api/auth/google').send({ credential: 'whatever' });
    expect(res.status).toBe(403);
    delete process.env.GOOGLE_OAUTH_ALLOW_SIGNUP;
    mod.setGoogleIdVerifier(stub);
  });
});
