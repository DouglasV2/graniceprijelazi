// Source-guard tests for the frontend refresh pipeline (vitest runs in a node env with no DOM,
// so we pin the required behaviours by asserting they exist in the shipped source). These catch
// regressions where someone removes no-store, cache-busting, the faster poll, the live-signal
// reload wiring, or the Google Maps loading=async fix.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = readFileSync(join(root, 'src', 'App.jsx'), 'utf8');
const mapsLoader = readFileSync(join(root, 'src', 'utils', 'google-maps-loader.js'), 'utf8');

describe('frontend fetch never serves cached data', () => {
  it("fetchJson sets cache: 'no-store'", () => {
    expect(app).toMatch(/cache:\s*'no-store'/);
  });
  it('public-state requests are cache-busted with a t= query', () => {
    expect(app).toMatch(/\/api\/public\/state\$\{query\}/);
    expect(app).toMatch(/t=\$\{Date\.now\(\)\}/);
  });
  it('public-state supports a sync refresh query', () => {
    expect(app).toMatch(/refresh=sync/);
  });
});

describe('frontend polling + live-signal push', () => {
  it('public state poll is 30s (not the old 90s)', () => {
    expect(app).toMatch(/PUBLIC_STATE_POLL_MS\s*=\s*Number\([^)]*\)\s*\|\|\s*30000/);
    expect(app).not.toMatch(/setInterval\(loadServerState,\s*90000\)/);
  });
  it('App reloads public state when a live signal event fires', () => {
    expect(app).toMatch(/addEventListener\(LIVE_SIGNAL_EVENT/);
    expect(app).toMatch(/loadServerState\(\{\s*sync:\s*true\s*\}\)/);
  });
  it('a completed route fetch pushes a live-signal reload', () => {
    expect(app).toMatch(/payload\?\.live\)\s*dispatchLiveSignal\(\)/);
  });
  it('the live-signal dispatcher is a stable module-level function (no per-render identity)', () => {
    expect(app).toMatch(/function dispatchLiveSignal\(\)\s*\{/);
    expect(app).toMatch(/window\.dispatchEvent\(new Event\(LIVE_SIGNAL_EVENT\)\)/);
  });
  it('CameraPanel notifies the app via a STABLE onLiveSignalUpdated prop', () => {
    expect(app).toMatch(/function CameraPanel\(\{[^}]*onLiveSignalUpdated/);
    expect(app).toMatch(/onLiveSignalUpdated\?\.\(\)/);
    expect(app).toMatch(/onLiveSignalUpdated=\{dispatchLiveSignal\}/);
  });
  it('loadServerState avoids overrides identity churn (kills the re-render/zoom loop)', () => {
    expect(app).toMatch(/JSON\.stringify\(prev\)\s*===\s*JSON\.stringify\(payload\.overrides\)\s*\?\s*prev\s*:\s*payload\.overrides/);
  });
  it('selectCrossing is memoised so the map is not recreated every render', () => {
    expect(app).toMatch(/const selectCrossing = useCallback\(/);
  });
  it('admin "Osvježi live izvore" button refreshes then pushes a live reload', () => {
    expect(app).toMatch(/Osvježi live izvore/);
    expect(app).toMatch(/\/api\/admin\/sources\/refresh/);
  });
});

describe('Google Maps loader best practice (src/utils/google-maps-loader.js)', () => {
  it('loads the Maps JS API with loading=async', () => {
    expect(mapsLoader).toMatch(/maps\.googleapis\.com\/maps\/api\/js\?key=\$\{apiKey\}&loading=async&libraries=marker&v=weekly/);
  });
  it('awaits importLibrary AND attaches the returned constructors before resolving', () => {
    // Prevents the production "google.maps.LatLngBounds is not a constructor" crash: loading=async
    // returns the classes from importLibrary without always setting the google.maps.X globals.
    expect(mapsLoader).toMatch(/importLibrary\('core'\)/);
    expect(mapsLoader).toMatch(/importLibrary\('maps'\)/);
    expect(mapsLoader).toMatch(/importLibrary\('marker'\)/);
    expect(mapsLoader).toMatch(/attachReturnedConstructors/);
  });
  it('readiness requires EVERY constructor the app uses (not just Map)', () => {
    expect(mapsLoader).toMatch(/REQUIRED_MAPS_CONSTRUCTORS\s*=\s*\[[^\]]*'LatLngBounds'[^\]]*'TrafficLayer'[^\]]*\]/);
    expect(mapsLoader).toMatch(/function mapsConstructorsReady\(\)/);
    expect(mapsLoader).toMatch(/if \(mapsConstructorsReady\(\)\) return Promise\.resolve\(window\.google\)/);
  });
  it('dedupes any existing maps.googleapis.com script tag', () => {
    expect(mapsLoader).toMatch(/script\[src\*="maps\.googleapis\.com\/maps\/api\/js"\]/);
  });
  it('App.jsx uses the extracted loader and guards map init on full constructor readiness', () => {
    expect(app).toMatch(/import \{ loadGoogleMaps, mapsConstructorsReady \} from '\.\/utils\/google-maps-loader\.js'/);
    // Every effect that builds google.maps objects must guard on mapsConstructorsReady().
    const guards = app.match(/mapsConstructorsReady\(\)/g) || [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });
});
