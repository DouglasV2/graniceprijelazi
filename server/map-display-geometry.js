// Pure display geometry for the public "Provjerena zona" (border measurement corridor). It turns a
// raw/sliced route path + calibrated anchors into a TIDY display model the UI can render without
// ugly wiggles or far-flung anchors:
//   { approachAnchor, borderAnchor, exitAnchor, displayCorridorPolyline, measurementZonePolygon, zoneDistanceKm }
// No google.maps / network — fully unit-testable. Everything is fallback-safe: bad input returns a
// usable (possibly minimal) model with ok:false rather than throwing.

const EARTH_M = 6371000;
const DEG = Math.PI / 180;

function isPoint(p) {
  return p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
}

// Local equirectangular projection to metres (good enough at border-zone scale).
function toXY(p, originLat) {
  return { x: Number(p.lng) * DEG * EARTH_M * Math.cos(originLat * DEG), y: Number(p.lat) * DEG * EARTH_M };
}
function fromXY(xy, originLat) {
  return { lat: xy.y / (DEG * EARTH_M), lng: xy.x / (DEG * EARTH_M * Math.cos(originLat * DEG)) };
}

export function distanceMetersLL(a, b) {
  if (!isPoint(a) || !isPoint(b)) return 0;
  const lat = ((Number(a.lat) + Number(b.lat)) / 2) * DEG;
  const x = (Number(b.lng) - Number(a.lng)) * DEG * Math.cos(lat);
  const y = (Number(b.lat) - Number(a.lat)) * DEG;
  return Math.sqrt(x * x + y * y) * EARTH_M;
}

export function pathLengthMeters(path = []) {
  let sum = 0;
  for (let i = 1; i < path.length; i += 1) sum += distanceMetersLL(path[i - 1], path[i]);
  return sum;
}

// Perpendicular distance (m) from p to segment a-b, in the local metre frame.
function perpDistanceMeters(p, a, b, originLat) {
  const P = toXY(p, originLat); const A = toXY(a, originLat); const B = toXY(b, originLat);
  const dx = B.x - A.x; const dy = B.y - A.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(P.x - A.x, P.y - A.y);
  let t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = A.x + t * dx; const projY = A.y + t * dy;
  return Math.hypot(P.x - projX, P.y - projY);
}

// Ramer–Douglas–Peucker: drop wiggle points so the displayed line is clean.
export function simplifyPath(path = [], toleranceMeters = 18) {
  const pts = (path || []).filter(isPoint);
  if (pts.length <= 2) return pts.slice();
  const originLat = Number(pts[0].lat);
  const keep = new Array(pts.length).fill(false);
  keep[0] = true; keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDist = 0; let idx = -1;
    for (let i = start + 1; i < end; i += 1) {
      const d = perpDistanceMeters(pts[i], pts[start], pts[end], originLat);
      if (d > maxDist) { maxDist = d; idx = i; }
    }
    if (idx !== -1 && maxDist > toleranceMeters) {
      keep[idx] = true;
      stack.push([start, idx], [idx, end]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// Build a closed corridor polygon (a ribbon) of half-width metres around a polyline.
export function corridorPolygon(path = [], halfWidthMeters = 55) {
  const pts = (path || []).filter(isPoint);
  if (pts.length < 2) return [];
  const originLat = Number(pts[0].lat);
  const xy = pts.map((p) => toXY(p, originLat));
  const left = []; const right = [];
  for (let i = 0; i < xy.length; i += 1) {
    const prev = xy[Math.max(0, i - 1)];
    const next = xy[Math.min(xy.length - 1, i + 1)];
    let tx = next.x - prev.x; let ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1; tx /= len; ty /= len;
    const nx = -ty; const ny = tx; // unit perpendicular
    left.push({ x: xy[i].x + nx * halfWidthMeters, y: xy[i].y + ny * halfWidthMeters });
    right.push({ x: xy[i].x - nx * halfWidthMeters, y: xy[i].y - ny * halfWidthMeters });
  }
  const ring = [...left, ...right.reverse()].map((p) => fromXY(p, originLat));
  if (ring.length) ring.push(ring[0]); // close
  return ring;
}

// Main entry: a clean, professional measurement-zone display model for one crossing/direction.
export function buildMeasurementZone({ path = [], anchor = {}, direction = 'toBih', halfWidthMeters = 55, simplifyToleranceMeters = 18 } = {}) {
  const clean = (Array.isArray(path) ? path : []).filter(isPoint);
  const border = isPoint(anchor.borderPoint) ? anchor.borderPoint : (clean.length ? clean[Math.floor(clean.length / 2)] : null);

  // Corridor source: the (already border-sliced) path if usable, else the calibrated anchor triplet.
  let source = clean.length >= 2
    ? clean
    : [anchor.approachStart, anchor.borderPoint, anchor.exitPoint].filter(isPoint);

  if (source.length < 2) {
    return {
      ok: false,
      reason: 'insufficient-geometry',
      direction,
      approachAnchor: isPoint(anchor.approachStart) ? anchor.approachStart : null,
      borderAnchor: border,
      exitAnchor: isPoint(anchor.exitPoint) ? anchor.exitPoint : null,
      displayCorridorPolyline: source,
      measurementZonePolygon: [],
      zoneDistanceKm: 0,
    };
  }

  const simplified = simplifyPath(source, simplifyToleranceMeters);
  const displayCorridorPolyline = simplified.length >= 2 ? simplified : source;
  const zoneDistanceKm = Math.round(pathLengthMeters(displayCorridorPolyline) / 100) / 10;
  const measurementZonePolygon = corridorPolygon(displayCorridorPolyline, halfWidthMeters);

  return {
    ok: true,
    reason: null,
    direction,
    approachAnchor: isPoint(anchor.approachStart) ? anchor.approachStart : displayCorridorPolyline[0],
    borderAnchor: border,
    exitAnchor: isPoint(anchor.exitPoint) ? anchor.exitPoint : displayCorridorPolyline[displayCorridorPolyline.length - 1],
    displayCorridorPolyline,
    measurementZonePolygon,
    zoneDistanceKm,
    simplifiedFrom: source.length,
    simplifiedTo: displayCorridorPolyline.length,
  };
}
