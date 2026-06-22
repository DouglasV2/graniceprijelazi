// Trip Pass billing (Stripe). The Stripe client is stubbed via setStripeClientForTests so we exercise
// checkout-session creation, the webhook → entitlement grant, and the free-vs-pass alert gate — no
// real Stripe calls. A fresh free user is minted through the (stubbed) Google sign-in for clean state.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getApp } from '../helpers/app-loader.js';

let app;
let mod;
let token;
let userId;

// Unique per run so the test user is genuinely fresh (data/runtime-store.json persists across runs).
const billingEmail = `billinguser-${Date.now()}@example.com`;

beforeAll(async () => {
  app = await getApp();
  mod = await import('../../server/index.js');
  mod.setGoogleIdVerifier(async () => ({ googleId: `g-bill-${Date.now()}`, email: billingEmail, name: 'Bill', picture: null }));
  mod.setStripeClientForTests({
    checkout: { sessions: { create: async (params) => ({ id: 'cs_test_123', url: 'https://checkout.stripe.test/cs_test_123', _params: params }) } },
    webhooks: { constructEvent: (raw) => JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)) },
  });
  const reg = await request(app).post('/api/auth/google').send({ credential: 'mint-billing-user' });
  token = reg.body.token;
  userId = reg.body.user.id;
});

afterAll(() => {
  mod.setGoogleIdVerifier(null);
});

const auth = (r) => r.set('Authorization', `Bearer ${token}`);

describe('Trip Pass billing', () => {
  it('exposes billing config with both products available', async () => {
    const res = await request(app).get('/api/billing/config');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.products.trippass24h.available).toBe(true);
    expect(res.body.products.monthly.available).toBe(true);
  });

  it('a fresh account starts on the free plan (no active pass)', async () => {
    const me = await auth(request(app).get('/api/auth/me'));
    expect(me.body.user.entitlements.hasActivePass).toBe(false);
  });

  it('checkout requires authentication', async () => {
    const res = await request(app).post('/api/billing/checkout').send({ product: 'trippass24h' });
    expect([401, 403]).toContain(res.status);
  });

  it('checkout returns a Stripe hosted URL for a valid product', async () => {
    const res = await auth(request(app).post('/api/billing/checkout')).send({ product: 'trippass24h' });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/checkout\.stripe/);
    const bad = await auth(request(app).post('/api/billing/checkout')).send({ product: 'nope' });
    expect(bad.status).toBe(400);
  });

  it('free plan is limited to 1 active alert (the 2nd is payment-required)', async () => {
    const first = await auth(request(app).post('/api/alerts/subscribe')).send({ crossingId: 'maljevac', direction: 'toBih' });
    expect(first.status).toBe(201);
    const second = await auth(request(app).post('/api/alerts/subscribe')).send({ crossingId: 'maljevac', direction: 'toHr' });
    expect(second.status).toBe(402);
    expect(second.body.upgrade).toBe(true);
  });

  it('a Stripe webhook (checkout.session.completed, payment) grants a 24h Trip Pass', async () => {
    const event = { type: 'checkout.session.completed', data: { object: { mode: 'payment', client_reference_id: userId, customer: 'cus_test' } } };
    const hook = await request(app).post('/api/billing/webhook').set('stripe-signature', 't=1,v1=stub').send(event);
    expect(hook.status).toBe(200);
    expect(hook.body.received).toBe(true);
    const me = await auth(request(app).get('/api/auth/me'));
    expect(me.body.user.entitlements.hasActivePass).toBe(true);
    expect(typeof me.body.user.entitlements.tripPassUntil).toBe('string');
  });

  it('with an active pass, alerts are no longer limited', async () => {
    const res = await auth(request(app).post('/api/alerts/subscribe')).send({ crossingId: 'bijaca', direction: 'toBih' });
    expect(res.status).toBe(201);
  });

  it('userHasActivePass is correct at the boundary', () => {
    const now = Date.UTC(2026, 0, 1);
    expect(mod.userHasActivePass({ tripPassUntil: new Date(now + 1000).toISOString() }, now)).toBe(true);
    expect(mod.userHasActivePass({ tripPassUntil: new Date(now - 1000).toISOString() }, now)).toBe(false);
    expect(mod.userHasActivePass({ subscriptionStatus: 'active', subscriptionUntil: new Date(now + 1000).toISOString() }, now)).toBe(true);
    expect(mod.userHasActivePass({ subscriptionStatus: 'canceled', subscriptionUntil: new Date(now + 1000).toISOString() }, now)).toBe(false);
    expect(mod.userHasActivePass(null, now)).toBe(false);
  });
});
