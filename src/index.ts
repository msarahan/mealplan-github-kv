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
// How often /generate sends a keep-alive space while Claude is working
const KEEPALIVE_MS = 5000;

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

// Same call, streamed, assembled back into a Messages API response ({content, stop_reason,
// usage}) or {error}. A long reply (a week's plan) sent in one piece left the connection
// silent for minutes and Anthropic's edge gave up with a 524; streamed, text keeps flowing.
async function callAnthropicStreamed(env, payload) {
  const resp = await callAnthropic(env, { ...payload, stream: true });
  if (!resp.ok || !(resp.headers.get('Content-Type') || '').includes('text/event-stream')) {
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch { return { error: { message: `Claude's API returned an unreadable reply (HTTP ${resp.status}). Please try again.` } }; }
  }
  const msg = { content: [], stop_reason: null, usage: null };
  const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, '\n');
    let end;
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, end); buf = buf.slice(end + 2);
      const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      if (!data) continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === 'message_start') { msg.id = ev.message?.id; msg.model = ev.message?.model; msg.usage = ev.message?.usage; }
      else if (ev.type === 'content_block_start') msg.content[ev.index] = { ...ev.content_block };
      else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        const block = msg.content[ev.index] || (msg.content[ev.index] = { type: 'text', text: '' });
        block.text = (block.text || '') + ev.delta.text;
      }
      else if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason) msg.stop_reason = ev.delta.stop_reason;
        if (ev.usage) msg.usage = { ...msg.usage, ...ev.usage };
      }
      else if (ev.type === 'error') return { error: ev.error || { message: 'Claude stopped with an error. Please try again.' } };
    }
  }
  msg.content = msg.content.filter(Boolean);
  return msg;
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
// Which meals a recipe suits, and whether it needs cooking when it's eaten. The
// planner only puts a saved recipe in a meal it's tagged for, and lunches it picks
// need no cooking at lunch time ("make-ahead" ones only with a batch-prep task).
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'side'];
const mealTypeList = { type: 'array', items: { type: 'string', enum: MEAL_TYPES } };
const cookingEnum = { type: 'string', enum: ['none', 'make-ahead', 'at-meal'] };
const MEAL_RULES = `mealTypes: the meals the dish suits (one or more of ${MEAL_TYPES.join(', ')}); "side" for a side
  dish rather than a main. Most cooked mains (roasts, bakes, stir-fries, curries, pasta) are dinner
  only; add lunch only for dishes people commonly eat at lunch (salads, sandwiches, wraps, grain or
  noodle bowls, soups); breakfast only for breakfast foods.
cooking: how much cooking the dish needs when it is eaten:
- none: no cooking at all, just assembly (raw or ready-to-eat ingredients, overnight oats, sandwiches).
- make-ahead: has cooked parts that can be cooked in advance in a batch (grains, noodles, roasted
  vegetables, beans, chicken, soup), then eaten cold or just reheated.
- at-meal: must be cooked right before eating (stir-fries, pan-seared or roasted mains, eggs to order).`;

