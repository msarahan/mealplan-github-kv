# Nourish — Smart Meal Planner

A shared household meal planning app powered by Claude AI. Generates weekly meal plans tailored to your household's dietary preferences, scales recipes by servings, manages a grocery list with real-time check-off sync, and lets you save and edit your own recipe library.

## Features

- **AI meal plan generation** — Claude builds a full week of meals based on your diet, serving sizes, calorie/protein targets, and optimization priorities (min prep, batch cooking, variety, etc.)
- **Grocery list** — auto-generated from the plan, categorized, with real-time check-off sync across household members
- **Recipe library** — save recipes from URLs (parsed server-side by Claude), edit ingredients/steps, scale by servings
- **Shared household** — all data keyed by a 6-character household code; share the code with family to sync instantly
- **Single deployment** — frontend + API in one Cloudflare Worker; no separate hosting needed

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Single-file HTML/CSS/JS (`frontend/index.html`) |
| Backend | Cloudflare Worker (`src/index.ts`) |
| Storage | Cloudflare KV (`NOURISH_KV`) |
| AI | Anthropic Claude API (proxied server-side) |
| Hosting | Cloudflare Workers + custom domain |
| Access control | Cloudflare Zero Trust (email allowlist) |
| CI/CD | GitHub Actions → `wrangler deploy` on push to `main` |

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/plan/:code` | Load meal plan |
| PUT | `/plan/:code` | Save meal plan |
| GET | `/checks/:code` | Load grocery check-off state |
| PUT | `/checks/:code` | Save grocery check-off state |
| GET | `/settings/:code` | Load household settings |
| PUT | `/settings/:code` | Save household settings |
| GET | `/recipes/:code` | Load recipe library |
| PUT | `/recipes/:code` | Save recipe library |
| POST | `/generate` | Proxy to Anthropic API |
| POST | `/parse-recipe` | Fetch URL + extract recipe JSON via Claude |

## Local development

```bash
npm ci
npx wrangler dev
```

Serves both the frontend and API locally with a local KV store.

## Deployment

Push to `main` — GitHub Actions runs `npm ci`, deploys the Worker, and syncs the `ANTHROPIC_API_KEY` secret to Cloudflare.

Required GitHub Actions secrets:
- `CLOUDFLARE_API_TOKEN`
- `ANTHROPIC_API_KEY`

## Access control

The app is served at `meals.fatcowshrine.com` behind Cloudflare Zero Trust Access. Visiting the URL redirects to a Cloudflare login page that sends a one-time PIN to allowlisted email addresses.

The `workers.dev` URL is disabled (`"workers_dev": false` in `wrangler.jsonc`).
