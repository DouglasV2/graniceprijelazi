// Google Maps JS API loader. Extracted from App.jsx so the async-loading readiness logic is
// unit-testable (it caused a production "google.maps.LatLngBounds is not a constructor" crash).
//
// With loading=async the script's `load` event fires BEFORE the classic constructors are attached,
// and — critically — `importLibrary('core')` RETURNS { LatLngBounds, Size, LatLng } but does NOT
// always set them as `google.maps.X` globals. The app uses the globals (new google.maps.LatLngBounds()),
// so we must (a) await the libraries, (b) ATTACH the returned constructors onto google.maps if the
// global is missing, and (c) only resolve once EVERY constructor the app uses is really a function.

// Every google.maps constructor the React map render touches. loadGoogleMaps resolves only when all
// of these are real functions — so `new window.google.maps.LatLngBounds()` is always safe afterwards.
export const REQUIRED_MAPS_CONSTRUCTORS = ['LatLngBounds', 'Map', 'InfoWindow', 'Size', 'Polyline', 'TrafficLayer'];

export function mapsConstructorsReady() {
  const maps = window.google && window.google.maps;
  return Boolean(maps) && REQUIRED_MAPS_CONSTRUCTORS.every((name) => typeof maps[name] === 'function');
}

// Copy any constructor returned by importLibrary onto google.maps when the global is missing.
function attachReturnedConstructors(maps, lib) {
  if (!maps || !lib || typeof lib !== 'object') return;
  for (const [key, value] of Object.entries(lib)) {
    if (typeof value === 'function' && typeof maps[key] !== 'function') {
      try { maps[key] = value; } catch { /* namespace may be read-only — ignore, global already set */ }
    }
  }
}

export async function ensureMapsLibraries() {
  const g = window.google;
  if (!g || !g.maps) return g;
  if (typeof g.maps.importLibrary === 'function') {
    // 'core' → LatLngBounds/Size/LatLng, 'maps' → Map/Polyline/InfoWindow/TrafficLayer/Marker,
    // 'marker' → AdvancedMarkerElement (used directly via importLibrary elsewhere too).
    const [core, maps] = await Promise.all([
      g.maps.importLibrary('core'),
      g.maps.importLibrary('maps'),
      g.maps.importLibrary('marker'),
    ]);
    // loading=async returns the classes but may not attach the globals the app reads — attach them.
    attachReturnedConstructors(g.maps, core);
    attachReturnedConstructors(g.maps, maps);
  }
  return g;
}

export function loadGoogleMaps(apiKey) {
  // "Ready" means EVERY required constructor is attached — not merely that google.maps.Map exists.
  if (mapsConstructorsReady()) return Promise.resolve(window.google);
  if (window.__borderFlowGoogleMapsPromise) return window.__borderFlowGoogleMapsPromise;

  window.__borderFlowGoogleMapsPromise = new Promise((resolve, reject) => {
    const finish = () => ensureMapsLibraries()
      .then(() => {
        if (mapsConstructorsReady()) { resolve(window.google); return; }
        throw new Error('Google Maps constructori nisu spremni nakon učitavanja biblioteka.');
      })
      .catch((error) => {
        // Let a later call retry instead of caching a permanently-rejected promise.
        window.__borderFlowGoogleMapsPromise = null;
        reject(error);
      });

    // Dedupe: reuse ANY existing Google Maps script — ours (data marker) or a stray tag (e.g. an
    // old one without loading=async) — so we never inject a second, conflicting loader.
    const existing = document.querySelector('script[data-borderflow-google-maps="true"], script[src*="maps.googleapis.com/maps/api/js"]');
    if (existing) {
      if (window.google?.maps?.importLibrary || window.google?.maps?.Map) finish();
      else {
        existing.addEventListener('load', finish);
        existing.addEventListener('error', (event) => { window.__borderFlowGoogleMapsPromise = null; reject(event?.error || new Error('Google Maps se nije uspio učitati.')); });
      }
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&loading=async&libraries=marker&v=weekly`;
    script.async = true;
    script.defer = true;
    script.dataset.borderflowGoogleMaps = 'true';
    script.onload = finish;
    script.onerror = () => { window.__borderFlowGoogleMapsPromise = null; reject(new Error('Google Maps se nije uspio učitati.')); };
    document.head.appendChild(script);
  });

  return window.__borderFlowGoogleMapsPromise;
}
