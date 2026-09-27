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

import { MODEL, CLASSIFY_BATCH, MAX_OPTIMIZE_STEPS } from './config';

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

// ── Recipe extraction ─────────────────────────────────────────────────────────
// Structured outputs guarantee the reply is valid JSON matching this schema, so a
// stray fraction like `"protein": 42 1/2` can't break parsing.
const str = { type: 'string' };
const strList = { type: 'array', items: str };
// The app's dietary approaches (see Configure tab)
const DIETS = ['climatarian', 'mediterranean', 'omnivore', 'plant-based'];
const dietList = { type: 'array', items: { type: 'string', enum: DIETS } };
const DIET_RULES = `diets: every dietary approach the recipe fits (often several; can be empty):
- plant-based: no animal products at all (no meat, fish, dairy, eggs, or honey).
- climatarian: no beef or lamb; built mainly on legumes, fish, poultry, or plant proteins.
- mediterranean: vegetables, legumes, whole grains, fish/seafood or poultry, olive oil;
  little or no red meat, butter, or heavily processed ingredients.
- omnivore: any balanced meal (nearly every recipe fits).`;

const RECIPE_SCHEMA = {
  type: 'object',
  properties: {
    name: str, tags: strList, prepMins: { type: 'integer' },
    calories: { type: 'number' }, protein: { type: 'number' },
    carbs: { type: 'number' }, fat: { type: 'number' }, servings: { type: 'integer' },
    ingredients: strList, steps: strList, notes: str, diets: dietList,
  },
  required: ['name', 'tags', 'prepMins', 'calories', 'protein', 'carbs', 'fat',
             'servings', 'ingredients', 'steps', 'notes', 'diets'],
  additionalProperties: false,
};
const RECIPES_SCHEMA = {
  type: 'object',
  properties: { recipes: { type: 'array', items: RECIPE_SCHEMA } },
  required: ['recipes'],
  additionalProperties: false,
};

const RECIPE_RULES = `Return {"recipes": []} if there is no clear recipe.

CRITICAL: ingredients must be per 1 serving. If the recipe serves N people,
divide every ingredient quantity by N. Set servings to 1. Nutrition fields are per serving.

Use US customary units (cups, tbsp, tsp, oz, lb). Write ingredient fractions in plain
ASCII (e.g. "1/2 cup rice"). Estimate calories/protein/carbs/fat per serving if not stated.
prepMins is total active + cooking time in minutes.
Tags are short descriptors like: quick, vegetarian, vegan, make-ahead, high-protein, batch-prep.
${DIET_RULES}`;

// One Claude call whose reply is guaranteed to match `schema`. Returns the parsed object.
async function callStructured(env, content, schema, effort = 'low') {
  const resp = await callAnthropic(env, {
    max_tokens: 16000,  // caps thinking + answer together
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || 'Anthropic API error');
  if (data.stop_reason === 'max_tokens') throw new Error('Response too long');
  return extractJson(data);
}

// content: the user-message content blocks. Returns Recipe[] or throws.
async function extractRecipes(env, content) {
  const { recipes } = await callStructured(env, content, RECIPES_SCHEMA);
  if (!recipes.length) throw new Error('No recipe found');
  return recipes;
}

// ── Diet classification for recipes saved before `diets` existed ─────────────
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: str, diets: dietList },
        required: ['id', 'diets'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

// recipes: [{id, name, ingredients}]. Returns [{id, diets}] for known ids only.
async function classifyDiets(env, recipes) {
  const list = recipes.map(r =>
    `id=${r.id} | ${r.name} | ${(r.ingredients || []).join('; ')}`).join('\n');
  const { results } = await callStructured(env,
    `For each recipe below, list the dietary approaches it fits. Return one result per id.
${DIET_RULES}

RECIPES:
${list}`, CLASSIFY_SCHEMA);
  const ids = new Set(recipes.map(r => r.id));
  return results.filter(r => ids.has(r.id));
}

// ── Recipe direction optimization (cooking mode) ─────────────────────────────
// Claude rewrites a recipe's steps so repeated prep happens once, and tags each
// step with minutes, hands-on vs hands-off, and the steps it must wait for. The
// app builds the timeline (and 1- vs 2-cook schedules) from those.
const OPTIMIZE_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: str,
          kind: { type: 'string', enum: ['prep', 'cook'] },
          label: str,
          text: str,
          mins: { type: 'number' },
          handsOn: { type: 'boolean' },
          after: strList,
        },
        required: ['id', 'kind', 'label', 'text', 'mins', 'handsOn', 'after'],
        additionalProperties: false,
      },
    },
    changes: strList,
  },
  required: ['steps', 'changes'],
  additionalProperties: false,
};

