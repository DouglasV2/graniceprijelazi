// Source-fusion priority model (2026-05-29).
// Goal: a clear/blue Google route must NEVER cap the wait below a higher-priority signal
// (official hard public number, strong camera queue, recent strong driver report). This must
// hold for EVERY crossing, not just Gornji Varoš. Tested through applyTrafficSanityCaps, the
// decisive gate, plus PUBLIC_SOURCE_TARGETS / CAMERA_FEEDS config guards.

import { describe, it, expect } from 'vitest';
import {
  applyTrafficSanityCaps,
  PUBLIC_SOURCE_TARGETS,
  CAMERA_FEEDS,
} from '../../server/index.js';

function googleClear(wait = 6) {
  return { sourceType: 'google-traffic-estimate', sourceName: 'Google Routes', normalizedWaitMin: wait, confidence: 70, weight: 0.84, metadata: { delayMinutes: 1, ratio: 1.02, level: 'normal' } };
}
function googleSlow() {
  return { sourceType: 'google-traffic-estimate', sourceName: 'Google Routes', normalizedWaitMin: 14, confidence: 70, weight: 0.84, metadata: { delayMinutes: 5, ratio: 1.2, level: 'slow' } };
}
function googleHeavy() {
  return { sourceType: 'google-traffic-estimate', sourceName: 'Google Routes', normalizedWaitMin: 40, confidence: 70, weight: 0.84, metadata: { delayMinutes: 12, ratio: 1.5, level: 'heavy' } };
}
function hardPublic(wait, name = 'HAK') {
  return { sourceType: 'public-text-status', sourceName: name, normalizedWaitMin: wait, rawStatus: `Eksplicitno čekanje ${wait} min`, rawText: '', confidence: 90, weight: 1.35, metadata: {} };
}
function softPublic(wait = 10) {
  return { sourceType: 'public-text-status', sourceName: 'BIHAMK', normalizedWaitMin: wait, rawStatus: 'Zadržavanja nisu duža od 30 min', rawText: 'Zadržavanja nisu duža od 30 min', confidence: 62, weight: 0.42, metadata: { softUpperBound: true } };
}
function cameraQueue(wait = 40, queueVehicles = 24) {
  return { sourceType: 'camera-snapshot-model', sourceName: 'Kamera', normalizedWaitMin: wait, confidence: 60, weight: 0.72, fetchedAt: new Date().toISOString(), metadata: { queueVehicles, flowVehicles15: 5, passed15: 5 } };
}

describe('Google clear must never cap an authoritative signal', () => {
  it('HAK 90 + Google blue → stays 90 (the headline scenario)', () => {
    const out = applyTrafficSanityCaps(90, { googleSignal: googleClear(8), publicSignals: [hardPublic(90)] });
    expect(out.wait).toBe(90);
    expect(out.googleVsOfficial).toBe(true);
    expect(out.reason).toContain('graničn');
  });

  it('official 60 but blend diluted to 18 → floored back up to 60', () => {
    const out = applyTrafficSanityCaps(18, { googleSignal: googleClear(8), publicSignals: [hardPublic(60)] });
    expect(out.wait).toBe(60);
  });

  it('strong camera queue + Google blue → not capped to 25', () => {
    const out = applyTrafficSanityCaps(40, { googleSignal: googleClear(8), cameraSignal: cameraQueue(40, 24), publicSignals: [] });
    expect(out.wait).toBe(40);
  });

  it('recent strong driver report (45) + Google blue → not capped', () => {
    const out = applyTrafficSanityCaps(45, { googleSignal: googleClear(8), publicSignals: [], reportAvg: 45 });
    expect(out.wait).toBe(45);
  });

  it('Google slow + hard public 80 → kept 80 (official beats yellow road)', () => {
    const out = applyTrafficSanityCaps(80, { googleSignal: googleSlow(), publicSignals: [hardPublic(80)] });
    expect(out.wait).toBe(80);
  });
});

