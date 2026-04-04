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

// ── /history ─────────────────────────────────────────────────────────────────

describe('GET /history/:code', () => {
  it('returns empty array when not found', async () => {
    const res = await SELF.fetch(`${BASE}/history/missing`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns stored history', async () => {
    const history = [{ savedAt: 1234567890000, plan: { days: [] } }];
    await env.NOURISH_KV.put('history:h1', JSON.stringify(history));
    const res = await SELF.fetch(`${BASE}/history/h1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(history);
  });
});

describe('PUT /history/:code', () => {
  it('stores history and returns ok', async () => {
    const history = [{ savedAt: 9999999999000, plan: { days: [] } }];
    const res = await SELF.fetch(`${BASE}/history/h2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(history),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(JSON.parse((await env.NOURISH_KV.get('history:h2'))!)).toEqual(history);
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

// ── /globalrecipes ────────────────────────────────────────────────────────────

describe('GET /globalrecipes', () => {
  it('returns empty array when no global recipes exist', async () => {
    const res = await SELF.fetch(`${BASE}/globalrecipes`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns stored global recipes', async () => {
    const recipes = [{ id: 'r-1', name: 'Shared Pasta', sharedBy: { code: 'ABC123', name: 'Test Family' } }];
    await env.NOURISH_KV.put('recipes:global', JSON.stringify(recipes));
    const res = await SELF.fetch(`${BASE}/globalrecipes`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(recipes);
  });
});

describe('PUT /globalrecipes', () => {
  it('stores global recipes and returns ok', async () => {
    const recipes = [{ id: 'r-2', name: 'Community Curry', sharedBy: { code: 'XYZ789', name: 'Curry House' } }];
    const res = await SELF.fetch(`${BASE}/globalrecipes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recipes),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(JSON.parse((await env.NOURISH_KV.get('recipes:global'))!)).toEqual(recipes);
  });
});

// ── /parse-pdf ────────────────────────────────────────────────────────────────

describe('POST /parse-pdf', () => {
  it('returns 400 when no pdf field is provided', async () => {
    const fd = new FormData();
    const res = await SELF.fetch(`${BASE}/parse-pdf`, { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBeTruthy();
  });

  it('returns 400 when pdf exceeds 10 MB', async () => {
    const big = new Uint8Array(11 * 1024 * 1024).fill(37); // 11 MB of '%' chars
    const fd = new FormData();
    fd.append('pdf', new File([big], 'big.pdf', { type: 'application/pdf' }));
    const res = await SELF.fetch(`${BASE}/parse-pdf`, { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/too large/i);
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
