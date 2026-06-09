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
    expect(label).toBe('Kamera pokazuje moguću kolonu');
    expect(label).not.toBe('Srednja kolona');
  });

  it('shows a precise queue label only for a reviewed + reliable camera signal (plain wording, no "AI")', () => {
    const label = buildCameraQueueLabel({ cvUsed: true, roiFeatures: { roiCalibrated: true, roiTrusted: true, vehiclesInQueueRoi: 7 } }, { estimateUsable: false });
    expect(label).toBe('Kamera broji 7 vozila u koloni');
    expect(label).not.toMatch(/\bAI\b/);
  });

  it('explains a not-yet-reliable camera in plain language (no jargon, no raw token)', () => {
    const txt = buildCameraTrustText({ cvUsed: true, roiFeatures: { roiCalibrated: false } });
    expect(txt).toMatch(/ne broji posve točno/);
    expect(txt).not.toMatch(/no-detection|YOLO|fallback|ROI|\bAI\b/i);
  });
});

describe('Maljevac-style seeded/unverified ROI must NOT claim "no queue" (roiTrusted gate)', () => {
  // Seeded ROI (needsEditorReview) → computeRoiCameraFeatures sets roiTrusted:false. A 0-count in a
  // possibly mis-mapped seeded ROI must read as a neutral visual check, never "AI kamera ne vidi kolonu".
  it('calibrated-but-untrusted ROI with 0 vehicles → neutral check-on-image label', () => {
    const label = buildCameraQueueLabel({ cvUsed: true, roiFeatures: { roiCalibrated: true, roiTrusted: false, vehiclesInQueueRoi: 0 } }, { estimateUsable: false });
    expect(label).toBe('Provjeri kolonu na slici uživo');
    expect(label).not.toMatch(/ne vidi kolonu/);
  });
  it('no-detections + untrusted ROI → neutral, never a confident "no queue"', () => {
    const label = buildCameraQueueLabel({ cvUsed: true, cvFallbackReason: 'no-detections', roiFeatures: { roiCalibrated: true, roiTrusted: false } }, { estimateUsable: false });
    expect(label).not.toMatch(/ne vidi kolonu/);
  });
  it('the trust text for an untrusted ROI hedges in plain language, not a verdict', () => {
    const txt = buildCameraTrustText({ cvUsed: true, roiFeatures: { roiCalibrated: true, roiTrusted: false } });
    expect(txt).toMatch(/ne broji točan broj/);
    expect(txt).not.toMatch(/ne vidi kolonu|\bAI\b|ROI/);
  });
  it('a reviewed + reliable camera with 0 vehicles MAY say "ne vidi kolonu" (genuinely empty)', () => {
    const label = buildCameraQueueLabel({ cvUsed: true, roiFeatures: { roiCalibrated: true, roiTrusted: true, vehiclesInQueueRoi: 0 } }, { estimateUsable: false });
    expect(label).toBe('Kamera ne vidi kolonu');
  });
});

describe('cameraStatusCopy never leaks raw fallback tokens to the user + plain language', () => {
  it('no-detections reads as an empty frame, NOT an outage, no jargon', () => {
    expect(cameraStatusCopy('no-detections')).toBe('Kamera trenutno ne vidi vozila na slici.');
    expect(cameraStatusCopy('no-detections')).not.toMatch(/nedostup|YOLO|\bAI\b/i);
  });
  it('missing endpoint reads as not configured', () => {
    expect(cameraStatusCopy('no-endpoint')).toBe('Provjera s kamere nije uključena.');
    expect(cameraStatusCopy('disabled')).toBe('Provjera s kamere nije uključena.');
  });
  it('timeout / http error reads as temporarily unavailable, no raw token', () => {
    for (const reason of ['timeout', 'http-502', 'error', 'invalid-json', 'no-image']) {
      const txt = cameraStatusCopy(reason);
      expect(txt).toBe('Provjera s kamere trenutno nije dostupna.');
      expect(txt).not.toMatch(/502|timeout|json|http/i);
    }
  });
  it('the camera trust text never contains a raw fallback token', () => {
    const txt = buildCameraTrustText({ cvUsed: false, cvFallbackReason: 'http-502' });
    expect(txt).not.toMatch(/http-502|502/);
    expect(txt).toMatch(/za provjeru na slici/);
  });
});

describe('camera copy is driver-friendly (no AI/ROI/YOLO/kalibr jargon)', () => {
  const samples = [
    buildCameraQueueLabel({ queueBandLabel: 'Srednja kolona', cvUsed: false }),
    buildCameraQueueLabel({ cvUsed: true, roiFeatures: { roiCalibrated: true, roiTrusted: true, vehiclesInQueueRoi: 7 } }),
    buildCameraQueueLabel({ cvUsed: true, roiFeatures: { roiCalibrated: true, roiTrusted: false, vehiclesInQueueRoi: 0 } }),
    buildCameraQueueLabel({ cvUsed: true, roiFeatures: { roiCalibrated: false } }),
    buildCameraTrustText({ cvUsed: true, roiFeatures: { roiCalibrated: true, roiTrusted: false } }),
    buildCameraTrustText({ cvUsed: true, roiFeatures: { roiCalibrated: false } }),
    buildCameraTrustText({ cvUsed: false, cvFallbackReason: 'no-detections' }),
    cameraStatusCopy('no-detections'), cameraStatusCopy('no-endpoint'), cameraStatusCopy('timeout'),
  ];
  it('none of the user-facing camera strings contain AI / ROI / YOLO / kalibr / vizualn', () => {
    for (const s of samples) {
      expect(s).not.toMatch(/\bAI\b|ROI|YOLO|kalibr|vizualn/i);
    }
  });
});