describe('Google may still hold a low estimate when nothing authoritative disagrees', () => {
  it('Google blue + only soft public + clear camera → capped to 15', () => {
    const out = applyTrafficSanityCaps(45, {
      googleSignal: googleClear(6),
      cameraSignal: { sourceType: 'camera-snapshot-model', normalizedWaitMin: 8, metadata: { queueVehicles: 2, flowVehicles15: 14 } },
      publicSignals: [softPublic(10)],
    });
    expect(out.wait).toBe(15);
  });

  it('Google blue + no other signal → capped to 15', () => {
    const out = applyTrafficSanityCaps(40, { googleSignal: googleClear(6), publicSignals: [] });
    expect(out.wait).toBe(15);
  });

  it('Google slow + no authoritative → capped to 35', () => {
    const out = applyTrafficSanityCaps(70, { googleSignal: googleSlow(), publicSignals: [] });
    expect(out.wait).toBe(35);
  });

  it('Google heavy (red) → no cap', () => {
    const out = applyTrafficSanityCaps(70, { googleSignal: googleHeavy(), publicSignals: [] });
    expect(out.wait).toBe(70);
    expect(out.adjusted).toBe(false);
  });

  it('soft public weak number does NOT count as authoritative', () => {
    // softPublic has softUpperBound metadata so it is not a hard number → Google cap applies.
    const out = applyTrafficSanityCaps(50, { googleSignal: googleClear(6), publicSignals: [softPublic(30)] });
    expect(out.wait).toBe(15);
  });
});

describe('PUBLIC_SOURCE_TARGETS — gornji-varos added without alias collision', () => {
  it('gornji-varos target exists with HAK-first preference', () => {
    const t = PUBLIC_SOURCE_TARGETS['gornji-varos'];
    expect(t).toBeTruthy();
    expect(t.preferred[0]).toBe('HAK');
    expect(t.preferred).toContain('MUP');
  });

  it('gornji-varos matches the "novi most" naming used by HAK/BIHAMK', () => {
    const t = PUBLIC_SOURCE_TARGETS['gornji-varos'];
    expect(t.hakNames.some((n) => /novi most/i.test(n))).toBe(true);
    expect(t.hakNames).toContain('Gornji Varoš');
    expect(t.bihamkNames).toContain('Gradiška Novi Most');
  });

  it('gradiška aliases do not contain a bare "novi most" token that would steal gornji-varos data', () => {
    const g = PUBLIC_SOURCE_TARGETS.gradiska;
    expect(g.bihamkNames.some((n) => /novi most/i.test(n))).toBe(false);
  });
});

describe('CAMERA_FEEDS gornji-varos uses the real HAK image ids through the generic camera system', () => {
  function cam(id) {
    return (CAMERA_FEEDS['gornji-varos'] || []).find((c) => c.id === id);
  }
  it('gv-hak-queue-9 → info/kamere/1021.jpg, page k=303', () => {
    const c = cam('gv-hak-queue-9');
    expect(c.imageUrls[0]).toBe('https://www.hak.hr/info/kamere/1021.jpg');
    expect(c.url).toBe('https://m.hak.hr/kamera.asp?g=2&k=303');
    expect(c.externalUrl).toBe('https://m.hak.hr/kamera.asp?g=2&k=303');
    expect(c.calibration).toBeTruthy();
  });
  it('gv-hak-plaza-4 → info/kamere/1022.jpg, page k=303', () => {
    const c = cam('gv-hak-plaza-4');
    expect(c.imageUrls[0]).toBe('https://www.hak.hr/info/kamere/1022.jpg');
    expect(c.url).toBe('https://m.hak.hr/kamera.asp?g=2&k=303');
  });
  it('neither camera uses the wrong 303.jpg direct image id', () => {
    expect(cam('gv-hak-queue-9').imageUrls.some((u) => /\/303\.jpg/.test(u))).toBe(false);
    expect(cam('gv-hak-plaza-4').imageUrls.some((u) => /\/303\.jpg/.test(u))).toBe(false);
  });
});
