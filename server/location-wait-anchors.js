// Per crossing/direction anchors for the live-location wait signal. Derived from the crossing's
// already-calibrated, CLEAN route anchors (approachStart / borderPoint / exitPoint) — never from raw
// wiggly Google polylines. A curated STATIC override can pin exact start/end zones where the derived
// ones are not ideal. If a direction has no usable anchors, the live signal simply does not arm for
// it (the user still sees their own location on the map locally).

const START_RADIUS_M = Math.max(40, Number(process.env.LOCATION_WAIT_START_RADIUS_M || 140));
const END_RADIUS_M = Math.max(40, Number(process.env.LOCATION_WAIT_END_RADIUS_M || 160));
const MAX_SESSION_MINUTES = Math.max(10, Number(process.env.LOCATION_WAIT_SESSION_MAX_MINUTES || 240));

// Optional hand-curated anchors: { 'crossingId:direction': { startAnchor, borderAnchor, endAnchor, maxSessionMinutes } }.
// Coordinates are {lat,lng}; radii in metres. Empty by default — derived anchors are used.
export const STATIC_LOCATION_WAIT_ANCHORS = {};

function pt(p) {
  return p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) ? { lat: Number(p.lat), lng: Number(p.lng) } : null;
}

// Build anchors for one crossing/direction. `crossing` is the BORDER_CROSSINGS entry.
export function buildLocationWaitAnchors(crossing, direction = 'toBih') {
  const key = `${crossing?.id}:${direction}`;
  const override = STATIC_LOCATION_WAIT_ANCHORS[key];
  if (override && pt(override.startAnchor) && pt(override.endAnchor)) {
    return {
      crossingId: crossing.id,
      direction,
      startAnchor: { ...pt(override.startAnchor), id: override.startAnchor.id || `${key}-start`, radiusM: Number(override.startAnchor.radiusM || START_RADIUS_M) },
      borderAnchor: pt(override.borderAnchor) ? { ...pt(override.borderAnchor), id: `${key}-border` } : null,
      endAnchor: { ...pt(override.endAnchor), id: override.endAnchor.id || `${key}-end`, radiusM: Number(override.endAnchor.radiusM || END_RADIUS_M) },
      maxSessionMinutes: Number(override.maxSessionMinutes || MAX_SESSION_MINUTES),
      source: 'static',
    };
  }

  const anchors = crossing?.anchors?.[direction];
  const start = pt(anchors?.approachStart);
  const border = pt(anchors?.borderPoint);
  const end = pt(anchors?.exitPoint) || border;
  if (!start || !border) return null; // not enough calibration → signal does not arm

  return {
    crossingId: crossing.id,
    direction,
    startAnchor: { ...start, id: `${key}-start`, radiusM: START_RADIUS_M },
    borderAnchor: { ...border, id: `${key}-border` },
    endAnchor: { ...end, id: `${key}-end`, radiusM: END_RADIUS_M },
    maxSessionMinutes: MAX_SESSION_MINUTES,
    source: 'derived-from-calibrated-anchors',
  };
}

export function hasLocationWaitAnchors(crossing, direction) {
  return Boolean(buildLocationWaitAnchors(crossing, direction));
}
