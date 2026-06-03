// @vitest-environment jsdom
// Real DOM test of the Google Maps async loader. Reproduces the "google.maps.LatLngBounds is not a
// constructor" bug: with loading=async the script's load event fires before the constructors are
// attached, so loadGoogleMaps MUST await importLibrary before resolving.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadGoogleMaps, ensureMapsLibraries } from '../../src/utils/google-maps-loader.js';

beforeEach(() => {
  delete window.google;
  delete window.__borderFlowGoogleMapsPromise;
  document.head.innerHTML = '';
  document.querySelectorAll('script[data-borderflow-google-maps]').forEach((s) => s.remove());
});

describe('loadGoogleMaps with loading=async', () => {
  it('injects the script with loading=async + marker library', async () => {
    const p = loadGoogleMaps('TEST_KEY');
    const script = document.querySelector('script[data-borderflow-google-maps="true"]');
    expect(script).toBeTruthy();
    expect(script.src).toContain('loading=async');
    expect(script.src).toContain('libraries=marker');
    expect(script.src).toContain('key=TEST_KEY');
    // Avoid an unhandled rejection if the test ends before onload; settle the promise.
    p.catch(() => {});
  });

  it('does NOT resolve until importLibrary has run (constructors attached)', async () => {
    let importLibraryCalled = false;
    const promise = loadGoogleMaps('K');
    const script = document.querySelector('script[data-borderflow-google-maps="true"]');

    // Simulate async loading: on load, only importLibrary exists; classic constructors come later.
    window.google = {
      maps: {
        importLibrary: vi.fn(async (name) => {
          importLibraryCalled = true;
          // Attach the constructors only once a library has been imported.
          window.google.maps.Map = function Map() {};
          window.google.maps.LatLngBounds = function LatLngBounds() {};
          return { name };
        }),
      },
    };
    script.onload();

    const google = await promise;
    expect(importLibraryCalled).toBe(true);
    expect(window.google.maps.importLibrary).toHaveBeenCalledWith('core');
    expect(window.google.maps.importLibrary).toHaveBeenCalledWith('maps');
    expect(window.google.maps.importLibrary).toHaveBeenCalledWith('marker');
    // After resolve the classic constructors are usable — no "is not a constructor".
    expect(() => new google.maps.LatLngBounds()).not.toThrow();
    expect(typeof google.maps.Map).toBe('function');
  });

  it('treats the API as ready only when the Map constructor is attached', async () => {
    // google.maps exists but WITHOUT Map (the async pre-import state) → must not short-circuit.
    window.google = { maps: { importLibrary: vi.fn(async () => { window.google.maps.Map = function () {}; }) } };
    const p = loadGoogleMaps('K');
    // Since Map was missing, it should have injected a script (not resolved immediately).
    expect(document.querySelector('script[data-borderflow-google-maps="true"]')).toBeTruthy();
    p.catch(() => {});
  });

  it('resolves immediately when Map is already attached (no duplicate script)', async () => {
    window.google = { maps: { Map: function () {}, importLibrary: vi.fn() } };
    const google = await loadGoogleMaps('K');
    expect(google).toBe(window.google);
    expect(document.querySelector('script[data-borderflow-google-maps="true"]')).toBeNull();
  });

  it('ensureMapsLibraries imports core+maps+marker when importLibrary is present', async () => {
    window.google = { maps: { importLibrary: vi.fn(async (n) => ({ n })) } };
    await ensureMapsLibraries();
    const names = window.google.maps.importLibrary.mock.calls.map((c) => c[0]);
    expect(names).toEqual(expect.arrayContaining(['core', 'maps', 'marker']));
  });
});
