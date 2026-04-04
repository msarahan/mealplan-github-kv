# Nourish - Smart Meal Planner

## Project overview
A shared household meal planning app. A Cloudflare Worker acts as backend (KV storage + Anthropic API proxy). The frontend is a single-file mobile-first HTML app deployed on Netlify.

## Repository structure
```
mealplan-github-kv/
├── src/
│   └── index.js          ← Cloudflare Worker (backend)
├── frontend/
│   └── index.html        ← Single-file app (HTML + CSS + JS)
├── wrangler.toml         ← Cloudflare Worker config
├── package.json
└── CLAUDE.md             ← this file
```

## Deployment
- **Worker**: Cloudflare Workers, auto-deployed on push to main via GitHub integration
  - URL: `https://mealplan-github-kv.msarahan528.workers.dev`
  - KV binding name: `NOURISH_KV`
  - Secret: `ANTHROPIC_API_KEY` (set in Cloudflare dashboard, never in code)
- **Frontend**: Netlify, manual deploy by drag-dropping `frontend/index.html`
  - The `WORKER_URL` constant near the top of `index.html` must match the Worker URL above

## Worker API endpoints
All endpoints return JSON with CORS headers.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/plan/:code` | Load shared meal plan |
| PUT | `/plan/:code` | Save meal plan (30 day TTL) |
| GET | `/checks/:code` | Load grocery check-off state |
| PUT | `/checks/:code` | Save grocery check-off state |
| GET | `/settings/:code` | Load household settings |
| PUT | `/settings/:code` | Save household settings (1 year TTL) |
| GET | `/recipes/:code` | Load saved recipe library |
| PUT | `/recipes/:code` | Save recipe library |
| POST | `/generate` | Proxy to Anthropic API (adds API key) |
| POST | `/parse-recipe` | Fetch URL + extract recipe via Claude |

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
The `fmtQty()` function snaps floats to clean fractions using GCD reduction over denominators [1,2,3,4,6,8], so 0.666... → 2/3, 1.5 → 1 1/2, etc.

## Sync behaviour
- Settings, plan, and recipes sync to KV on every change
- Grocery check-offs sync to KV on each tap, and poll every 8s when grocery tab is active
- Local `localStorage` is used as fallback when Worker URL is not configured

## Claude Code tips
- The frontend is intentionally a single HTML file — keep it that way for simple Netlify deployment
- Test Worker changes locally with `npx wrangler dev` before pushing
- The Worker uses ES module syntax (`export default { async fetch() {} }`)
- Never put the Anthropic API key in code — it's a Cloudflare secret
