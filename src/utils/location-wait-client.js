// Pure client-side throttling for the "Moja lokacija" live signal. Decides WHEN to send a ping so we
// never flood the backend (works for 1000+ users): far from any zone → slow cadence, near a zone →
// faster, and a significant move can trigger an early ping. No React/DOM here so it is unit-testable.

export const LOCATION_WAIT_CLIENT_DEFAULTS = {
  nearZonePingMs: 15000,
  farZonePingMs: 60000,
  minMoveMeters: 25,
  nearZoneMeters: 1500,
};

const TERMINAL = new Set(['completed', 'cancelled', 'expired', 'disarmed']);

export function haversineMetersClient(a, b) {
  if (!a || !b || !Number.isFinite(Number(a.lat)) || !Number.isFinite(Number(b.lat))) return Infinity;
  const R = 6371000;
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad((b.lng ?? b.lon) - (a.lng ?? a.lon));
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

export function pingIntervalFor(distanceToZoneM, cfg = LOCATION_WAIT_CLIENT_DEFAULTS) {
  if (!Number.isFinite(distanceToZoneM)) return cfg.farZonePingMs;
  return distanceToZoneM <= cfg.nearZoneMeters ? cfg.nearZonePingMs : cfg.farZonePingMs;
}

export function shouldSendPing({
  now = Date.now(),
  lastSentAt = 0,
  lastPoint = null,
  point = null,
  status = 'pending',
  distanceToZoneM = Infinity,
  cfg = LOCATION_WAIT_CLIENT_DEFAULTS,
} = {}) {
  if (!point || !Number.isFinite(Number(point.lat))) return { send: false, reason: 'no-point' };
  if (TERMINAL.has(status)) return { send: false, reason: `terminal:${status}` };
  const interval = pingIntervalFor(distanceToZoneM, cfg);
  const elapsed = now - lastSentAt;
  if (elapsed >= interval) return { send: true, reason: 'interval' };
  const moved = lastPoint ? haversineMetersClient(lastPoint, point) : Infinity;
  if (moved >= cfg.minMoveMeters && elapsed >= cfg.nearZonePingMs) return { send: true, reason: 'moved' };
  return { send: false, reason: 'throttled' };
}
