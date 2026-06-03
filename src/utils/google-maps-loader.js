// Google Maps JS API loader. Extracted from App.jsx so the async-loading readiness logic is
// unit-testable (it just caused a "google.maps.LatLngBounds is not a constructor" regression).
//
// With loading=async the script's `load` event fires BEFORE the classic constructors
// (google.maps.Map / LatLngBounds / Polyline / Size …) are attached — only google.maps.importLibrary
// is guaranteed. So we must importLibrary the bundles we use and only THEN resolve, otherwise the
// first `new google.maps.LatLngBounds()` throws.
export async function ensureMapsLibraries() {
  const g = window.google;
  if (g?.maps?.importLibrary) {
    // 'core' → LatLngBounds/Size/LatLng, 'maps' → Map/Polyline/InfoWindow/Marker/TrafficLayer,
    // 'marker' → AdvancedMarkerElement.
    await Promise.all([
      g.maps.importLibrary('core'),
      g.maps.importLibrary('maps'),
      g.maps.importLibrary('marker'),
    ]);
  }
  return g;
}

export function loadGoogleMaps(apiKey) {
  // Only treat as "ready" when the constructors are actually attached (Map present).
  if (window.google?.maps?.Map) return Promise.resolve(window.google);
  if (window.__borderFlowGoogleMapsPromise) return window.__borderFlowGoogleMapsPromise;

  window.__borderFlowGoogleMapsPromise = new Promise((resolve, reject) => {
    const finish = () => ensureMapsLibraries().then(resolve).catch(reject);
    const existing = document.querySelector('script[data-borderflow-google-maps="true"]');
    if (existing) {
      if (window.google?.maps?.importLibrary) finish();
      else {
        existing.addEventListener('load', finish);
        existing.addEventListener('error', reject);
      }
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&loading=async&libraries=marker&v=weekly`;
    script.async = true;
    script.defer = true;
    script.dataset.borderflowGoogleMaps = 'true';
    script.onload = finish;
    script.onerror = () => reject(new Error('Google Maps se nije uspio učitati.'));
    document.head.appendChild(script);
  });

  return window.__borderFlowGoogleMapsPromise;
}
