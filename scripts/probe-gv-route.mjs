// Dev probe: which waypoint combination makes Google Routes return the REAL ~3-4 km route across
// the Gornji Varoš (Gradiška Novi Most) bridge instead of an absurd cross-country detour.
// Usage: node scripts/probe-gv-route.mjs   (reads GOOGLE_MAPS_SERVER_KEY from .env.local)
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local'), quiet: true });
const key = process.env.GOOGLE_MAPS_SERVER_KEY;
if (!key) { console.error('No GOOGLE_MAPS_SERVER_KEY'); process.exit(1); }

const BORDER = { lat: 45.1493, lng: 17.2045 };
const HR_CONTROL = { lat: 45.1631, lng: 17.2049 };
const BIH_CONTROL = { lat: 45.1357, lng: 17.2030 };
const EXT_ORIGIN = { lat: 45.17089, lng: 17.20524 }; // current extended request origin (bearing-based)
const EXT_DEST = { lat: 45.13134, lng: 17.20251 };   // current extended request destination

const wp = (p, via = false) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } }, ...(via ? { via: true } : {}) });

function decodePolyline(encoded) {
  let index = 0; const len = encoded.length; const pathPts = []; let lat = 0; let lng = 0;
  while (index < len) {
    let b; let shift = 0; let result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    pathPts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pathPts;
}

const distM = (a, b) => {
  const x = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  const y = b.lat - a.lat;
  return Math.sqrt(x * x + y * y) * 111320;
};
const minDistToBorder = (pts) => Math.round(Math.min(...pts.map((p) => distM(p, BORDER))));

async function probe(label, origin, destination, intermediates = []) {
  const body = {
    origin, destination, intermediates,
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
    departureTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    computeAlternativeRoutes: false,
    languageCode: 'hr-HR',
    units: 'METRIC',
    polylineQuality: 'HIGH_QUALITY',
    extraComputations: ['TRAFFIC_ON_POLYLINE'],
  };
  try {
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 180);
      console.log(`${label} => HTTP ${res.status}: ${text}`);
      return;
    }
    const data = await res.json();
    const route = data.routes?.[0];
    if (!route) { console.log(`${label} => NO ROUTES`); return; }
    const pts = decodePolyline(route.polyline?.encodedPolyline || '');
    console.log(`${label} => ${(route.distanceMeters / 1000).toFixed(1)} km, ${route.duration}, pts=${pts.length}, minDistToBorder=${pts.length ? minDistToBorder(pts) : '?'} m, start=${pts[0]?.lat.toFixed(4)},${pts[0]?.lng.toFixed(4)} end=${pts.at(-1)?.lat.toFixed(4)},${pts.at(-1)?.lng.toFixed(4)}`);
  } catch (error) {
    console.log(`${label} => FETCH ERROR: ${error.message}`);
  }
}

await probe('A  via-border, control-to-control      ', wp(HR_CONTROL), wp(BIH_CONTROL), [wp(BORDER, true)]);
await probe('B  no-intermediate, control-to-control ', wp(HR_CONTROL), wp(BIH_CONTROL));
await probe('C  no-intermediate, EXTENDED endpoints ', wp(EXT_ORIGIN), wp(EXT_DEST));
await probe('D  via-border, EXTENDED endpoints      ', wp(EXT_ORIGIN), wp(EXT_DEST), [wp(BORDER, true)]);
await probe('E  stopover-border, EXTENDED endpoints ', wp(EXT_ORIGIN), wp(EXT_DEST), [wp(BORDER)]);
await probe('F  via-border, EXT origin → BiH control', wp(EXT_ORIGIN), wp(BIH_CONTROL), [wp(BORDER, true)]);
await probe('G  via-border, HR control → EXT dest   ', wp(HR_CONTROL), wp(EXT_DEST), [wp(BORDER, true)]);

// toHr (BiH→HR) variants — is the HR-side extended point usable as a DESTINATION?
await probe('H  toHr via-border, control-to-control ', wp(BIH_CONTROL), wp(HR_CONTROL), [wp(BORDER, true)]);
await probe('I  toHr via-border, BiH ctl -> EXT HR  ', wp(BIH_CONTROL), wp(EXT_ORIGIN), [wp(BORDER, true)]);
await probe('J  toHr via-border, EXT BiH -> HR ctl  ', wp(EXT_DEST), wp(HR_CONTROL), [wp(BORDER, true)]);

// Dual-carriageway: northbound lane is the EASTERN one (~lng 17.2046), southbound western (~17.2044).
const BORDER_NB = { lat: 45.1503, lng: 17.20462 };
const BORDER_SB = { lat: 45.1503, lng: 17.20440 };
await probe('K  toHr NO intermediate, ctl-to-ctl    ', wp(BIH_CONTROL), wp(HR_CONTROL));
await probe('L  toHr via NORTHBOUND border point    ', wp(BIH_CONTROL), wp(HR_CONTROL), [wp(BORDER_NB, true)]);
await probe('M  toBih via SOUTHBOUND border point   ', wp(HR_CONTROL), wp(BIH_CONTROL), [wp(BORDER_SB, true)]);

await probe('N  toHr EXT motorway origin via NB     ', wp(EXT_DEST), wp(HR_CONTROL), [wp(BORDER_NB, true)]);
await probe('O  toHr BiH ctl -> EXT HR dest via NB  ', wp(BIH_CONTROL), wp(EXT_ORIGIN), [wp(BORDER_NB, true)]);
await probe('P  toHr EXT origin -> EXT HR dest, NB  ', wp(EXT_DEST), wp(EXT_ORIGIN), [wp(BORDER_NB, true)]);

// Northbound carriageway just NORTH of the BiH control plaza (embankment way 1377000015 at ~17.2043).
const NB_APPROACH = { lat: 45.1410, lng: 17.20435 };
await probe('Q  toHr NB-approach -> HR ctl, via NB  ', wp(NB_APPROACH), wp(HR_CONTROL), [wp(BORDER_NB, true)]);
await probe('R  toHr NB-approach -> EXT HR, via NB  ', wp(NB_APPROACH), wp(EXT_ORIGIN), [wp(BORDER_NB, true)]);

// Gradiška (old bridge) toHr — does a via-border request avoid the 180° U-turn at the origin?
const GRA_BIH = { lat: 45.13800, lng: 17.25750 };
const GRA_BORDER = { lat: 45.14530, lng: 17.25210 };
const GRA_HR = { lat: 45.14850, lng: 17.25100 };
await probe('S  gradiska toHr via border            ', wp(GRA_BIH), wp(GRA_HR), [wp(GRA_BORDER, true)]);
await probe('T  gradiska toHr stopover border       ', wp(GRA_BIH), wp(GRA_HR), [wp(GRA_BORDER)]);
await probe('U  gradiska toHr no intermediate       ', wp(GRA_BIH), wp(GRA_HR));

await probe('V  gradiska toBih via border           ', wp(GRA_HR), wp(GRA_BIH), [wp(GRA_BORDER, true)]);
