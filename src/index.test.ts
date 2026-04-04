import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const BASE = 'http://example.com';

// ── CORS ─────────────────────────────────────────────────────────────────────

describe('OPTIONS preflight', () => {
  it('returns 200 with CORS headers on any path', async () => {
    const res = await SELF.fetch(`${BASE}/plan/abc`, { method: 'OPTIONS' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });
});

describe('JSON responses include CORS header', () => {
  it('GET /plan includes Access-Control-Allow-Origin', async () => {
    const res = await SELF.fetch(`${BASE}/plan/cors-check`);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

// ── /plan ────────────────────────────────────────────────────────────────────

describe('GET /plan/:code', () => {
  it('returns null when not found', async () => {
    const res = await SELF.fetch(`${BASE}/plan/missing`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('returns stored plan', async () => {
    const plan = { days: ['Monday'], meals: { Monday: 'Pasta' } };
    await env.NOURISH_KV.put('plan:abc', JSON.stringify(plan));
    const res = await SELF.fetch(`${BASE}/plan/abc`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(plan);
  });
});

describe('PUT /plan/:code', () => {
  it('stores a plan and returns ok', async () => {
    const plan = { days: ['Tuesday'], meals: { Tuesday: 'Soup' } };
    const res = await SELF.fetch(`${BASE}/plan/xyz`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plan),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(JSON.parse((await env.NOURISH_KV.get('plan:xyz'))!)).toEqual(plan);
  });
});

// ── /checks ──────────────────────────────────────────────────────────────────

describe('GET /checks/:code', () => {
  it('returns empty array when not found', async () => {
    const res = await SELF.fetch(`${BASE}/checks/missing`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns stored checks', async () => {
    const checks = ['item1', 'item2'];
    await env.NOURISH_KV.put('checks:c1', JSON.stringify(checks));
    const res = await SELF.fetch(`${BASE}/checks/c1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(checks);
  });
});

describe('PUT /checks/:code', () => {
  it('stores checks and returns ok', async () => {
    const checks = ['item3'];
    const res = await SELF.fetch(`${BASE}/checks/c2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(checks),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(JSON.parse((await env.NOURISH_KV.get('checks:c2'))!)).toEqual(checks);
  });
});

// ── /settings ────────────────────────────────────────────────────────────────

describe('GET /settings/:code', () => {
  it('returns null when not found', async () => {
    const res = await SELF.fetch(`${BASE}/settings/missing`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('returns stored settings', async () => {
    const settings = { theme: 'dark', servings: 4 };
    await env.NOURISH_KV.put('settings:s1', JSON.stringify(settings));
    const res = await SELF.fetch(`${BASE}/settings/s1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(settings);
  });
});

describe('PUT /settings/:code', () => {
  it('stores settings and returns ok', async () => {
    const settings = { theme: 'light', servings: 2 };
    const res = await SELF.fetch(`${BASE}/settings/s2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(JSON.parse((await env.NOURISH_KV.get('settings:s2'))!)).toEqual(settings);
  });
});

// ── /recipes ─────────────────────────────────────────────────────────────────

describe('GET /recipes/:code', () => {
  it('returns empty array when not found', async () => {
    const res = await SELF.fetch(`${BASE}/recipes/missing`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns stored recipes', async () => {
    const recipes = [{ id: 'r-1', name: 'Pasta', tags: ['quick'] }];
    await env.NOURISH_KV.put('recipes:r1', JSON.stringify(recipes));
    const res = await SELF.fetch(`${BASE}/recipes/r1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(recipes);
  });
});

describe('PUT /recipes/:code', () => {
  it('stores recipes and returns ok', async () => {
    const recipes = [{ id: 'r-2', name: 'Salad', tags: ['vegan'] }];
    const res = await SELF.fetch(`${BASE}/recipes/r2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recipes),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(JSON.parse((await env.NOURISH_KV.get('recipes:r2'))!)).toEqual(recipes);
  });
});

// ── /parse-recipe ─────────────────────────────────────────────────────────────

describe('POST /parse-recipe', () => {
  it('returns 400 when no url or text provided', async () => {
    const res = await SELF.fetch(`${BASE}/parse-recipe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBeTruthy();
  });
});

// ── unknown routes ────────────────────────────────────────────────────────────

describe('unknown routes', () => {
  it('returns 404', async () => {
    const res = await SELF.fetch(`${BASE}/unknown`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 for route with missing code segment', async () => {
    const res = await SELF.fetch(`${BASE}/plan`);
    expect(res.status).toBe(404);
  });
});
