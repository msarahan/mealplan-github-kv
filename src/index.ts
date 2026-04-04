// Nourish - Cloudflare Worker
// Deploy at: https://dash.cloudflare.com -> Workers -> Create Worker
// Then bind a KV namespace called NOURISH_KV
// Set secret: ANTHROPIC_API_KEY via Workers -> Settings -> Variables -> Secrets

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

function err(msg, status) {
  return json({ error: msg }, status || 400);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // ── GET /plan/:code ──────────────────────────────────────────────────────
    if (request.method === 'GET' && path.startsWith('/plan/')) {
      const code = path.split('/')[2];
      if (!code) return err('Missing code');
      const val = await env.NOURISH_KV.get('plan:' + code);
      return json(val ? JSON.parse(val) : null);
    }

    // ── PUT /plan/:code ──────────────────────────────────────────────────────
    if (request.method === 'PUT' && path.startsWith('/plan/')) {
      const code = path.split('/')[2];
      if (!code) return err('Missing code');
      const body = await request.json();
      // Store for 30 days
      await env.NOURISH_KV.put('plan:' + code, JSON.stringify(body), { expirationTtl: 60 * 60 * 24 * 30 });
      return json({ ok: true });
    }

    // ── GET /checks/:code ────────────────────────────────────────────────────
    if (request.method === 'GET' && path.startsWith('/checks/')) {
      const code = path.split('/')[2];
      if (!code) return err('Missing code');
      const val = await env.NOURISH_KV.get('checks:' + code);
      return json(val ? JSON.parse(val) : []);
    }

    // ── PUT /checks/:code ────────────────────────────────────────────────────
    if (request.method === 'PUT' && path.startsWith('/checks/')) {
      const code = path.split('/')[2];
      if (!code) return err('Missing code');
      const body = await request.json();
      await env.NOURISH_KV.put('checks:' + code, JSON.stringify(body), { expirationTtl: 60 * 60 * 24 * 30 });
      return json({ ok: true });
    }

    // ── GET /settings/:code ──────────────────────────────────────────────────
    if (request.method === 'GET' && path.startsWith('/settings/')) {
      const code = path.split('/')[2];
      if (!code) return err('Missing code');
      const val = await env.NOURISH_KV.get('settings:' + code);
      return json(val ? JSON.parse(val) : null);
    }

    // ── PUT /settings/:code ──────────────────────────────────────────────────
    if (request.method === 'PUT' && path.startsWith('/settings/')) {
      const code = path.split('/')[2];
      if (!code) return err('Missing code');
      const body = await request.json();
      await env.NOURISH_KV.put('settings:' + code, JSON.stringify(body), { expirationTtl: 60 * 60 * 24 * 365 });
      return json({ ok: true });
    }

    // ── POST /generate ───────────────────────────────────────────────────────
    // Proxies to Anthropic so the API key stays server-side
    if (request.method === 'POST' && path === '/generate') {
      const body = await request.json();
      const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      const data = await anthropicResp.json();
      return json(data, anthropicResp.status);
    }

    return err('Not found', 404);
  },
};