// recipe: {name, ingredients, steps}. Returns {steps, changes} with ids/deps cleaned up.
async function optimizeSteps(env, recipe) {
  const out = await callStructured(env,
    `Rewrite these recipe directions so they are efficient for a home cook.

RECIPE: ${recipe.name}
INGREDIENTS:
${recipe.ingredients.map(i => '- ' + i).join('\n')}
DIRECTIONS:
${recipe.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

RULES
- Do each kind of prep once: if an ingredient is chopped/minced/grated/zested/juiced in more
  than one step, do all of it in one early "prep" step and say how to divide it, using
  fractions or "the rest" (e.g. "Mince all the garlic; set aside about half for the sauce").
  Never write ingredient amounts; the app shows scaled amounts separately.
- Group related prep (e.g. chop all the vegetables together) when it saves time.
- Start long hands-off work early: preheat the oven or boil water first; marinate, soak,
  or chill as soon as possible.
- Keep every instruction that matters: temperatures, times, doneness cues, pan sizes.
  Don't add new ingredients or change the dish.
- steps: ids "s1", "s2", ... in the order a single cook should do them.
  kind "prep" for mise en place, "cook" for the rest.
  label: 2-5 word summary for a timeline, starting with a verb, e.g. "Chop vegetables",
  "Wash and start rice", "Bake salmon". Clear enough to know which step it is.
  mins: realistic minutes for the step at home pace.
  handsOn: false when the cook is free during the step (oven, simmering unattended,
  resting, marinating, preheating, water coming to a boil); true otherwise.
  after: ids of steps that must finish before this one can start. List only real
  dependencies, so independent work (chopping while water boils) can overlap.
- changes: 1-4 short notes on what you changed, e.g. "Minced all the garlic at once
  (was in steps 2 and 5)". Empty if nothing needed changing.`,
    OPTIMIZE_SCHEMA, 'medium');

  // Make ids unique and deps valid (existing, non-self ids; the app's scheduler
  // also tolerates cycles)
  const seen = new Set();
  const steps = out.steps.map((s, i) => {
    const id = s.id && !seen.has(s.id) ? s.id : 's' + (i + 1) + '_' + i;
    seen.add(id);
    return { ...s, id, mins: Math.max(0, Math.min(600, Number(s.mins) || 0)) };
  });
  const ids = new Set(steps.map(s => s.id));
  steps.forEach(s => { s.after = [...new Set((s.after || []).filter(a => ids.has(a) && a !== s.id))]; });
  return { steps, changes: out.changes || [] };
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

      const prompt = `Extract the recipe from the following text as a single-item recipes array.
${RECIPE_RULES}

TEXT:
${sourceText}`;

      try {
        const [recipe] = await extractRecipes(env, prompt);
        return json({ ...recipe, sourceUrl: body.url || '' });
      } catch (e) {
        return err('Could not parse recipe: ' + e.message);
      }
    }

    // ── POST /classify-diets ─────────────────────────────────────────────────────
    // Body: { recipes: [{id, name, ingredients}] } (max CLASSIFY_BATCH) → { results: [{id, diets}] }
    if (request.method === 'POST' && path === '/classify-diets') {
      const body = await request.json().catch(() => ({}));
      const recipes = Array.isArray(body.recipes) ? body.recipes : [];
      if (!recipes.length) return err('No recipes provided');
      if (recipes.length > CLASSIFY_BATCH) return err(`At most ${CLASSIFY_BATCH} recipes per request`);
      try {
        return json({ results: await classifyDiets(env, recipes) });
      } catch (e) {
        return err('Could not classify recipes: ' + e.message);
      }
    }

    // ── POST /optimize-steps ─────────────────────────────────────────────────────
    // Body: { name, ingredients: string[], steps: string[] } → { steps: [...], changes: string[] }
    if (request.method === 'POST' && path === '/optimize-steps') {
      const body = await request.json().catch(() => ({}));
      const steps = Array.isArray(body.steps) ? body.steps.filter(s => typeof s === 'string' && s.trim()) : [];
      if (!steps.length) return err('No steps provided');
      if (steps.length > MAX_OPTIMIZE_STEPS) return err(`At most ${MAX_OPTIMIZE_STEPS} steps`);
      try {
        return json(await optimizeSteps(env, {
          name: String(body.name || 'Recipe'),
          ingredients: Array.isArray(body.ingredients) ? body.ingredients.map(String) : [],
          steps,
        }));
      } catch (e) {
        return err('Could not optimize steps: ' + e.message);
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

      try {
        const recipes = await extractRecipes(env, [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: `Extract all recipes from this PDF (up to 5).
If the PDF is a Mealime export, pantry staples may be listed without amounts; their
amounts appear under individual steps, so sum each ingredient across all steps.
Omit cookware.
${RECIPE_RULES}` },
        ]);
        return json({ recipes });
      } catch (e) {
        return err('Could not parse recipe from PDF: ' + e.message);
      }
    }

    return err('Not found', 404);
  },
};