// Suspicious legacy-snapshot cleanup + CV/YOLO production-safety.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isSuspiciousLegacyPublicSnapshot, runYoloDetector } from '../../server/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const server = readFileSync(join(root, 'server', 'index.js'), 'utf8');

const legacy = (over = {}) => ({ sourceType: 'public-text-status', normalizedWaitMin: 360, metadata: {}, ...over });

describe('isSuspiciousLegacyPublicSnapshot — scoped, never over-broad', () => {
  it('flags a legacy public-text high wait with NO parserVersion', () => {
    expect(isSuspiciousLegacyPublicSnapshot(legacy({ normalizedWaitMin: 360 }))).toBe(true);
    expect(isSuspiciousLegacyPublicSnapshot(legacy({ normalizedWaitMin: 120 }))).toBe(true);
  });
  it('does NOT flag a public-text snapshot written by the NEW parser (has parserVersion)', () => {
    expect(isSuspiciousLegacyPublicSnapshot(legacy({ normalizedWaitMin: 360, metadata: { parserVersion: 'public-text-v2-boundary-2026-06', cleanupSafe: true } }))).toBe(false);
  });
  it('does NOT flag Google / camera / routing snapshots even at high waits', () => {
    expect(isSuspiciousLegacyPublicSnapshot({ sourceType: 'google-traffic-estimate', normalizedWaitMin: 360, metadata: {} })).toBe(false);
    expect(isSuspiciousLegacyPublicSnapshot({ sourceType: 'camera-snapshot-model', normalizedWaitMin: 240, metadata: {} })).toBe(false);
    expect(isSuspiciousLegacyPublicSnapshot({ sourceType: 'camera-visual', normalizedWaitMin: 360, metadata: {} })).toBe(false);
  });
  it('does NOT flag a public-text snapshot below the suspect threshold', () => {
    expect(isSuspiciousLegacyPublicSnapshot(legacy({ normalizedWaitMin: 11 }))).toBe(false);
    expect(isSuspiciousLegacyPublicSnapshot(legacy({ normalizedWaitMin: 119 }))).toBe(false);
  });
  it('respects a custom threshold', () => {
    expect(isSuspiciousLegacyPublicSnapshot(legacy({ normalizedWaitMin: 90 }), 60)).toBe(true);
    expect(isSuspiciousLegacyPublicSnapshot(legacy({ normalizedWaitMin: 90 }), 120)).toBe(false);
  });
});

describe('cleanup is wired into startup + refresh, and is NOT a global delete', () => {
  it('startup and refresh call the suspicious cleanup', () => {
    expect(server).toMatch(/if \(PRUNE_SUSPICIOUS_PUBLIC_SNAPSHOTS\) await pruneSuspiciousPublicSourceSnapshots\(\)/);
    expect(server).toMatch(/if \(PRUNE_SUSPICIOUS_PUBLIC_SNAPSHOTS\) pruneSuspiciousPublicSourceSnapshots\(\)\.catch/);
  });
  it('cleanup SQL is scoped to public-text-status + missing parserVersion (never a blanket >=120 delete)', () => {
    expect(server).toMatch(/DELETE FROM borderflow_source_snapshots\s*\n\s*WHERE source_type='public-text-status'/);
    expect(server).toMatch(/metadata->>'parserVersion'\) IS NULL/);
    // The forbidden over-broad form must not exist.
    expect(server).not.toMatch(/DELETE FROM borderflow_source_snapshots WHERE normalized_wait_min >= 120/);
  });
  it('new public snapshots are stamped with parserVersion + cleanupSafe', () => {
    expect(server).toMatch(/parserVersion: PUBLIC_PARSER_VERSION/);
    expect(server).toMatch(/cleanupSafe: true/);
    expect(server).toMatch(/publicParserMeta\(text, section, 'hak-border-status'\)/);
    expect(server).toMatch(/publicParserMeta\(text, section, 'bihamk-border-status'\)/);
  });
  it('exposes an admin prune endpoint (dry-run by default)', () => {
    expect(server).toMatch(/\/api\/admin\/sources\/prune-suspicious/);
  });
});

describe('forceSnapshot hole is closed', () => {
  it('a forced source refresh forwards forceSnapshot to the camera build', () => {
    expect(server).toMatch(/buildCameraSourceSnapshots\(\{ forceSnapshot: force \}\)/);
    expect(server).toMatch(/async function buildCameraSourceSnapshots\(\{ forceSnapshot = false \} = \{\}\)/);
  });
  it('camera-scan forces a fresh frame', () => {
    expect(server).toMatch(/buildCameraAnalyticsPayload\(crossingId, direction, \{ storeScan: true, forceSnapshot: true \}\)/);
  });
  it('forceSnapshot threads to the image fetch with a cache-buster', () => {
    expect(server).toMatch(/runSnapshotCounter\(camera, crossing\.id, direction, cached \|\| null, \{ forceSnapshot: Boolean\(options\.forceSnapshot\) \}\)/);
    expect(server).toMatch(/_cb=\$\{Date\.now\(\)\}/);
  });
});

describe('runYoloDetector is production-safe (never throws, always a diagnostic)', () => {
  it('returns a no-endpoint fallback (test env has no CV endpoint) instead of throwing', async () => {
    const r = await runYoloDetector({ id: 'cam' }, 'maljevac', 'toBih', Buffer.from('x'), 'image/jpeg');
    expect(r).toBeTruthy();
    expect(r.detections).toBeNull();
    expect(r.fallbackReason).toBe('no-endpoint');
    expect(typeof r.durationMs).toBe('number');
  });
  it('camera payload exposes the CV/YOLO debug fields', () => {
    for (const field of ['cvEnabled', 'cvUsed', 'cvSource', 'cvFallbackReason', 'cvDurationMs', 'cvDetectionsCount']) {
      expect(server).toMatch(new RegExp(`${field}:`));
    }
    // source must reflect ACTUAL usage, not merely that an endpoint is configured.
    expect(server).toMatch(/cvSummary\.cvUsed \? 'cv-detector'/);
  });
});
