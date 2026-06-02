// Camera direction safety (spec §2): a camera frame shows ONE side of the border.
// We derive each camera's valid direction from its Croatian label and mark ambiguous
// cameras visualOnly so they never contaminate the opposite direction's wait.
import { describe, it, expect } from 'vitest';
import { CAMERA_FEEDS, inferCameraDirections, cameraRelevantForDirection } from '../../server/index.js';

function cam(crossingId, cameraId) {
  return (CAMERA_FEEDS[crossingId] || []).find((c) => c.id === cameraId);
}

describe('label-based direction inference', () => {
  it('"ulaz u HR" → entering Croatia → toHr', () => {
    expect(inferCameraDirections({ label: 'Slavonski Brod · ulaz u HR' })).toEqual(['toHr']);
  });
  it('"izlaz iz HR" → leaving Croatia → toBih', () => {
    expect(inferCameraDirections({ label: 'Bijača · izlaz iz HR' })).toEqual(['toBih']);
  });
  it('"Ulaz u HR iz BiH" → toHr', () => {
    expect(inferCameraDirections({ label: 'Ulaz u HR iz BiH' })).toEqual(['toHr']);
  });
  it('"Izlaz iz HR u BiH" → toBih', () => {
    expect(inferCameraDirections({ label: 'Izlaz iz HR u BiH' })).toEqual(['toBih']);
  });
  it('"Ulaz u Republiku Srpsku" → entering BiH → toBih', () => {
    expect(inferCameraDirections({ label: 'Ulaz u Republiku Srpsku' })).toEqual(['toBih']);
  });
  it('"Izlaz iz Republike Srpske" → toHr', () => {
    expect(inferCameraDirections({ label: 'Izlaz iz Republike Srpske' })).toEqual(['toHr']);
  });
  it('an ambiguous label cannot be proven (returns null)', () => {
    expect(inferCameraDirections({ label: 'Velika Kladuša' })).toBeNull();
    expect(inferCameraDirections({ label: 'Bosanska Gradiška / HAK' })).toBeNull();
  });
});

describe('CAMERA_FEEDS are annotated for direction safety', () => {
  it('every camera has validForDirections and a visualOnly flag', () => {
    for (const feeds of Object.values(CAMERA_FEEDS)) {
      for (const camera of feeds) {
        expect(Array.isArray(camera.validForDirections), `${camera.id} missing validForDirections`).toBe(true);
        expect(typeof camera.visualOnly, `${camera.id} missing visualOnly`).toBe('boolean');
      }
    }
  });

  it('the Maljevac entry/exit HAK cameras are split by direction', () => {
    expect(cam('maljevac', 'mal-hak-hr-entry').validForDirections).toEqual(['toHr']);
    expect(cam('maljevac', 'mal-hak-hr-exit').validForDirections).toEqual(['toBih']);
  });

  it('the Gradiška AMS RS in/out cameras are split by direction', () => {
    expect(cam('gradiska', 'gra-rs-in').validForDirections).toEqual(['toBih']);
    expect(cam('gradiska', 'gra-rs-out').validForDirections).toEqual(['toHr']);
  });

  it('an ambiguous wide-area camera is visualOnly (no hard wait contribution)', () => {
    expect(cam('maljevac', 'mal-bihamk-kladusa').visualOnly).toBe(true);
  });

  it('a camera is never valid for a direction it cannot prove', () => {
    for (const feeds of Object.values(CAMERA_FEEDS)) {
      for (const camera of feeds) {
        if (camera.visualOnly) expect(camera.validForDirections).toEqual([]);
      }
    }
  });
});

describe('direction-relevant display band (Maljevac opposite-lane leak fix)', () => {
  it('the "izlaz iz HR" (toBih) camera does NOT bleed into the BiH→HR (toHr) band', () => {
    expect(cameraRelevantForDirection(cam('maljevac', 'mal-hak-hr-exit'), 'toHr')).toBe(false);
    expect(cameraRelevantForDirection(cam('maljevac', 'mal-hak-hr-exit'), 'toBih')).toBe(true);
  });
  it('the "ulaz u HR" (toHr) camera is relevant for BiH→HR, not for HR→BiH', () => {
    expect(cameraRelevantForDirection(cam('maljevac', 'mal-hak-hr-entry'), 'toHr')).toBe(true);
    expect(cameraRelevantForDirection(cam('maljevac', 'mal-hak-hr-entry'), 'toBih')).toBe(false);
  });
  it('an ambiguous (no-direction) camera is relevant to both directions', () => {
    expect(cameraRelevantForDirection(cam('maljevac', 'mal-bihamk-kladusa'), 'toHr')).toBe(true);
    expect(cameraRelevantForDirection(cam('maljevac', 'mal-bihamk-kladusa'), 'toBih')).toBe(true);
  });
});

describe('direction-relevant display band with explicit cameras present', () => {
  it('an ambiguous visual camera does not bleed into both directions when that side has an explicit camera', () => {
    const feeds = CAMERA_FEEDS.maljevac;
    expect(cameraRelevantForDirection(cam('maljevac', 'mal-bihamk-kladusa'), 'toHr', feeds)).toBe(false);
    expect(cameraRelevantForDirection(cam('maljevac', 'mal-bihamk-kladusa'), 'toBih', feeds)).toBe(false);
  });

  it('an ambiguous visual camera remains relevant when it is the only available visual clue for that side', () => {
    const feeds = [cam('maljevac', 'mal-bihamk-kladusa')];
    expect(cameraRelevantForDirection(feeds[0], 'toHr', feeds)).toBe(true);
    expect(cameraRelevantForDirection(feeds[0], 'toBih', feeds)).toBe(true);
  });
});
