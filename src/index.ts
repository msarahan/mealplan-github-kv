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

async function callAnthropic(env, payload) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });
  return resp;
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
          const pageResp = await fetch(body.url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NourishBot/1.0)' },
          });
          const html = await pageResp.text();
          // Strip tags, collapse whitespace, truncate to ~8000 chars
          sourceText = html
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

JSON structure:
{
  "name": "Recipe name",
  "tags": ["tag1","tag2"],
  "prepMins": 20,
  "calories": 450,
  "protein": 30,
  "carbs": 40,
  "fat": 15,
  "servings": 4,
  "ingredients": ["1 cup item","2 tbsp item"],
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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: 'You are a JSON API. Output ONLY raw JSON, no markdown, no explanation.',
        messages: [{ role: 'user', content: prompt }],
      });
      const data = await resp.json();
      if (data.error) return json(data, resp.status);
      const raw = data.content.map(b => b.text || '').join('');
      const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
      if (start === -1) return err('Could not parse recipe from page');
      try {
        const recipe = JSON.parse(raw.slice(start, end + 1));
        return json(recipe);
      } catch (e) {
        return err('Invalid JSON from parser');
      }
    }

    return err('Not found', 404);
  },
};