// @vitest-environment jsdom
// Real DOM test of the Google Maps async loader. Reproduces the production crash
// "google.maps.LatLngBounds is not a constructor": with loading=async the load event fires before
// the classic constructors are attached, AND importLibrary RETURNS the classes without always
// setting the google.maps.X globals the app uses. loadGoogleMaps must attach them and only resolve
// once EVERY required constructor is a real function.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadGoogleMaps, ensureMapsLibraries, mapsConstructorsReady, REQUIRED_MAPS_CONSTRUCTORS } from '../../src/utils/google-maps-loader.js';

beforeEach(() => {
  delete window.google;
  delete window.__borderFlowGoogleMapsPromise;
  document.head.innerHTML = '';
});

const ctor = (name) => { const f = function () {}; Object.defineProperty(f, 'name', { value: name }); return f; };

describe('mapsConstructorsReady', () => {
  it('requires ALL constructors the app uses, not just Map', () => {
    window.google = { maps: { Map: ctor('Map') } };
    expect(mapsConstructorsReady()).toBe(false); // Map alone is NOT ready
    for (const k of REQUIRED_MAPS_CONSTRUCTORS) window.google.maps[k] = ctor(k);
    expect(mapsConstructorsReady()).toBe(true);
  });
  it('is false when google/maps is missing', () => {
    expect(mapsConstructorsReady()).toBe(false);
  });
});

describe('loadGoogleMaps with loading=async', () => {
  it('injects the script with loading=async + marker library', () => {
    const p = loadGoogleMaps('TEST_KEY');
    const script = document.querySelector('script[data-borderflow-google-maps="true"]');
    expect(script).toBeTruthy();
    expect(script.src).toContain('loading=async');
    expect(script.src).toContain('libraries=marker');
    expect(script.src).toContain('key=TEST_KEY');
    p.catch(() => {});
  });

  it('REGRESSION: importLibrary returns LatLngBounds but does NOT attach the global → loader attaches it and resolves only when it is a real constructor', async () => {
    const LatLngBounds = ctor('LatLngBounds');
    const Size = ctor('Size');
    const MapCtor = ctor('Map');
    const Polyline = ctor('Polyline');
    const InfoWindow = ctor('InfoWindow');
    const TrafficLayer = ctor('TrafficLayer');

    const promise = loadGoogleMaps('K');
    const script = document.querySelector('script[data-borderflow-google-maps="true"]');

    // loading=async state at `load`: importLibrary exists, Map MAY be attached (the old early-return
    // would have wrongly resolved here), but LatLngBounds is NOT a global, and importLibrary only
    // RETURNS the classes (does not set google.maps.X) — exactly the production bug.
    window.google = {
      maps: {
        Map: MapCtor,
        importLibrary: vi.fn(async (name) => {
          if (name === 'core') return { LatLngBounds, Size, LatLng: ctor('LatLng') };
          if (name === 'maps') return { Map: MapCtor, Polyline, InfoWindow, TrafficLayer };
          return { AdvancedMarkerElement: ctor('AdvancedMarkerElement') };
        }),
      },
    };
    // Pre-resolve, the global the app uses is NOT yet a constructor.
    expect(typeof window.google.maps.LatLngBounds).not.toBe('function');

    script.onload();
    const google = await promise;

    // Post-resolve, every required constructor is attached and usable — no crash.
    expect(() => new google.maps.LatLngBounds()).not.toThrow();
    for (const name of REQUIRED_MAPS_CONSTRUCTORS) {
      expect(typeof google.maps[name], `${name} must be a constructor after load`).toBe('function');
    }
    expect(window.google.maps.importLibrary).toHaveBeenCalledWith('core');
    expect(window.google.maps.importLibrary).toHaveBeenCalledWith('maps');
    expect(window.google.maps.importLibrary).toHaveBeenCalledWith('marker');
  });

  it('does NOT resolve while only Map is attached (LatLngBounds missing) — it injects a script and waits', () => {
    window.google = { maps: { Map: ctor('Map') } }; // no importLibrary, no LatLngBounds
    const p = loadGoogleMaps('K');
    expect(document.querySelector('script[data-borderflow-google-maps="true"]')).toBeTruthy();
    p.catch(() => {});
  });

  it('resolves immediately (no script) when ALL constructors are already attached', async () => {
    window.google = { maps: {} };
    for (const k of REQUIRED_MAPS_CONSTRUCTORS) window.google.maps[k] = ctor(k);
    const google = await loadGoogleMaps('K');
    expect(google).toBe(window.google);
    expect(document.querySelector('script[data-borderflow-google-maps="true"]')).toBeNull();
  });

  it('dedupes: reuses an existing maps.googleapis.com script tag instead of injecting a second', () => {
    const stray = document.createElement('script');
    stray.src = 'https://maps.googleapis.com/maps/api/js?key=OLD';
    document.head.appendChild(stray);
    const p = loadGoogleMaps('K');
    const scripts = document.querySelectorAll('script[src*="maps.googleapis.com/maps/api/js"]');
    expect(scripts.length).toBe(1); // no second loader injected
    p.catch(() => {});
  });

  it('rejects (and clears the cached promise) if constructors never attach, so a retry can work', async () => {
    const promise = loadGoogleMaps('K');
    const script = document.querySelector('script[data-borderflow-google-maps="true"]');
    window.google = { maps: { importLibrary: vi.fn(async () => ({})) } }; // returns nothing useful
    script.onload();
    await expect(promise).rejects.toThrow();
    expect(window.__borderFlowGoogleMapsPromise).toBeNull(); // cleared → retryable
  });
});

describe('ensureMapsLibraries', () => {
  it('imports core+maps+marker and attaches returned constructors onto google.maps', async () => {
    const LatLngBounds = ctor('LatLngBounds');
    window.google = {
      maps: {
        importLibrary: vi.fn(async (name) => (name === 'core' ? { LatLngBounds } : {})),
      },
    };
    await ensureMapsLibraries();
    const names = window.google.maps.importLibrary.mock.calls.map((c) => c[0]);
    expect(names).toEqual(expect.arrayContaining(['core', 'maps', 'marker']));
    expect(window.google.maps.LatLngBounds).toBe(LatLngBounds); // attached from the returned bundle
  });
});
