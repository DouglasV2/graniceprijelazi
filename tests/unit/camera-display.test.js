import { describe, it, expect } from 'vitest';
import { cameraEstimateDecision, freshnessLabelFromAge, buildCameraQueueLabel, buildCameraTrustText, cameraStatusCopy } from '../../src/utils/camera-display.js';

describe('cameraEstimateDecision (UI must not show false camera estimates)', () => {
  it('a visual-only / not-camera-driven camera is NOT usable', () => {
    expect(cameraEstimateDecision({ cameraEstimateReliable: false, waitIsCameraDriven: false, wait: 11 }).usable).toBe(false);
    expect(cameraEstimateDecision({ cameraEstimateReliable: true, waitIsCameraDriven: false, wait: 11 }).usable).toBe(false);
  });

  it('a reliable, camera-driven, non-contradicting camera IS usable', () => {
    const d = cameraEstimateDecision({ cameraEstimateReliable: true, waitIsCameraDriven: true, wait: 25 }, 28);
    expect(d.usable).toBe(true);
    expect(d.contradictsOfficial).toBe(false);
  });

  it('a camera that contradicts the official headline is NOT usable (defer to official)', () => {
    // The Maljevac screenshot: camera 2 min vs official 42 min.
    const d = cameraEstimateDecision({ cameraEstimateReliable: true, waitIsCameraDriven: true, wait: 2 }, 42);
    expect(d.contradictsOfficial).toBe(true);
    expect(d.usable).toBe(false);
  });

  it('no headline wait → not treated as contradiction', () => {
    const d = cameraEstimateDecision({ cameraEstimateReliable: true, waitIsCameraDriven: true, wait: 20 }, null);
    expect(d.usable).toBe(true);
  });
});

describe('freshnessLabelFromAge (stale must read as stale)', () => {
  it('marks old estimates stale', () => {
    const r = freshnessLabelFromAge(60 * 60);
    expect(r.stale).toBe(true);
    expect(r.label).toMatch(/stara procjena/);
  });
  it('fresh under a minute', () => {
    expect(freshnessLabelFromAge(30).stale).toBe(false);
    expect(freshnessLabelFromAge(30).label).toBe('upravo ažurirano');
  });
  it('null age → waiting, not stale', () => {
    expect(freshnessLabelFromAge(null)).toEqual({ label: 'čeka osvježenje', stale: false });
  });
});


describe('camera queue label honesty', () => {
  it('a visible medium queue (heuristic/no ROI) reads as a possible queue, never confident "Srednja kolona"', () => {
    const label = buildCameraQueueLabel({ queueBandLabel: 'Srednja kolona', cvUsed: false }, { estimateUsable: false });
    expect(label).toBe('Kamera prikazuje moguću kolonu');
    expect(label).not.toBe('Srednja kolona');
  });

  it('shows a precise queue label only for a calibrated + TRUSTED AI signal', () => {
    expect(buildCameraQueueLabel({ cvUsed: true, roiFeatures: { roiCalibrated: true, roiTrusted: true, vehiclesInQueueRoi: 7 } }, { estimateUsable: false })).toBe('AI kamera vidi 7 vozila u koloni');
  });

  it('explains no-ROI as "not fully calibrated" (no raw technical token)', () => {
    const txt = buildCameraTrustText({ cvUsed: true, roiFeatures: { roiCalibrated: false } });
    expect(txt).toMatch(/nije potpuno kalibrirana/);
    expect(txt).not.toMatch(/no-detection|YOLO|fallback/i);
  });
});

describe('Maljevac-style seeded/unverified ROI must NOT claim "no queue" (roiTrusted gate)', () => {
  // Seeded ROI (needsEditorReview) → computeRoiCameraFeatures sets roiTrusted:false. A 0-count in a
  // possibly mis-mapped seeded ROI must read as a neutral visual check, never "AI kamera ne vidi kolonu".
  it('calibrated-but-untrusted ROI with 0 vehicles → neutral visual-check label', () => {
    const label = buildCameraQueueLabel({ cvUsed: true, roiFeatures: { roiCalibrated: true, roiTrusted: false, vehiclesInQueueRoi: 0 } }, { estimateUsable: false });
    expect(label).toBe('Kamera dostupna za vizualnu provjeru');
    expect(label).not.toMatch(/ne vidi kolonu/);
  });
  it('no-detections + untrusted ROI → neutral, never a confident "no queue"', () => {
    const label = buildCameraQueueLabel({ cvUsed: true, cvFallbackReason: 'no-detections', roiFeatures: { roiCalibrated: true, roiTrusted: false } }, { estimateUsable: false });
    expect(label).not.toMatch(/ne vidi kolonu/);
  });
  it('the trust text for an untrusted ROI says "nije dovoljno kalibrirana", not a verdict', () => {
    const txt = buildCameraTrustText({ cvUsed: true, roiFeatures: { roiCalibrated: true, roiTrusted: false } });
    expect(txt).toMatch(/nije dovoljno kalibrirana/);
    expect(txt).not.toMatch(/ne vidi kolonu/);
  });
  it('a TRUSTED, calibrated ROI with 0 vehicles MAY say "ne vidi kolonu" (genuinely empty)', () => {
    const label = buildCameraQueueLabel({ cvUsed: true, roiFeatures: { roiCalibrated: true, roiTrusted: true, vehiclesInQueueRoi: 0 } }, { estimateUsable: false });
    expect(label).toBe('AI kamera ne vidi kolonu');
  });
});

describe('cameraStatusCopy never leaks raw fallback tokens to the user', () => {
  it('no-detections reads as an empty frame, NOT an outage', () => {
    expect(cameraStatusCopy('no-detections')).toBe('AI nije pronašao vozila u ovom kadru.');
    expect(cameraStatusCopy('no-detections')).not.toMatch(/nedostup|YOLO/i);
  });
  it('missing endpoint reads as not configured', () => {
    expect(cameraStatusCopy('no-endpoint')).toBe('AI detekcija nije konfigurirana.');
    expect(cameraStatusCopy('disabled')).toBe('AI detekcija nije konfigurirana.');
  });
  it('timeout / http error reads as temporarily unavailable, no raw token', () => {
    for (const reason of ['timeout', 'http-502', 'error', 'invalid-json', 'no-image']) {
      const txt = cameraStatusCopy(reason);
      expect(txt).toBe('AI detekcija trenutno nije dostupna.');
      expect(txt).not.toMatch(/502|timeout|json|http/i);
    }
  });
  it('the camera trust text never contains a raw fallback token', () => {
    const txt = buildCameraTrustText({ cvUsed: false, cvFallbackReason: 'http-502' });
    expect(txt).not.toMatch(/http-502|502/);
    expect(txt).toMatch(/vizualna provjera/);
  });
});
