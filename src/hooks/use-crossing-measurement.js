// One app-level "measure my A→B crossing" session: arm → watch GPS → throttled ping → lifecycle.
// The SERVER is authoritative (it times the pass from its own clock and infers the direction from the
// first fix); we never store a raw location trail. Lives at the App root so a measurement keeps running
// when the user switches tabs mid-crossing. Shared by the map's "Moja lokacija" button and the
// near-border prompt — a single watchPosition, never two.
import { useCallback, useEffect, useRef, useState } from 'react';
import { shouldSendPing } from '../utils/location-wait-client.js';

export function useCrossingMeasurement() {
  const [on, setOn] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [liveStatus, setLiveStatus] = useState('idle'); // idle | pending | active | completed
  const [userPos, setUserPos] = useState(null);
  const [activeCrossingId, setActiveCrossingId] = useState(null);
  const [paused, setPaused] = useState(false); // page hidden / screen locked → a PWA can't measure; say so honestly

  const watchIdRef = useRef(null);
  const wakeLockRef = useRef(null); // screen Wake Lock sentinel, held only while measuring + visible
  const sessionRef = useRef(null); // { sessionId, armed }
  const lastPingRef = useRef({ at: 0, point: null });
  const liveStatusRef = useRef('idle');
  const setLive = (s) => { liveStatusRef.current = s; setLiveStatus(s); };

  const stop = useCallback(() => {
    if (watchIdRef.current != null && navigator.geolocation) navigator.geolocation.clearWatch(watchIdRef.current);
    watchIdRef.current = null;
    const s = sessionRef.current;
    if (s?.sessionId) {
      fetch('/api/location-wait/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: s.sessionId }) }).catch(() => {});
    }
    sessionRef.current = null;
    lastPingRef.current = { at: 0, point: null };
    setUserPos(null);
    setLive('idle');
    setOn(false);
    setActiveCrossingId(null);
    setStatusText('Lokacija nije uključena.');
  }, []);

  // Defined once-per-render but only reads refs + stable setters, so the watchPosition callback
  // (set up in start) never sees a stale value.
  const sendPing = (point) => {
    const sess = sessionRef.current;
    if (!sess?.armed || !sess.sessionId) return;
    const decision = shouldSendPing({
      now: Date.now(),
      lastSentAt: lastPingRef.current.at,
      lastPoint: lastPingRef.current.point,
      point,
      status: liveStatusRef.current === 'idle' ? 'pending' : liveStatusRef.current,
      distanceToZoneM: 1000,
    });
    if (!decision.send) return;
    lastPingRef.current = { at: Date.now(), point };
    fetch('/api/location-wait/ping', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sess.sessionId, lat: point.lat, lng: point.lng, accuracyM: point.accuracyM }),
    })
      .then((r) => r.json().catch(() => null))
      .then((data) => {
        if (!data?.ok) return;
        if (data.status === 'active') { setLive('active'); setStatusText('Mjerim prelazak…'); }
        else if (data.status === 'completed') { setLive('completed'); setStatusText('Hvala — live procjena je ažurirana.'); sessionRef.current = { ...sess, armed: false }; }
      })
      .catch(() => { /* ignore — never break the UI */ });
  };

  const start = useCallback(({ crossingId, direction = 'auto', point = null } = {}) => {
    if (!crossingId) return;
    if (!('geolocation' in navigator)) { setStatusText('Lokacija nije dostupna na ovom uređaju.'); return; }
    if (watchIdRef.current != null) return; // a measurement is already running
    setOn(true);
    setActiveCrossingId(crossingId);
    setStatusText('Tražim lokaciju…');
    // Arm an anonymous session (server decides if it actually arms + which direction). 'auto' lets the
    // server resolve the crossing direction from the first fix.
    const body = { crossingId, direction };
    if (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) { body.lat = point.lat; body.lng = point.lng; }
    fetch('/api/location-wait/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json().catch(() => null))
      .then((data) => {
        if (data?.ok && data.armed && data.sessionId) { sessionRef.current = { sessionId: data.sessionId, armed: true }; setLive('pending'); }
        else sessionRef.current = { sessionId: null, armed: false }; // disabled/disarmed → location-only
      })
      .catch(() => { sessionRef.current = { sessionId: null, armed: false }; });

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy };
        setUserPos(p);
        setStatusText((prev) => (prev === 'Tražim lokaciju…' || prev === 'Lokacija nije uključena.') ? 'Lokacija uključena' : prev);
        sendPing(p);
      },
      () => { setStatusText('Lokacija nije uključena.'); setOn(false); if (watchIdRef.current != null) { navigator.geolocation.clearWatch(watchIdRef.current); watchIdRef.current = null; } },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
  }, []);

  const toggle = useCallback(({ crossingId, direction = 'auto' } = {}) => {
    if (watchIdRef.current != null) stop();
    else start({ crossingId, direction });
  }, [start, stop]);

  // Keep the screen awake while measuring so OS screen-sleep can't suspend watchPosition — the single
  // most common way a foreground measurement silently misses point B. The Wake Lock is auto-released
  // whenever the page is hidden, so we re-acquire it on return. And when the page IS hidden (screen
  // locked / app backgrounded) a PWA genuinely can't keep measuring — flag it honestly via `paused`
  // instead of pretending the pass is still being timed. (True background tracking needs native.)
  useEffect(() => {
    if (!on || typeof document === 'undefined') return undefined;
    let cancelled = false;
    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (cancelled) { sentinel.release().catch(() => {}); return; } // toggled off mid-request
        wakeLockRef.current = sentinel;
      } catch { /* denied/unsupported — measurement still works, just without anti-sleep */ }
    };
    const release = () => {
      const wl = wakeLockRef.current;
      wakeLockRef.current = null;
      if (wl) wl.release().catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { setPaused(false); acquire(); }
      else { setPaused(true); release(); } // OS already drops the lock when hidden; null our ref too
    };
    document.addEventListener('visibilitychange', onVisibility);
    setPaused(document.visibilityState !== 'visible');
    acquire();
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      release();
      setPaused(false);
    };
  }, [on]);

  return { on, statusText, liveStatus, userPos, activeCrossingId, isMeasuring: on, paused, start, stop, toggle };
}
