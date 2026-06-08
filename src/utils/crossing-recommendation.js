// Pure ranking of border crossings by TOTAL cost from the user's current location:
//   score = driveTimeMin + waitEstimateMin + reliabilityPenaltyMin
// No network / DOM — fully unit-testable. driveMin comes from Google when available, else a haversine
// approximation (flagged driveApprox). Privacy: takes ONE current {lat,lng}; stores nothing.

const EARTH_KM = 6371;
const DEG = Math.PI / 180;

export function haversineKm(a, b) {
  if (!a || !b || !Number.isFinite(Number(a.lat)) || !Number.isFinite(Number(b.lat))) return Infinity;
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = ((b.lng ?? b.lon) - (a.lng ?? a.lon)) * DEG;
  const lat1 = a.lat * DEG; const lat2 = b.lat * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// A less-confident estimate is penalised so we don't send people to a crossing whose "low wait" is a
// guess. high → +0, medium → +5, low/unknown → +12 min.
export function reliabilityPenaltyMin(confidence) {
  const c = String(confidence || '').toLowerCase();
  if (c.includes('visok') || c === 'high') return 0;
  if (c.includes('sred') || c === 'medium') return 5;
  return 12;
}

export function approxDriveMinFromKm(km, avgSpeedKmh = 70) {
  if (km === null || km === undefined || !Number.isFinite(Number(km))) return null;
  return Math.round((Number(km) / avgSpeedKmh) * 60);
}

// crossings: [{ id, name, lat, lng, waitMin, confidence, driveMin? }]. driveMin (from Google) wins;
// otherwise a haversine approximation is used and driveApprox=true.
export function rankCrossingsByLocation(userPos, crossings = [], { avgSpeedKmh = 70, similarThresholdMin = 10 } = {}) {
  const usable = (crossings || []).filter((c) => c && Number.isFinite(Number(c.waitMin)) && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng)));
  const scored = usable
    .map((c) => {
      const hasGoogleDrive = Number.isFinite(Number(c.driveMin));
      const driveMin = hasGoogleDrive ? Number(c.driveMin) : (userPos ? approxDriveMinFromKm(haversineKm(userPos, c), avgSpeedKmh) : null);
      const waitMin = Number(c.waitMin);
      const reliabilityPenalty = reliabilityPenaltyMin(c.confidence);
      const totalMin = (Number.isFinite(driveMin) ? driveMin : 0) + waitMin + reliabilityPenalty;
      return { id: c.id, name: c.name, lat: c.lat, lng: c.lng, waitMin, confidence: c.confidence || null, driveMin, driveApprox: !hasGoogleDrive, reliabilityPenalty, totalMin };
    })
    .filter((c) => Number.isFinite(c.driveMin))
    .sort((a, b) => a.totalMin - b.totalMin);

  if (!scored.length) return { best: null, alternatives: [], all: [], similar: false };

  const best = { ...scored[0], badges: [] };
  // Badges: explain WHY it's the pick (helps trust).
  if (best.driveApprox) best.badges.push('Vrijeme vožnje okvirno');
  const cheapestWait = [...scored].sort((a, b) => a.waitMin - b.waitMin)[0];
  if (cheapestWait && cheapestWait.id === best.id) best.badges.push('Manje čekanje');
  best.badges.unshift('Najbrže ukupno');

  const alternatives = scored.slice(1, 4);
  const similar = alternatives.length > 0 && (alternatives[0].totalMin - best.totalMin) < similarThresholdMin;
  return { best, alternatives, all: scored, similar };
}
