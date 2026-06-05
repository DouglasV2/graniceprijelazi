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

// Project a point onto a polyline (PERPENDICULAR distance to the nearest segment) and return the
// cumulative road length up to that projection. Robust to RDP-simplification that drops a colinear
// border vertex — we measure to the segment, not to a vertex.
function projectOntoPath(pts, point) {
  const originLat = Number(pts[0].lat);
  const P = toXY(point, originLat);
  let best = { dist: Infinity, beforeLen: 0 };
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const A = toXY(pts[i], originLat);
    const B = toXY(pts[i + 1], originLat);
    const dx = B.x - A.x; const dy = B.y - A.y;
    const segLen = Math.hypot(dx, dy);
    let t = segLen === 0 ? 0 : ((P.x - A.x) * dx + (P.y - A.y) * dy) / (segLen * segLen);
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy));
    if (d < best.dist) best = { dist: d, beforeLen: acc + t * segLen };
    acc += segLen;
  }
  return { dist: best.dist, beforeLen: best.beforeLen, totalLen: acc };
}

// A display corridor must genuinely STRADDLE the border: the polyline must pass close to the border
// point, with meaningful road length on BOTH sides. This is what stops a route that "ends at / just
// before the border" from being shown as a crossing (the Maljevac BiH→HR bug).
export function pathCrossesBorder(path = [], borderPoint = null, { minSideMeters = 250, borderNearToleranceM = 500 } = {}) {
  const pts = (path || []).filter(isPoint);
  if (pts.length < 2 || !isPoint(borderPoint)) return { crosses: false, reason: 'no-geometry', beforeMeters: 0, afterMeters: 0, borderDist: null };
  const proj = projectOntoPath(pts, borderPoint);
  const beforeMeters = Math.round(proj.beforeLen);
  const afterMeters = Math.round(proj.totalLen - proj.beforeLen);
  if (proj.dist > borderNearToleranceM) return { crosses: false, reason: 'border-off-path', beforeMeters, afterMeters, borderDist: Math.round(proj.dist) };
  if (beforeMeters < minSideMeters || afterMeters < minSideMeters) return { crosses: false, reason: 'one-sided', beforeMeters, afterMeters, borderDist: Math.round(proj.dist) };
  return { crosses: true, reason: null, beforeMeters, afterMeters, borderDist: Math.round(proj.dist) };
}

// Main entry: a clean, professional measurement-zone display model for one crossing/direction.
// Uses EXTENDED display anchors when provided (so the zone is longer along the real main road) while
// the precise anchors stay reserved for route-guard validation + live-location. If the supplied path
// does NOT cross the border, we fall back to the clean calibrated corridor (which does by design).
export function buildMeasurementZone({ path = [], anchor = {}, direction = 'toBih', halfWidthMeters = 55, simplifyToleranceMeters = 18, minSideMeters = 250 } = {}) {
  const clean = (Array.isArray(path) ? path : []).filter(isPoint);
  const border = isPoint(anchor.borderPoint) ? anchor.borderPoint : (clean.length ? clean[Math.floor(clean.length / 2)] : null);
  // Display anchors extend further along the main road than the precise control anchors.
  const displayApproach = isPoint(anchor.displayApproachStart) ? anchor.displayApproachStart : (isPoint(anchor.approachStart) ? anchor.approachStart : null);
  const displayExit = isPoint(anchor.displayExitPoint) ? anchor.displayExitPoint : (isPoint(anchor.exitPoint) ? anchor.exitPoint : null);
  const cornerCorridor = [displayApproach, border, displayExit].filter(isPoint);

  // Prefer the supplied (Google) path ONLY when it actually crosses the border; otherwise use the
  // clean calibrated corridor so the map never shows a one-sided / pre-border stub.
  const pathOk = clean.length >= 2 && pathCrossesBorder(clean, border, { minSideMeters }).crosses;
  let source = pathOk ? clean : cornerCorridor;
  let geometrySource = pathOk ? 'path' : 'clean-anchor-corridor';

  if (source.length < 2) {
    return {
      ok: false,
      reason: 'insufficient-geometry',
      direction,
      crossesBorder: false,
      approachAnchor: displayApproach,
      borderAnchor: border,
      exitAnchor: displayExit,
      displayCorridorPolyline: source,
      measurementZonePolygon: [],
      zoneDistanceKm: 0,
      beforeBorderKm: 0,
      afterBorderKm: 0,
    };
  }

  const simplified = simplifyPath(source, simplifyToleranceMeters);
  const displayCorridorPolyline = simplified.length >= 2 ? simplified : source;
  const crossing = pathCrossesBorder(displayCorridorPolyline, border, { minSideMeters: Math.min(minSideMeters, 200) });
  const zoneDistanceKm = Math.round(pathLengthMeters(displayCorridorPolyline) / 100) / 10;
  const measurementZonePolygon = corridorPolygon(displayCorridorPolyline, halfWidthMeters);

  return {
    ok: true,
    reason: null,
    direction,
    crossesBorder: crossing.crosses,
    geometrySource,
    approachAnchor: displayApproach || displayCorridorPolyline[0],
    borderAnchor: border,
    exitAnchor: displayExit || displayCorridorPolyline[displayCorridorPolyline.length - 1],
    displayCorridorPolyline,
    measurementZonePolygon,
    zoneDistanceKm,
    beforeBorderKm: Math.round(crossing.beforeMeters / 100) / 10,
    afterBorderKm: Math.round(crossing.afterMeters / 100) / 10,
    simplifiedFrom: source.length,
    simplifiedTo: displayCorridorPolyline.length,
  };
}
