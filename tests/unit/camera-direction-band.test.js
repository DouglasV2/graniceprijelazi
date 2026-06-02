// Directional visual-band isolation (Problem B: "gužva se javlja u oba smjera iako na jednoj
// kameri/smjeru nema gužve"). The displayBand for a direction is built ONLY from rows that pass
// `cameraRelevantForDirection(camera, direction, allCameras)`. These tests assert that filter —
// the single gate that decides which cameras drive a direction's band — exactly matches the spec.
import { describe, it, expect } from 'vitest';
import { cameraRelevantForDirection } from '../../server/index.js';

// Scenario from the spec: camera A is explicit for BIH_TO_HR (toHr) and shows a jam; camera B is
// explicit for HR_TO_BIH (toBih) and is clear. The jam on A must NOT reach toBih's band.
const camA = { id: 'A', label: 'ulaz u HR', validForDirections: ['toHr'] };
const camB = { id: 'B', label: 'izlaz iz HR', validForDirections: ['toBih'] };
const camAmbiguous = { id: 'X', label: 'Velika Kladuša', validForDirections: [] };
const allExplicit = [camA, camB];

describe('explicit-direction cameras never drive the opposite direction band', () => {
  it('camera valid only for toHr is not relevant for toBih', () => {
    expect(cameraRelevantForDirection(camA, 'toBih', allExplicit)).toBe(false);
  });
  it('camera valid only for toBih is not relevant for toHr', () => {
    expect(cameraRelevantForDirection(camB, 'toHr', allExplicit)).toBe(false);
  });
  it('each explicit camera still drives its own direction', () => {
    expect(cameraRelevantForDirection(camA, 'toHr', allExplicit)).toBe(true);
    expect(cameraRelevantForDirection(camB, 'toBih', allExplicit)).toBe(true);
  });
});

describe('ambiguous cameras do not contaminate a direction that has an explicit camera', () => {
  it('ambiguous camera is excluded for toHr because camA is explicit for toHr', () => {
    expect(cameraRelevantForDirection(camAmbiguous, 'toHr', [camA, camB, camAmbiguous])).toBe(false);
  });
  it('ambiguous camera is excluded for toBih because camB is explicit for toBih', () => {
    expect(cameraRelevantForDirection(camAmbiguous, 'toBih', [camA, camB, camAmbiguous])).toBe(false);
  });
});

describe('ambiguous camera is used ONLY as a fallback when no explicit camera exists for the side', () => {
  it('used for both directions when it is the only camera (visual-only fallback)', () => {
    expect(cameraRelevantForDirection(camAmbiguous, 'toHr', [camAmbiguous])).toBe(true);
    expect(cameraRelevantForDirection(camAmbiguous, 'toBih', [camAmbiguous])).toBe(true);
  });
  it('used for the side that has no explicit camera, excluded for the side that does', () => {
    // Only camA (toHr) is explicit; toBih has no explicit camera → ambiguous allowed for toBih only.
    const feeds = [camA, camAmbiguous];
    expect(cameraRelevantForDirection(camAmbiguous, 'toBih', feeds)).toBe(true);
    expect(cameraRelevantForDirection(camAmbiguous, 'toHr', feeds)).toBe(false);
  });
});
