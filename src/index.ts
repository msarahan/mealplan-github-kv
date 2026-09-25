// Nourish - Cloudflare Worker
// KV binding: NOURISH_KV
// Secret: ANTHROPIC_API_KEY

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
function err(msg, status) { return json({ error: msg }, status || 400); }

// Single place to change the model when Anthropic retires one. The Worker overrides
// whatever model the frontend sends, so /generate follows this too.
export const MODEL = 'claude-opus-5';

async function callAnthropic(env, payload) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      // If Claude declines a request, re-run it server-side on Anthropic's recommended fallback
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({ ...payload, model: MODEL, fallbacks: 'default' }),
  });
  return resp;
}

// Pull the JSON object out of a Messages API response (thinking blocks have no .text)
function extractJson(data) {
  if (data.stop_reason === 'refusal') throw new Error('Claude declined this request');
  const raw = data.content.map(b => b.text || '').join('');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start === -1) throw new Error('No JSON in response');
  return JSON.parse(raw.slice(start, end + 1));
}

// ── Mealime import ────────────────────────────────────────────────────────────
// Mealime recipe pages (app.mealime.com/recipe_variants/:id) only resolve at /print,
// which is public HTML with a stable structure. Pantry staples have no quantity in the
// shopping list; their amounts appear only in each step's <pre> block.
const MEALIME_RE = /^https?:\/\/(?:app\.)?mealime\.com\/recipe_variants\/(\d+)/i;

export function normalizeRecipeUrl(url) {
  const m = url.match(MEALIME_RE);
  return m ? `https://app.mealime.com/recipe_variants/${m[1]}/print` : url;
}

