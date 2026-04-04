# Nourish - Smart Meal Planner

## Project overview
A shared household meal planning app. A Cloudflare Worker serves both the backend API (KV storage + Anthropic API proxy) and the frontend as a static asset — everything deploys from a single repo via GitHub Actions CI.

## Repository structure
```
mealplan-github-kv/
├── src/
│   └── index.ts          ← Cloudflare Worker (backend, TypeScript)
├── src/
│   └── index.test.ts     ← Vitest integration tests (run inside Workers runtime)
├── frontend/
│   └── index.html        ← Single-file app (HTML + CSS + JS), served as static asset
├── .github/
│   └── workflows/
│       └── deploy.yml    ← CI: deploys worker + sets ANTHROPIC_API_KEY secret on every push to main
├── wrangler.jsonc         ← Cloudflare Worker config (assets, KV binding)
├── vitest.config.mts     ← Vitest config using @cloudflare/vitest-pool-workers
├── package.json
└── CLAUDE.md             ← this file
```

## Deployment
- **Everything**: single Cloudflare Worker at `https://mealplan-github-kv.msarahan528.workers.dev`
  - Frontend (`frontend/index.html`) served as static asset at `/`
  - API routes handled by `src/index.ts`
  - Auto-deployed on push to `main` via `.github/workflows/deploy.yml`
  - KV binding name: `NOURISH_KV`
  - Secrets: `ANTHROPIC_API_KEY` stored in Cloudflare (synced from GitHub Actions secret on each deploy)
- **Access control**: Cloudflare Zero Trust / Access can gate the URL to specific email addresses (free for ≤50 users)
- **Local dev**: `npx wrangler dev` serves both frontend and API locally

## CI/CD
- Push to `main` → GitHub Actions runs `npm ci`, `wrangler deploy`, then `wrangler secret put ANTHROPIC_API_KEY`
- Required GitHub Actions secrets: `CLOUDFLARE_API_TOKEN`, `ANTHROPIC_API_KEY`
- Tests: `npm test` (vitest, runs inside Miniflare Workers runtime)

## Worker API endpoints
All endpoints return JSON with CORS headers (`Access-Control-Allow-Origin: *`).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/plan/:code` | Load shared meal plan (30 day TTL) |
| PUT | `/plan/:code` | Save meal plan |
| GET | `/checks/:code` | Load grocery check-off state |
| PUT | `/checks/:code` | Save grocery check-off state |
| GET | `/settings/:code` | Load household settings (1 year TTL) |
| PUT | `/settings/:code` | Save household settings |
| GET | `/recipes/:code` | Load saved recipe library (1 year TTL) |
| PUT | `/recipes/:code` | Save recipe library |
| POST | `/generate` | Proxy to Anthropic API (keeps API key server-side) |
| POST | `/parse-recipe` | Fetch URL server-side + extract recipe JSON via Claude |

## KV key schema
```
plan:{householdCode}      → full plan JSON (see Plan schema)
checks:{householdCode}    → string[] of checked item IDs
settings:{householdCode}  → settings JSON (see Settings schema)
recipes:{householdCode}   → Recipe[] array
```

## Data schemas

### Household code
6-character alphanumeric string (e.g. `KR8M4P`). Generated client-side on household creation, shared manually with family members.

### Settings object
```json
{
  "activeDiets": ["climatarian"],
  "optPriority": ["min-ingredients", "min-prep", "batch-prep", "make-ahead", "variety"],
  "planDays": 7,
  "mealsPerDay": 3,
  "householdServings": {
    "breakfast": [2,2,2,2,2,4,4],
    "lunch":     [2,2,2,2,2,4,4],
    "dinner":    [4,4,4,4,4,4,4]
  },
  "leftoverLunches": 2,
  "customItems": [{ "id": "ci-123", "name": "Sparkling water", "qty": "x3" }],
  "cal": "2000",
  "protein": "120",
  "carbs": "220"
}
```
Household servings arrays are indexed Mon=0 through Sun=6.

### Plan object
```json
{
  "summary": {
    "totalUniqueIngredients": 28,
    "avgDailyCalories": 2000,
    "avgDailyProtein": 120,
    "sharedPrepTips": ["Chop onions in bulk on Sunday"]
  },
  "days": [{
    "dayName": "Monday",
    "meals": [{
      "type": "dinner",
      "name": "Lemon Herb Salmon",
      "tags": ["quick", "high-protein"],
      "prepMins": 20,
      "calories": 520,
      "protein": 42,
      "carbs": 18,
      "fat": 28,
      "ingredients": ["6 oz salmon fillet", "2 tbsp olive oil", "1 lemon"],
      "steps": ["Preheat oven to 400F.", "Season salmon.", "Bake 12-15 min."],
      "leftoversForLunch": true,
      "prepNote": null,
      "batchNote": null,
      "pinned": false,
      "isLeftover": false
    }]
  }],
  "groceryList": [{
    "name": "Salmon fillets",
    "qty": "2 lbs",
    "category": "Protein"
  }],
  "customItems": []
}
```

### Recipe object
```json
{
  "id": "r-1234567890",
  "name": "Lemon Herb Salmon",
  "tags": ["quick", "high-protein", "make-ahead"],
  "prepMins": 20,
  "calories": 520,
  "protein": 42,
  "carbs": 18,
  "fat": 28,
  "servings": 1,
  "ingredients": ["6 oz salmon fillet", "2 tbsp olive oil"],
  "steps": ["Preheat oven to 400F.", "Bake 12-15 min."],
  "sourceUrl": "https://example.com/recipe",
  "notes": "",
  "mealTypes": ["dinner"],
  "savedAt": 1234567890000
}
```

## Diet options
- `climatarian` — avoid beef/lamb, prefer legumes/fish/chicken/plant proteins
- `mediterranean` — olive oil, fish, whole grains, legumes, abundant veg
- `omnivore` — balanced all food groups
- `plant-based` — legumes, whole grains, nuts, seeds, veg, no animal products

Multiple diets use OR logic — each meal follows any one of the selected approaches.

## Optimization priorities (draggable, all always active)
- `min-ingredients` — reuse ingredients across meals
- `min-prep` — prefer recipes under 20 min
- `batch-prep` — bulk cooking/chopping opportunities
- `make-ahead` — meals that store and reheat well
- `variety` — different cuisines each day

## Ingredient quantity formatting
Quantities are expressed as US cooking measures (cups, tbsp, tsp, oz, lb).
- `parseIng(str)` parses a string like `"1 1/2 cup rice"` into `{qty, unit, rest}`. Handles improper fractions with spaces (`"6 /4 cup"` → 1.5).
- `fmtQty(n)` formats a float as a clean fraction using GCD reduction over denominators [1,2,3,4,6,8]: 0.666… → 2/3, 1.5 → 1 1/2.
- `scaleIngs(ings, servings)` applies both to an ingredient array.
- `normalizeFractions(str)` reduces any `N/D` fraction in a raw string (used to clean AI-returned grocery qty values).

## Sync behaviour
- Settings, plan, and recipes sync to KV on every change
- Grocery check-offs sync to KV on each tap, and poll every 8s when grocery tab is active
- Frontend uses relative API paths (`/plan/...`) — no hardcoded worker URL

## Claude Code tips
- The frontend is intentionally a single HTML file — keep it that way
- Run `npm test` after any Worker changes; tests run in the real Workers runtime via Miniflare
- The Worker uses ES module syntax (`export default { async fetch() {} }`)
- Never put the Anthropic API key in code — it's a Cloudflare secret synced by CI
- `wrangler deploy --dry-run` validates config without deploying
