// Subtle, anonymous "live location" signal — pure logic (no network/DB/globals so it is fully
// testable). A driver who turns on "Moja lokacija" sends throttled pings; the SERVER decides the
// session lifecycle (pending → active → completed) from anchor geofences and SERVER time. We never
// trust client timestamps and never store a raw GPS trail — only the resulting status + measured
// wait feed the prediction as an extra `verifiedLocation` signal.
import { haversineMeters } from './intelligence.js';

const TERMINAL = new Set(['completed', 'cancelled', 'expired']);

export function withinAnchor(point, anchor) {
  if (!point || !anchor || !Number.isFinite(Number(anchor.lat))) return false;
  const d = haversineMeters(point, { lat: Number(anchor.lat), lng: Number(anchor.lng) });
  return d !== null && d <= Math.max(20, Number(anchor.radiusM || 120));
}

function median(sortedNumbers) {
  const n = sortedNumbers.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedNumbers[mid] : Math.round((sortedNumbers[mid - 1] + sortedNumbers[mid]) / 2);
}

// Drop the single lowest + highest sample once we have ≥4, so one extreme pass cannot dominate.
export function trimmedMedian(values = []) {
  const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (nums.length >= 4) return median(nums.slice(1, -1));
  return median(nums);
}

// Server-authoritative ping classification. Returns the NEW lifecycle state to apply to the session
// plus any server timestamps; never mutates its inputs. rejectionReason explains a no-op.
export function classifyLocationPing(session = {}, ping = {}, anchors = null, {
  now = Date.now(),
  maxAccuracyM = 100,
} = {}) {
  const out = {
    status: session.status || 'pending',
    measuredWaitMin: session.measuredWaitMin ?? null,
    serverStartedAt: session.serverStartedAt || null,
    serverCompletedAt: session.serverCompletedAt || null,
    transitioned: false,
    rejectionReason: null,
    startDistanceM: null,
    endDistanceM: null,
  };

  if (!anchors || !anchors.startAnchor || !anchors.endAnchor) { out.rejectionReason = 'no-anchor-config'; return out; }
  if (TERMINAL.has(out.status)) { out.rejectionReason = `terminal:${out.status}`; return out; }

  // Expire by SERVER clock (anti-gaming: a 6h "wait" is not a real crossing).
  const maxMs = Math.max(5, Number(anchors.maxSessionMinutes || 240)) * 60000;
  const startedMs = session.serverStartedAt ? new Date(session.serverStartedAt).getTime() : (session.startedAt ? new Date(session.startedAt).getTime() : now);
  if (out.status === 'active' && Number.isFinite(startedMs) && now - startedMs > maxMs) {
    out.status = 'expired'; out.transitioned = true; out.rejectionReason = 'expired'; return out;
  }

  // Reject a low-accuracy fix (city GPS noise) — keep the current state.
  const acc = Number(ping.accuracyM);
  if (Number.isFinite(acc) && acc > maxAccuracyM) { out.rejectionReason = 'low-accuracy'; return out; }

  const point = { lat: Number(ping.lat), lng: Number(ping.lng) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) { out.rejectionReason = 'bad-gps'; return out; }

  out.startDistanceM = haversineMeters(point, anchors.startAnchor);
  out.endDistanceM = haversineMeters(point, anchors.endAnchor);
  const inStart = withinAnchor(point, anchors.startAnchor);
  const inEnd = withinAnchor(point, anchors.endAnchor);

  // pending → active when the driver enters the start (queue-join) zone.
  if (out.status === 'pending') {
    if (inStart) { out.status = 'active'; out.serverStartedAt = new Date(now).toISOString(); out.transitioned = true; }
    else out.rejectionReason = 'outside-start';
    return out;
  }

  // active → completed when the driver reaches the end (past-the-booth) zone.
  if (out.status === 'active') {
    if (inEnd) {
      const sMs = new Date(out.serverStartedAt || startedMs).getTime();
      out.measuredWaitMin = Math.max(0, Math.round((now - sMs) / 60000));
      out.status = 'completed';
      out.serverCompletedAt = new Date(now).toISOString();
      out.transitioned = true;
    } else {
      out.rejectionReason = 'still-in-zone';
    }
    return out;
  }

  return out;
}

// Aggregate completed sessions into the verifiedLocation source-breakdown object. Outlier-safe
// (trimmed median) and age-aware (stale passes are ignored, not left strong).
export function aggregateVerifiedLocation(sessions = [], { now = Date.now(), maxAgeMin = 45 } = {}) {
  const completedAll = (sessions || []).filter((s) => s && s.status === 'completed' && Number.isFinite(Number(s.measuredWaitMin)) && (s.serverCompletedAt || s.completedAt));
  if (!completedAll.length) return { available: false, sampleCount: 0 };

  // Anti-poisoning: ONE vote per device (userSessionHash). A single origin can serially complete many
  // sessions; without this, ~4 fakes from one device move the trimmed median. Keep each device's most
  // recent completed pass. Sessions without a hash (unit fixtures) fall back to a unique key, so each
  // still counts individually. To dominate now an attacker needs many distinct devices (rate-limited).
  const byDevice = new Map();
  completedAll.forEach((s, idx) => {
    const key = s.userSessionHash || s.sessionId || s.id || `idx-${idx}`;
    const t = new Date(s.serverCompletedAt || s.completedAt).getTime();
    const prev = byDevice.get(key);
    if (!prev || t > new Date(prev.serverCompletedAt || prev.completedAt).getTime()) byDevice.set(key, s);
  });
  const completed = [...byDevice.values()];

  const withAge = completed.map((s) => ({
    wait: Number(s.measuredWaitMin),
    ageSec: Math.max(0, Math.round((now - new Date(s.serverCompletedAt || s.completedAt).getTime()) / 1000)),
  }));
  const fresh = withAge.filter((s) => s.ageSec <= maxAgeMin * 60);
  // Prefer fresh; if none are fresh the signal is treated as available-but-weak (no confidence boost).
  const usable = fresh.length ? fresh : withAge;
  const waitsSorted = usable.map((s) => s.wait).sort((a, b) => a - b);
  const medianWaitMin = trimmedMedian(waitsSorted);
  const latestAgeSeconds = Math.min(...usable.map((s) => s.ageSec));

  // Confidence: more FRESH agreeing samples → higher; a single fresh pass is solid ground truth but
  // not maxed; a wide spread or stale-only signal is discounted.
  let confidence;
  if (!fresh.length) confidence = 35;
  else if (fresh.length === 1) confidence = 78;
  else if (fresh.length === 2) confidence = 88;
  else confidence = 93;
  const spread = waitsSorted[waitsSorted.length - 1] - waitsSorted[0];
  if (fresh.length >= 2 && spread > 15) confidence -= 12;
  if (latestAgeSeconds > 20 * 60) confidence -= 8;
  confidence = Math.max(20, Math.min(95, confidence));

  return {
    available: true,
    sampleCount: completed.length,
    freshSampleCount: fresh.length,
    medianWaitMin,
    minWaitMin: waitsSorted[0],
    maxWaitMin: waitsSorted[waitsSorted.length - 1],
    latestAgeSeconds,
    confidence,
  };
}
