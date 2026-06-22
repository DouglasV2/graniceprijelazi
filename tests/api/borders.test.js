// BiH↔Serbia/Montenegro crossings: they surface in public state, and best-crossing compares within
// the SAME border (neighbour) rather than mixing a Serbia crossing into the Croatia comparison.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getApp } from '../helpers/app-loader.js';

let app;
beforeAll(async () => { app = await getApp(); });

const rankedIds = (body) => {
  const arr = body.ranking || body.list || body.crossings || body.results || [];
  return Array.isArray(arr) ? arr.map((x) => x.id).filter(Boolean) : [];
};

describe('Serbia / Montenegro borders', () => {
  it('public state lists the new crossings', async () => {
    const res = await request(app).get('/api/public/state');
    const ids = (res.body.crossings || []).map((c) => c.id);
    for (const id of ['sepak', 'raca', 'hum', 'deleusa']) expect(ids, `missing ${id}`).toContain(id);
  });

  it('best-crossing defaults to the Croatia border (neighbor=HR)', async () => {
    const res = await request(app).get('/api/best-crossing').query({ direction: 'toBih' });
    expect(res.status).toBe(200);
    expect(res.body.neighbor).toBe('HR');
    const ids = rankedIds(res.body);
    expect(ids).not.toContain('sepak'); // a Serbia crossing must not appear in the HR comparison
    expect(ids).not.toContain('hum');
  });

  it('best-crossing scopes to the reference crossing’s border (Serbia ref → only Serbia)', async () => {
    const res = await request(app).get('/api/best-crossing').query({ direction: 'toBih', referenceId: 'sepak' });
    expect(res.status).toBe(200);
    expect(res.body.neighbor).toBe('RS');
    const ids = rankedIds(res.body);
    if (ids.length) {
      for (const id of ids) expect(['sepak', 'raca'], `unexpected ${id} in RS comparison`).toContain(id);
    }
  });

  it('best-crossing accepts an explicit neighbor=CG', async () => {
    const res = await request(app).get('/api/best-crossing').query({ direction: 'toBih', neighbor: 'CG' });
    expect(res.body.neighbor).toBe('CG');
  });
});
