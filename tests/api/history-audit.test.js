// T4/T6 — history persistence honesty:
//  * slots persist per crossing+direction+local(Zagreb) date+hour from REAL source snapshots
//  * HR→BiH and BiH→HR never mix
//  * Google traffic estimates never become "history"
//  * no fabricated cars/trucks breakdown (zeros unless a CV camera classified vehicles)
//  * driver reports land as the lowest-rank source and cannot overwrite camera/public slots
//  * /api/admin/history-audit exposes the raw rows + warnings to verify all of this live
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp } from '../helpers/app-loader.js';

let app;
let mod;
let adminToken;

const CID = 'maljevac';

function snap({ direction = 'toBih', wait = 25, sourceType = 'public-text-status', sourceName = 'HAK', fetchedAt = new Date().toISOString(), metadata = {} } = {}) {
  return {
    id: `test-${sourceType}-${direction}-${Math.random().toString(36).slice(2)}`,
    crossingId: CID,
    direction,
    sourceName,
    sourceType,
    sourceUrl: '',
    rawStatus: 'test',
    rawText: 'test',
    rawWaitMin: wait,
    normalizedWaitMin: wait,
    confidence: 70,
    weight: 1,
    metadata,
    fetchedAt,
  };
}

beforeAll(async () => {
  app = await getApp();
  mod = await import('../../server/index.js');
  // Must match the SEEDED admin (verifyToken checks the user exists in the store).
  adminToken = mod.signToken({ id: 'admin-access', email: 'admin@borderflow.app', role: 'admin', name: 'Admin' });
  // Start from a clean history store so leftover rows from previous runs can't outrank our writes.
  await request(app).post('/api/admin/reset-history').set('Authorization', `Bearer ${adminToken}`);
});
const auth = (req) => req.set('Authorization', `Bearer ${adminToken}`);

describe('history persistence — crossing+direction+local time', () => {
  it('a public source snapshot lands in the Europe/Zagreb hour bucket with no fabricated vehicles', async () => {
    const now = new Date();
    const slot = await mod.upsertHistoryFromSourceSnapshot(snap({ direction: 'toBih', wait: 33, fetchedAt: now.toISOString() }));
    expect(slot).toBeTruthy();
    const expected = mod.historyLocalDateHour(now);
    expect(slot.hour).toBe(expected.hour);
    expect(slot.wait).toBe(33);
    // Honesty: a text source observes a WAIT, never vehicles.
    expect(slot.cars + slot.vans + slot.trucks + slot.buses).toBe(0);
    expect(slot.passed).toBe(0);
    expect(slot.vehicleCountsObserved).toBe(false);
    expect(slot.source).toMatch(/^source-/);

    const rows = await mod.readHistorySnapshots(CID, 'toBih', [expected.dateIso]);
    const found = rows.find((row) => row.hour === expected.hour);
    expect(found).toBeTruthy();
    expect(found.wait).toBe(33);
  });

  it('directions are isolated: a toBih slot never appears under toHr', async () => {
    const now = new Date();
    const { dateIso, hour } = mod.historyLocalDateHour(now);
    await mod.upsertHistoryFromSourceSnapshot(snap({ direction: 'toBih', wait: 44, fetchedAt: now.toISOString() }));
    const toHrRows = await mod.readHistorySnapshots(CID, 'toHr', [dateIso]);
    expect(toHrRows.find((row) => row.hour === hour && row.wait === 44)).toBeFalsy();
  });

  it('google-traffic-estimate snapshots are NOT history', async () => {
    const out = await mod.upsertHistoryFromSourceSnapshot(snap({ sourceType: 'google-traffic-estimate', wait: 5 }));
    expect(out).toBeNull();
  });

  it('an unparseable wait is skipped (no static-table fallback into history)', async () => {
    const bad = snap({ wait: 20 });
    bad.normalizedWaitMin = 'nije-broj'; // clampWait → null for non-numeric values
    const out = await mod.upsertHistoryFromSourceSnapshot(bad);
    expect(out).toBeNull();
  });

  it('camera slots beat public slots in the same hour; reports can never overwrite either', async () => {
    const now = new Date();
    const { dateIso, hour } = mod.historyLocalDateHour(now);
    // 1) public source writes the hour
    await mod.upsertHistoryFromSourceSnapshot(snap({ direction: 'toHr', wait: 21, fetchedAt: now.toISOString() }));
    // 2) report tries to overwrite → blocked (lower rank)
    const blocked = await mod.upsertHistoryFromSourceSnapshot(snap({ direction: 'toHr', wait: 99, sourceType: 'driver-report', sourceName: 'Dojava vozača', fetchedAt: now.toISOString() }));
    expect(blocked).toBeNull();
    // 3) camera overwrites public (higher rank)
    const camera = await mod.upsertHistoryFromSourceSnapshot(snap({
      direction: 'toHr', wait: 28, sourceType: 'camera-snapshot-model', sourceName: 'Kamera snapshot model',
      fetchedAt: now.toISOString(), metadata: { queueVehicles: 7, throughputPerHour: 60 },
    }));
    expect(camera).toBeTruthy();
    expect(camera.source).toBe('camera-snapshot-counter');
    // Heuristic camera: real TOTAL, no per-class fabrication.
    expect(camera.queueVehicles).toBe(7);
    expect(camera.cars + camera.trucks).toBe(0);
    expect(camera.vehicleCountsObserved).toBe(false);
    const rows = await mod.readHistorySnapshots(CID, 'toHr', [dateIso]);
    const finalRow = rows.find((row) => row.hour === hour);
    expect(finalRow.wait).toBe(28);
    // 4) public can no longer overwrite the camera slot
    const after = await mod.upsertHistoryFromSourceSnapshot(snap({ direction: 'toHr', wait: 11, fetchedAt: now.toISOString() }));
    expect(after).toBeNull();
  });

  it('CV-classified camera slot stores the REAL per-class breakdown and is marked observed', async () => {
    const now = new Date();
    const cv = await mod.upsertHistoryFromSourceSnapshot(snap({
      direction: 'toBih', wait: 31, sourceType: 'camera-snapshot-model', sourceName: 'Kamera snapshot model',
      fetchedAt: now.toISOString(),
      metadata: { queueVehicles: 9, vehiclesInQueueRoi: 9, throughputPerHour: 80, countsObserved: true, realCounts: { cars: 6, vans: 1, trucks: 2, buses: 0 } },
    }));
    expect(cv).toBeTruthy();
    expect(cv.source).toBe('camera-cv-counter');
    expect(cv.vehicleCountsObserved).toBe(true);
    expect(cv.cars).toBe(6);
    expect(cv.trucks).toBe(2);
  });
});

