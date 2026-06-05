// Live-location wait signal — pure logic (server-authoritative lifecycle + outlier-safe aggregate).
import { describe, it, expect } from 'vitest';
import { withinAnchor, classifyLocationPing, aggregateVerifiedLocation, trimmedMedian } from '../../server/location-wait.js';

const anchors = {
  startAnchor: { id: 's', lat: 45.000, lng: 16.000, radiusM: 140 },
  borderAnchor: { id: 'b', lat: 45.010, lng: 16.000 },
  endAnchor: { id: 'e', lat: 45.020, lng: 16.000, radiusM: 160 },
  maxSessionMinutes: 240,
};
const atStart = { lat: 45.0000, lng: 16.0000, accuracyM: 20 };
const atEnd = { lat: 45.0200, lng: 16.0000, accuracyM: 20 };
const farAway = { lat: 45.500, lng: 16.500, accuracyM: 20 };

describe('withinAnchor', () => {
  it('true at the anchor, false far away', () => {
    expect(withinAnchor(atStart, anchors.startAnchor)).toBe(true);
    expect(withinAnchor(farAway, anchors.startAnchor)).toBe(false);
  });
});

describe('classifyLocationPing — server-authoritative lifecycle', () => {
  it('a ping OUTSIDE the start zone keeps the session pending', () => {
    const r = classifyLocationPing({ status: 'pending' }, farAway, anchors, { now: 1_000_000 });
    expect(r.status).toBe('pending');
    expect(r.transitioned).toBe(false);
  });
  it('a ping INSIDE the start zone activates + stamps a SERVER start time', () => {
    const r = classifyLocationPing({ status: 'pending' }, atStart, anchors, { now: 1_000_000 });
    expect(r.status).toBe('active');
    expect(r.serverStartedAt).toBeTruthy();
    expect(r.transitioned).toBe(true);
  });
  it('a ping INSIDE the end zone completes + measures wait from SERVER timestamps (not client)', () => {
    const startedIso = new Date(1_000_000).toISOString();
    const now = 1_000_000 + 17 * 60_000; // 17 min later
    const r = classifyLocationPing({ status: 'active', serverStartedAt: startedIso }, atEnd, anchors, { now });
    expect(r.status).toBe('completed');
    expect(r.measuredWaitMin).toBe(17);
  });
  it('rejects a low-accuracy fix without changing state', () => {
    const r = classifyLocationPing({ status: 'pending' }, { ...atStart, accuracyM: 500 }, anchors, { now: 1, maxAccuracyM: 100 });
    expect(r.status).toBe('pending');
    expect(r.rejectionReason).toBe('low-accuracy');
  });
  it('expires an active session that exceeds maxSessionMinutes (no fake 6h wait)', () => {
    const startedIso = new Date(1_000_000).toISOString();
    const now = 1_000_000 + 300 * 60_000; // 5h later, > 240 cap
    const r = classifyLocationPing({ status: 'active', serverStartedAt: startedIso }, atEnd, anchors, { now });
    expect(r.status).toBe('expired');
  });
  it('no anchor config → no-op with reason', () => {
    expect(classifyLocationPing({ status: 'pending' }, atStart, null).rejectionReason).toBe('no-anchor-config');
  });
  it('a completed/cancelled session is terminal', () => {
    expect(classifyLocationPing({ status: 'completed' }, atEnd, anchors).rejectionReason).toMatch(/terminal/);
  });
});

describe('aggregateVerifiedLocation — outlier-safe + age-aware', () => {
  const now = 2_000_000_000_000;
  const session = (waitMin, ageMin) => ({ status: 'completed', measuredWaitMin: waitMin, serverCompletedAt: new Date(now - ageMin * 60_000).toISOString() });

  it('no completed sessions → not available', () => {
    expect(aggregateVerifiedLocation([], { now }).available).toBe(false);
  });
  it('one outlier does not dominate (median over [15,17,60] = 17)', () => {
    const agg = aggregateVerifiedLocation([session(15, 5), session(17, 6), session(60, 7)], { now });
    expect(agg.medianWaitMin).toBe(17);
    expect(agg.maxWaitMin).toBe(60);
  });
  it('more fresh agreeing samples → higher confidence', () => {
    const one = aggregateVerifiedLocation([session(17, 5)], { now });
    const three = aggregateVerifiedLocation([session(16, 5), session(17, 6), session(18, 7)], { now });
    expect(three.confidence).toBeGreaterThan(one.confidence);
    expect(three.freshSampleCount).toBe(3);
  });
  it('stale-only signal is available but weak (low confidence, freshSampleCount 0)', () => {
    const agg = aggregateVerifiedLocation([session(20, 120)], { now, maxAgeMin: 45 });
    expect(agg.available).toBe(true);
    expect(agg.freshSampleCount).toBe(0);
    expect(agg.confidence).toBeLessThan(50);
  });
  it('trimmedMedian drops the extremes once n>=4', () => {
    expect(trimmedMedian([1, 16, 17, 18, 200])).toBe(17);
  });
});
