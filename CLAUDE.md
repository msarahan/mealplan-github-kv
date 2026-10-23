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
│       └── deploy.yml    ← CI: deploys worker with the ANTHROPIC_API_KEY secret on every push to main
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
- Push to `main` → GitHub Actions runs `npm ci`, then `npm run deploy` with `DEPLOY_ARGS=--secrets-file …` so `ANTHROPIC_API_KEY` is uploaded with the deployment (a separate `wrangler secret put` fails when Cloudflare's Git build has uploaded a newer version in the meantime)
- Cloudflare's Git integration (Workers Builds) also builds this Worker, including PR branches
- Required GitHub Actions secrets: `CLOUDFLARE_API_TOKEN`, `ANTHROPIC_API_KEY`
- Tests: `npm test` (vitest, runs inside Miniflare Workers runtime)

## Worker API endpoints
All endpoints return JSON with CORS headers (`Access-Control-Allow-Origin: *`).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/app-version` | Current deployment id (`CF_VERSION_METADATA`); the page reloads itself when it changes |
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
| POST | `/optimize-steps` | Rewrite recipe steps for cooking mode (prep once, timings, dependencies) via Claude |
| POST | `/revise-recipe` | Revise a recipe from cooking feedback (returns revised recipe + list of changes) via Claude |

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
  "planStart": 4,
  "meals": [
    { "id": "breakfast", "name": "Breakfast", "notes": "" },
    { "id": "lunch", "name": "Lunch", "notes": "Packable, no reheating" },
    { "id": "dinner", "name": "Supper", "notes": "" }
  ],
  "mealsPerDay": 3,
  "householdServings": {
    "breakfast": [2,2,2,2,2,4,4],
    "lunch":     [2,2,2,2,2,4,4],
    "dinner":    [4,4,4,4,4,4,4]
  },
  "leftoverLunches": 2,
  "customItems": [{ "id": "ci-123", "name": "Sparkling water", "qty": "x3" }],
  "buyAs": { "parsley": "prepped" },
  "frozenPref": { "corn": true, "pea": false },
  "swaps": [{ "from": "soy milk", "fromLabel": "soy milk", "to": "oat milk" }],
  "householdNotes": "We shop on Friday. Kari cooks Sat, Mon and Fri...",
  "cal": "2000",
  "protein": "120",
  "carbs": "220"
}
```
Household servings arrays are indexed Mon=0 through Sun=6.
`planStart` (Mon=0..Sun=6, default 0) is the weekday new plans start on: the shopping day. Plan day `di` is not weekday `di`. Use `dowOf(plan, di)` (from the first day's `dayName`) for anything by weekday: servings, weekends, make-ahead days.
`meals` is each day's meals in order. `id` is the meal's type everywhere (plan `meal.type`, `householdServings` keys, recipe `mealTypes`); `breakfast`/`lunch`/`dinner` keep their planning rules (leftover lunches, prep timing) whatever their `name`. `notes` describes what to suggest and goes into the planning prompts. `mealsPerDay` is still written (= `meals.length`) for older app versions; settings without `meals` are migrated from `mealsPerDay` + the old `mealNames`.
`buyAs` maps a grocery item key (see `groceryItem()`) to `"prepped"` to buy it chopped/minced by volume; items in `BUY_FORMS` default to whole (bunch, head, count; cheese as a block; salad greens always by weight).
`frozenPref` maps a `FREEZABLE` item key to `true` (buy frozen) or `false` (fresh); unset keeps the recipe's form, except `FROZEN_DEFAULT` items (corn, mixed berries), which default to frozen.
`householdNotes` is free text from Configure → About your household (shopping day, who cooks when, prep time). It goes into every planning prompt via `householdRule()`: the week plan, backfill, single-meal swap, side suggestion and the freshness re-shuffle.
`swaps` are household ingredient substitutions, started from a grocery item's ⓘ popover. `from` is a grocery key (variants like "unsweetened soy milk" match too). Adding one rewrites the current plan's and saved recipes' ingredients, steps and names. They're listed in the plan prompts (`swapsRule`) and re-applied to new plans, refilled meals and imported recipes (`applySwapsToDish`).

## Grocery consolidation
`groceryItem(name, unit)` gives each ingredient a key: prep/size words are dropped and synonyms merged, but fresh/frozen/dried/canned stay separate. Both the local recompute and Claude's list (`consolidateGroceryList`, also run on every render) merge on that key. `buyAsQty(item)` converts the displayed qty to the household's whole/prepped choice without changing the stored qty.

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

A meal may also have `"sides": [...]` — side dishes with the same recipe fields as a meal (optionally `libraryId`), sharing the meal's servings; meal nutrition totals include them.

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