describe('GET /api/history honesty payload', () => {
  it('returns slots for the requested direction with the vehicle honesty flags', async () => {
    const res = await request(app).get(`/api/history/${CID}`).query({ direction: 'toBih', days: 7 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.timezone).toBe('Europe/Zagreb');
    expect(res.body).toHaveProperty('vehicleCountsAreReal');
    expect(res.body).toHaveProperty('vehicleTotalsAreReal');
    expect(res.body.coverage).toHaveProperty('reportSlots');
    for (const row of res.body.history) {
      expect(row.crossingId).toBe(CID);
      expect(row.direction).toBe('toBih');
      // History must never serve synthetic model rows unless backfill is explicitly enabled.
      expect(String(row.source || '')).not.toContain('historical-model');
    }
  });
});

describe('POST /api/reports feeds history as lowest-rank source', () => {
  it('a report fills an empty hour for its crossing+direction', async () => {
    // Use a crossing+direction nothing else in this suite writes to.
    const res = await auth(request(app).post('/api/reports')).send({ crossingId: 'bijaca', direction: 'toHr', type: 'slow', waitMinutes: 52 });
    expect(res.status).toBe(201);
    const { dateIso, hour } = mod.historyLocalDateHour(new Date());
    const rows = await mod.readHistorySnapshots('bijaca', 'toHr', [dateIso]);
    const slot = rows.find((row) => row.hour === hour);
    expect(slot).toBeTruthy();
    expect(slot.source).toBe('report-dojava');
    expect(slot.wait).toBe(52);
    expect(slot.cars + slot.trucks).toBe(0);
  });
});

describe('GET /api/admin/history-audit', () => {
  it('requires admin', async () => {
    const res = await request(app).get('/api/admin/history-audit');
    expect(res.status).toBeGreaterThanOrEqual(401);
  });

  it('shows the persisted slots with wait band, source class and warnings', async () => {
    const res = await auth(request(app).get('/api/admin/history-audit')).query({ crossingId: CID });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.timezone).toBe('Europe/Zagreb');
    const toBih = res.body.crossings.find((c) => c.crossingId === CID && c.direction === 'toBih');
    expect(toBih).toBeTruthy();
    expect(toBih.slots.length).toBeGreaterThan(0);
    const slot = toBih.slots[0];
    expect(slot).toHaveProperty('date');
    expect(slot).toHaveProperty('hour');
    expect(slot).toHaveProperty('wait');
    expect(slot).toHaveProperty('waitBand');
    expect(slot).toHaveProperty('queueVehicles');
    expect(slot).toHaveProperty('vehicleCountsObserved');
    expect(slot).toHaveProperty('sourceClass');
    expect(Array.isArray(slot.warnings)).toBe(true);
  });
});
