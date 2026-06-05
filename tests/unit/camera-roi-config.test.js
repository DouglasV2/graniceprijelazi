// ROI config resolution order (spec §1.1): DB → file override → static → null.
// We can prove the DB-priority + source labelling purely, by pushing a DB map into the sync cache.
import { describe, it, expect, afterEach } from 'vitest';
import {
  getRoiConfig,
  getRoiConfigSource,
  listRoiConfigIds,
  setDbRoiConfigs,
  STATIC_ROI_CONFIGS,
} from '../../server/camera-roi-config.js';

afterEach(() => setDbRoiConfigs({})); // reset the DB cache between tests

const staticId = Object.keys(STATIC_ROI_CONFIGS)[0]; // a seeded camera (e.g. mal-hak-hr-entry)

describe('ROI config fallback chain', () => {
  it('a seeded static config resolves with source "static" when no DB config', () => {
    expect(staticId).toBeTruthy();
    expect(getRoiConfigSource(staticId)).toBe('static');
    expect(getRoiConfig(staticId)).toBeTruthy();
  });

  it('a DB config takes priority over the static config and is labelled "db"', () => {
    const dbCfg = { cameraId: staticId, crossingId: 'maljevac', direction: 'toBih', queuePolygon: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }], roiVersion: 'db-test', source: 'db', isActive: true };
    setDbRoiConfigs({ [staticId]: dbCfg });
    expect(getRoiConfigSource(staticId)).toBe('db');
    expect(getRoiConfig(staticId).roiVersion).toBe('db-test');
  });

  it('listRoiConfigIds includes DB-only camera ids', () => {
    setDbRoiConfigs({ 'db-only-cam': { cameraId: 'db-only-cam', queuePolygon: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }] } });
    expect(listRoiConfigIds()).toContain('db-only-cam');
  });

  it('an unknown camera resolves to null with null source', () => {
    expect(getRoiConfig('totally-unknown-cam')).toBeNull();
    expect(getRoiConfigSource('totally-unknown-cam')).toBeNull();
  });
});