function decodeEntities(s) {
  return s.replace(/&nbsp;?/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function extractMealime(html) {
  const title = html.match(/<h1>([\s\S]*?)<\/h1>/);
  const stepBlocks = [...html.matchAll(/<li class="instruction">([\s\S]*?)<\/li>/g)];
  if (!title || !stepBlocks.length) return null;
  const desc = html.match(/<p class="description">([\s\S]*?)<\/p>/);

  const items = [...html.matchAll(/<li class="line-item">([\s\S]*?)<\/li>/g)].map(m => {
    const q = m[1].match(/<div class="quantity">([\s\S]*?)<\/div>/);
    const n = m[1].match(/<div class="ingredient">([\s\S]*?)<\/div>/);
    return '- ' + ((q ? stripTags(q[1]) : '') + ' ' + (n ? stripTags(n[1]) : '')).trim();
  });

  const steps = stepBlocks.map((m, i) => {
    const primary = m[1].match(/<div class="primary">([\s\S]*?)<\/div>/);
    const pre = m[1].match(/<pre>([\s\S]*?)<\/pre>/);
    let s = `${i + 1}. ${primary ? stripTags(primary[1]) : ''}`;
    if (pre) {
      const uses = decodeEntities(pre[1].replace(/<[^>]+>/g, ''))
        .split('\n').map(x => x.trim()).filter(Boolean);
      s += '\n   Uses: ' + uses.join('; ');
    }
    return s;
  });

  return `Recipe: ${stripTags(title[1])}
Time and servings: ${desc ? stripTags(desc[1]) : 'unknown'}

Shopping list (pantry staples are listed without quantities):
${items.join('\n')}

Steps:
${steps.join('\n')}

Note: The "Uses" lines give exact amounts per step. An ingredient's total amount is the SUM
of its amounts across all "Uses" lines (e.g. salt used in two steps). Use those totals
(then divide per serving) for the ingredients list. Omit cookware.`;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url  = new URL(request.url);
    const path = url.pathname;
    const seg  = path.split('/').filter(Boolean); // ['plan','ABC123']

    // ── KV helpers ───────────────────────────────────────────────────────────
    const kvGet = async (key) => {
      const v = await env.NOURISH_KV.get(key);
      return v ? JSON.parse(v) : null;
    };
    const kvPut = async (key, data, ttl) => {
      await env.NOURISH_KV.put(key, JSON.stringify(data),
        ttl ? { expirationTtl: ttl } : undefined);
    };

    const DAY  = 60 * 60 * 24;
    const YEAR = DAY * 365;

    // ── GET|PUT /plan/:code ──────────────────────────────────────────────────
    if (seg[0] === 'plan' && seg[1]) {
      if (request.method === 'GET')  return json(await kvGet('plan:' + seg[1]));
      if (request.method === 'PUT')  { await kvPut('plan:' + seg[1], await request.json(), DAY * 30); return json({ ok: true }); }
    }

    // ── GET|PUT /checks/:code ────────────────────────────────────────────────
    if (seg[0] === 'checks' && seg[1]) {
      if (request.method === 'GET')  return json(await kvGet('checks:' + seg[1]) || []);
      if (request.method === 'PUT')  { await kvPut('checks:' + seg[1], await request.json(), DAY * 30); return json({ ok: true }); }
    }

    // ── GET|PUT /settings/:code ──────────────────────────────────────────────
    if (seg[0] === 'settings' && seg[1]) {
      if (request.method === 'GET')  return json(await kvGet('settings:' + seg[1]));
      if (request.method === 'PUT')  { await kvPut('settings:' + seg[1], await request.json(), YEAR); return json({ ok: true }); }
    }

    // ── GET|PUT /recipes/:code ───────────────────────────────────────────────
    if (seg[0] === 'recipes' && seg[1]) {
      if (request.method === 'GET')  return json(await kvGet('recipes:' + seg[1]) || []);
      if (request.method === 'PUT')  { await kvPut('recipes:' + seg[1], await request.json(), YEAR); return json({ ok: true }); }
    }

    // ── GET|PUT /globalrecipes ───────────────────────────────────────────────
    // Single shared pool across all households; Recipe[] with sharedBy: {code, name}
    if (path === '/globalrecipes') {
      if (request.method === 'GET')  return json(await kvGet('recipes:global') || []);
      if (request.method === 'PUT')  { await kvPut('recipes:global', await request.json(), YEAR); return json({ ok: true }); }
    }

    // ── GET|PUT /history/:code ───────────────────────────────────────────────
    if (seg[0] === 'history' && seg[1]) {
      if (request.method === 'GET')  return json(await kvGet('history:' + seg[1]) || []);
      if (request.method === 'PUT')  { await kvPut('history:' + seg[1], await request.json(), DAY * 180); return json({ ok: true }); }
    }

    // ── POST /generate ───────────────────────────────────────────────────────
    if (request.method === 'POST' && path === '/generate') {
      const resp = await callAnthropic(env, await request.json());
      const data = await resp.json();
      return json(data, resp.status);
    }

    // ── POST /parse-recipe ───────────────────────────────────────────────────
    // Body: { url?: string, text?: string }
    // Fetches the URL server-side (avoids CORS), strips to text, asks Claude to extract recipe
    if (request.method === 'POST' && path === '/parse-recipe') {
      const body = await request.json();
      let sourceText = body.text || '';

      if (body.url && !sourceText) {
        try {
          const pageResp = await fetch(normalizeRecipeUrl(body.url), {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NourishBot/1.0)' },
          });
          if (!pageResp.ok) return err('Could not fetch URL: HTTP ' + pageResp.status);
          const html = await pageResp.text();
          // Strip tags, collapse whitespace, truncate to ~8000 chars
          sourceText = (MEALIME_RE.test(body.url) && extractMealime(html)) || html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 8000);
        } catch (e) {
          return err('Could not fetch URL: ' + e.message);
        }
      }

      if (!sourceText) return err('No URL or text provided');

      const prompt = `Extract the recipe from the following text and return it as JSON.
Return ONLY valid JSON, no markdown, no explanation.
If you cannot find a clear recipe, return {"error":"No recipe found"}.

CRITICAL: ingredients must be per 1 serving. If the recipe serves N people,
divide every ingredient quantity by N. Set servings:1. Nutrition fields are per serving.

JSON structure:
{
  "name": "Recipe name",
  "tags": ["tag1","tag2"],
  "prepMins": 20,
  "calories": 450,
  "protein": 30,
  "carbs": 40,
  "fat": 15,
  "servings": 1,
  "ingredients": ["1 cup item per serving","2 tbsp item per serving"],
  "steps": ["Step 1.","Step 2."],
  "sourceUrl": "${body.url || ''}",
  "notes": "Any useful notes"
}

Use US customary units (cups, tbsp, tsp, oz, lb).
Estimate calories/protein/carbs/fat per serving if not stated.
Tags should be short descriptors like: quick, vegetarian, make-ahead, high-protein, etc.

TEXT:
${sourceText}`;

      const resp = await callAnthropic(env, {
        max_tokens: 16000,  // caps thinking + answer together
        output_config: { effort: 'low' },
        system: 'You are a JSON API. Output ONLY raw JSON, no markdown, no explanation.',
        messages: [{ role: 'user', content: prompt }],
      });
      const data = await resp.json();
      if (data.error) return json(data, resp.status);
      try {
        return json(extractJson(data));
      } catch (e) {
        return err('Could not parse recipe: ' + e.message);
      }
    }

    // ── POST /parse-pdf ──────────────────────────────────────────────────────────
    // Body: multipart/form-data with field "pdf" (PDF file, max 10 MB)
    // Uses Claude's native PDF document support to extract recipe(s)
    if (request.method === 'POST' && path === '/parse-pdf') {
      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        return err('Expected multipart/form-data with a "pdf" field');
      }
      const file = formData.get('pdf') as File | null;
      if (!file) return err('No PDF file provided');
      if (file.size > 10 * 1024 * 1024) return err('PDF too large (max 10 MB)');

      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);

      const resp = await callAnthropic(env, {
        max_tokens: 16000,  // caps thinking + answer together
        output_config: { effort: 'low' },
        system: 'You are a JSON API. Output ONLY raw JSON, no markdown, no explanation.',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
            },
            {
              type: 'text',
              text: `Extract all recipes from this PDF (up to 5). Return ONLY valid JSON.
If no recipe is found, return {"error":"No recipe found"}.

CRITICAL: ingredients must be per 1 serving. If the recipe says it serves N people,
divide every ingredient quantity by N. Set servings:1. Set calories/protein/carbs/fat per serving.

{
  "recipes": [
    {
      "name": "Recipe name",
      "tags": ["tag1"],
      "prepMins": 20,
      "calories": 450,
      "protein": 30,
      "carbs": 40,
      "fat": 15,
      "servings": 1,
      "ingredients": ["1 cup item per serving (already divided by serving count)"],
      "steps": ["Step 1."],
      "notes": ""
    }
  ]
}

Use US customary units. Estimate nutrition per serving if not stated.
Tags examples: quick, vegetarian, vegan, make-ahead, high-protein, batch-prep.`,
            },
          ],
        }],
      });

      const data = await resp.json() as any;
      if (data.error) return json(data, resp.status);
      try {
        return json(extractJson(data));
      } catch (e) {
        return err('Could not parse recipe from PDF: ' + e.message);
      }
    }

    return err('Not found', 404);
  },
};