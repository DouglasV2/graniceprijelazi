// A real road route BENDS. A straight-line fallback (too few points, or a ~collinear shape) must NOT
// be presented as a "provjerena zona" — that claims a validated road we don't actually have. Returns
// true only when the displayed path looks like a genuine, road-snapped geometry. Pure + testable.
export function routeGeometryValidated(path, { minPoints = 4, minBendRatio = 0.012 } = {}) {
  if (!Array.isArray(path) || path.length < minPoints) return false;
  const a = path[0];
  const b = path[path.length - 1];
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) return false;
  const dLat = b.lat - a.lat;
  const dLng = b.lng - a.lng;
  const chord = Math.hypot(dLat, dLng);
  if (chord < 1e-7) return false; // degenerate (start ≈ end)
  let maxDev = 0; // largest perpendicular deviation of an intermediate point from the start→end chord
  for (let i = 1; i < path.length - 1; i += 1) {
    const p = path[i];
    if (!p || !Number.isFinite(p.lat)) continue;
    const dev = Math.abs(dLng * (p.lat - a.lat) - dLat * (p.lng - a.lng)) / chord;
    if (dev > maxDev) maxDev = dev;
  }
  return maxDev / chord > minBendRatio; // genuine bend vs a near-straight fallback
}