const RECIPE_SCHEMA = {
  type: 'object',
  properties: {
    name: str, tags: strList, prepMins: { type: 'integer' },
    calories: { type: 'number' }, protein: { type: 'number' },
    carbs: { type: 'number' }, fat: { type: 'number' }, servings: { type: 'integer' },
    ingredients: strList, steps: strList, notes: str, diets: dietList,
    mealTypes: mealTypeList, cooking: cookingEnum,
  },
  required: ['name', 'tags', 'prepMins', 'calories', 'protein', 'carbs', 'fat',
             'servings', 'ingredients', 'steps', 'notes', 'diets', 'mealTypes', 'cooking'],
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
${DIET_RULES}
${MEAL_RULES}`;

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

// ── Classification for recipes saved before diets/mealTypes/cooking existed ──
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: str, diets: dietList, mealTypes: mealTypeList, cooking: cookingEnum },
        required: ['id', 'diets', 'mealTypes', 'cooking'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

// recipes: [{id, name, ingredients, steps?}]. Returns [{id, diets, mealTypes, cooking}] for known ids only.
async function classifyRecipes(env, recipes) {
  const list = recipes.map(r =>
    `id=${r.id} | ${r.name} | ${(r.ingredients || []).join('; ')}`
    + (Array.isArray(r.steps) && r.steps.length ? ` | steps: ${r.steps.join(' ').slice(0, 400)}` : '')).join('\n');
  const { results } = await callStructured(env,
    `For each recipe below, list the dietary approaches it fits, the meals it suits, and how much
cooking it needs when it is eaten. Return one result per id.
${DIET_RULES}
${MEAL_RULES}

RECIPES:
${list}`, CLASSIFY_SCHEMA);
  const ids = new Set(recipes.map(r => r.id));
  return results.filter(r => ids.has(r.id));
}

// ── Recipe direction optimization (cooking mode) ─────────────────────────────
// Claude rewrites a recipe's steps so repeated prep happens once, and tags each
// step with minutes, hands-on vs hands-off, the steps it must wait for, and the
// ingredients it uses. The app builds the timeline (and 1- vs 2-cook schedules)
// from those, and shows each step's ingredients at the scaled amounts.
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
          uses: {
            type: 'array',
            items: {
              type: 'object',
              properties: { ing: { type: 'integer' }, part: { type: 'number' } },
              required: ['ing', 'part'],
              additionalProperties: false,
            },
          },
        },
        required: ['id', 'kind', 'label', 'text', 'mins', 'handsOn', 'after', 'uses'],
        additionalProperties: false,
      },
    },
    changes: strList,
  },
  required: ['steps', 'changes'],
  additionalProperties: false,
};

// recipe: {name, ingredients, steps}. Returns {steps, changes} with ids/deps cleaned up;
// each step's uses is [{i, part}]: a 0-based index into ingredients and the fraction used.
async function optimizeSteps(env, recipe) {
  const out = await callStructured(env,
    `Rewrite these recipe directions so they are efficient for a home cook.

RECIPE: ${recipe.name}
INGREDIENTS:
${recipe.ingredients.map((i, n) => `${n + 1}. ${i}`).join('\n')}
DIRECTIONS:
${recipe.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

RULES
- Do each kind of prep once: if an ingredient is chopped/minced/grated/zested/juiced in more
  than one step, do all of it in one early "prep" step and say how to divide it, using
  fractions or "the rest" (e.g. "Mince all the garlic; set aside about half for the sauce").
  Never write ingredient amounts in the text; the app shows each step's scaled amounts
  from uses.
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
  uses: every ingredient the step handles or adds, as ing = its number in INGREDIENTS
  and part = the fraction of it used in this step (1 for all of it, 0.5 for half). An
  ingredient prepped in one step and added in later ones is in each, e.g. "Mince all
  the garlic" uses garlic part 1, then "Add half the garlic" uses it part 0.5. Empty
  for steps that use no ingredients (preheating the oven).
- changes: 1-4 short notes on what you changed, e.g. "Minced all the garlic at once
  (was in steps 2 and 5)". Empty if nothing needed changing.${cookingNotesText(recipe.notes)}`,
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
  // Ingredient numbers → 0-based indexes into the list sent (unknown ones dropped,
  // repeats merged); part clamped to (0, 1], defaulting to all of it
  steps.forEach(s => {
    const parts = new Map();
    (Array.isArray(s.uses) ? s.uses : []).forEach(u => {
      const i = Math.round(Number(u && u.ing)) - 1;
      if (!(i >= 0 && i < recipe.ingredients.length)) return;
      const part = Number(u.part) > 0 ? Math.min(1, Number(u.part)) : 1;
      parts.set(i, Math.min(1, (parts.get(i) || 0) + part));
    });
    s.uses = [...parts].map(([i, part]) => ({ i, part: Math.max(0.01, Math.round(part * 100) / 100) }));
  });
  return { steps, changes: out.changes || [] };
}

// Notes the household recorded while cooking (e.g. "Bake salmon took 20 min, not 15")
function cookingNotesText(notes) {
  const list = (Array.isArray(notes) ? notes : []).map(String).filter(Boolean).slice(-20);
  return list.length ? '\n\nNOTES FROM COOKING THIS BEFORE (trust these over your own estimates):\n'
    + list.map(n => '- ' + n).join('\n') : '';
}

// ── Recipe revision from cooking feedback ────────────────────────────────────
const REVISE_SCHEMA = {
  type: 'object',
  properties: {
    recipe: {
      type: 'object',
      properties: {
        name: str, prepMins: { type: 'integer' },
        calories: { type: 'number' }, protein: { type: 'number' },
        carbs: { type: 'number' }, fat: { type: 'number' },
        ingredients: strList, steps: strList, notes: str,
      },
      required: ['name', 'prepMins', 'calories', 'protein', 'carbs', 'fat', 'ingredients', 'steps', 'notes'],
      additionalProperties: false,
    },
    changes: strList,
  },
  required: ['recipe', 'changes'],
  additionalProperties: false,
};

// recipe: {name, ingredients (per serving), steps, prepMins, calories, protein, carbs, fat, notes}
async function reviseRecipe(env, recipe, feedback, notes) {
  return callStructured(env,
    `Revise this household recipe based on how cooking it went.

RECIPE: ${recipe.name}
Total time: ${recipe.prepMins || '?'} min. Per serving: ${recipe.calories || '?'} kcal, ${recipe.protein || '?'}g protein, ${recipe.carbs || '?'}g carbs, ${recipe.fat || '?'}g fat.
INGREDIENTS (per 1 serving):
${(recipe.ingredients || []).map(i => '- ' + i).join('\n')}
DIRECTIONS:
${(recipe.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}
NOTES: ${recipe.notes || '(none)'}

FEEDBACK: ${feedback || '(none; apply the cooking notes below)'}${cookingNotesText(notes)}

RULES
- Change only what the feedback calls for; keep everything else as written.
- Update times, temperatures and doneness cues in the directions when the feedback says
  something took longer or shorter; update prepMins to match.
- Ingredients stay per 1 serving, US units, ASCII fractions ("1/2 cup rice").
- Recalculate nutrition only if ingredients change.
- Keep notes; append a short line about this revision if it's useful for next time.
- changes: 1-5 short notes on what you changed, in plain words. Empty if nothing needed changing.`,
    REVISE_SCHEMA, 'medium');
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
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url  = new URL(request.url);
    const path = url.pathname;
    const seg  = path.split('/').filter(Boolean); // ['plan','ABC123']

    // ── GET /app-version ─────────────────────────────────────────────────────
    // This deployment's id, so a page that stays open for days (an iOS home
    // screen app resumes instead of reloading) can tell a new version shipped
    if (path === '/app-version' && request.method === 'GET') {
      const res = json({ version: env.CF_VERSION_METADATA?.id ?? null });
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }

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
    // A full week's plan can take Claude a couple of minutes. Claude's reply is
    // streamed in (callAnthropicStreamed) so that connection never sits silent, and
    // the app is answered at once with a space every few seconds, then the JSON.
    // Leading whitespace is valid JSON. Failures come back as {error:{message}} too.
    if (request.method === 'POST' && path === '/generate') {
      const payload = await request.json();
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      const keepAlive = setInterval(() => { writer.write(enc.encode(' ')).catch(() => {}); }, KEEPALIVE_MS);
      const finish = (async () => {
        let body;
        try {
          body = await callAnthropicStreamed(env, payload);
        } catch (e) {
          body = { error: { message: 'Could not reach Claude: ' + (e?.message || e) } };
        }
        clearInterval(keepAlive);
        try { await writer.write(enc.encode(JSON.stringify(body))); await writer.close(); } catch {}
      })();
      if (ctx?.waitUntil) ctx.waitUntil(finish);
      return new Response(readable, { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
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

    // ── POST /classify-recipes ───────────────────────────────────────────────────
    // Body: { recipes: [{id, name, ingredients, steps?}] } (max CLASSIFY_BATCH)
    //   → { results: [{id, diets, mealTypes, cooking}] }
    // /classify-diets is its old name, kept for pages loaded before the rename
    if (request.method === 'POST' && (path === '/classify-recipes' || path === '/classify-diets')) {
      const body = await request.json().catch(() => ({}));
      const recipes = Array.isArray(body.recipes) ? body.recipes : [];
      if (!recipes.length) return err('No recipes provided');
      if (recipes.length > CLASSIFY_BATCH) return err(`At most ${CLASSIFY_BATCH} recipes per request`);
      try {
        return json({ results: await classifyRecipes(env, recipes) });
      } catch (e) {
        return err('Could not classify recipes: ' + e.message);
      }
    }

    // ── POST /optimize-steps ─────────────────────────────────────────────────────
    // Body: { name, ingredients: string[], steps: string[] }
    //   → { steps: [{id, kind, label, text, mins, handsOn, after, uses: [{i, part}]}], changes: string[] }
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
          notes: body.notes,
        }));
      } catch (e) {
        return err('Could not optimize steps: ' + e.message);
      }
    }

    // ── POST /revise-recipe ──────────────────────────────────────────────────────
    // Body: { recipe: {name, ingredients, steps, prepMins, calories, protein, carbs, fat, notes},
    //         feedback: string, notes?: string[] } → { recipe: {...}, changes: string[] }
    if (request.method === 'POST' && path === '/revise-recipe') {
      const body = await request.json().catch(() => ({}));
      const recipe = body.recipe || {};
      const feedback = String(body.feedback || '').trim().slice(0, 2000);
      if (!Array.isArray(recipe.steps) || !recipe.steps.length) return err('No recipe steps provided');
      if (!feedback && !(Array.isArray(body.notes) && body.notes.length)) return err('No feedback provided');
      try {
        return json(await reviseRecipe(env, recipe, feedback, body.notes));
      } catch (e) {
        return err('Could not revise recipe: ' + e.message);
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