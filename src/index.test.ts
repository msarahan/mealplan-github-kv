import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractMealime, normalizeRecipeUrl, MODEL } from './index';

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

describe('Anthropic calls', () => {
  afterEach(() => vi.restoreAllMocks());

  function mockAnthropic(response: object) {
    const calls: { headers: Headers; body: any }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      calls.push({ headers: new Headers(init?.headers), body: JSON.parse(init?.body) });
      return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
    });
    return calls;
  }
  const parseText = () => SELF.fetch(`${BASE}/parse-recipe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Toast: toast bread.' }),
  });

  it('uses the current model with fallbacks and room for thinking, and skips thinking blocks', async () => {
    const calls = mockAnthropic({
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"recipes":[{"name":"Toast"}]}' }],
    });
    const res = await parseText();
    expect(await res.json()).toEqual({ name: 'Toast', sourceUrl: '' });
    expect(calls[0].body.model).toBe(MODEL);
    expect(calls[0].body.output_config.format.type).toBe('json_schema');
    expect(calls[0].body.fallbacks).toBe('default');
    expect(calls[0].body.max_tokens).toBeGreaterThanOrEqual(16000);
    expect(calls[0].headers.get('anthropic-beta')).toBe('server-side-fallback-2026-07-01');
  });

  it('/generate overrides a stale model from the client', async () => {
    const calls = mockAnthropic({ stop_reason: 'end_turn', content: [] });
    await SELF.fetch(`${BASE}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 100, messages: [] }),
    });
    expect(calls[0].body.model).toBe(MODEL);
  });

  it('reports "No recipe found" when the page has no recipe', async () => {
    mockAnthropic({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"recipes":[]}' }] });
    const res = await parseText();
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain('No recipe found');
  });

  it('PDF import returns the recipes array', async () => {
    const calls = mockAnthropic({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"recipes":[{"name":"A"},{"name":"B"}]}' }],
    });
    const fd = new FormData();
    fd.append('pdf', new File(['%PDF-1.4'], 'r.pdf', { type: 'application/pdf' }));
    const res = await SELF.fetch(`${BASE}/parse-pdf`, { method: 'POST', body: fd });
    expect(await res.json()).toEqual({ recipes: [{ name: 'A' }, { name: 'B' }] });
    expect(calls[0].body.messages[0].content[0].type).toBe('document');
  });

  it('reports a refusal instead of parsing it', async () => {
    mockAnthropic({ stop_reason: 'refusal', content: [] });
    const res = await parseText();
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain('declined');
  });
});

describe('Mealime import', () => {
  it('normalizes recipe_variants links to the public print page', () => {
    expect(normalizeRecipeUrl('https://app.mealime.com/recipe_variants/10694'))
      .toBe('https://app.mealime.com/recipe_variants/10694/print');
    expect(normalizeRecipeUrl('https://app.mealime.com/recipe_variants/10694/print'))
      .toBe('https://app.mealime.com/recipe_variants/10694/print');
    expect(normalizeRecipeUrl('https://example.com/pasta')).toBe('https://example.com/pasta');
  });

  it('extracts title, shopping list and per-step amounts from a print page', () => {
    const html = `<div class="meal-header"><h1>Mini Glazed Meatloaves &amp; Carrots</h1></div>
      <p class="description">40 minutes | 4 servings</p>
      <ul><li class="cookware"><a href="#">muffin pan</a></li></ul>
      <ul><li class="line-item"><div class="quantity">2</div><div class="ingredient">eggs</div></li>
      <li class="line-item"><div class="quantity">&nbsp</div><div class="ingredient">salt</div></li></ul>
      <ul><li class="instruction"><div class="number">1</div><div class="content"><div class="primary">Mix it.</div>
      <div class="secondary"><pre>2 eggs
1 tsp salt</pre></div></div></li>
      <li class="instruction"><div class="number">2</div><div class="content"><div class="primary">Season carrots.</div>
      <div class="secondary"><pre>⅛ tsp salt</pre></div></div></li></ul>`;
    const text = extractMealime(html)!;
    expect(text).toContain('Recipe: Mini Glazed Meatloaves & Carrots');
    expect(text).toContain('40 minutes | 4 servings');
    expect(text).toContain('- 2 eggs\n- salt');
    expect(text).toContain('1. Mix it.\n   Uses: 2 eggs; 1 tsp salt');
    expect(text).toContain('2. Season carrots.\n   Uses: ⅛ tsp salt');
    expect(text).not.toContain('muffin pan');
  });

  it('returns null for pages that are not Mealime recipes', () => {
    expect(extractMealime('<html><body>Page not found</body></html>')).toBeNull();
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
