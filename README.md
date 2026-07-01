# 🍽️ foodweek — Veckans middagar

A super simple, Cloudflare-native web app for planning the week's dinners.
Log in, see the week at a glance, fill in dinners, and drag them between days.
Entered dinners are remembered so you get autocomplete next time. The header
shows the ISO week number, the date span, and Swedish holidays ("röda dagar")
are highlighted on each day.

## Stack

- **Frontend:** React + Vite (TypeScript)
- **Backend:** Cloudflare Workers (single Worker serving the app + a small `/api`, via [Hono](https://hono.dev))
- **Database:** Cloudflare **D1** (serverless SQLite)
- **Auth:** one shared password (a Worker secret) → signed, httpOnly session cookie
- **Drag & drop:** [`@dnd-kit`](https://dndkit.com) (works on touch + desktop)
- **Swedish holidays:** computed locally (Easter algorithm + fixed/movable red days), no external API

## Features

- Single-password login.
- Week view (Mon–Sun) with previous/next/"Idag" navigation.
- Each day has a full-width **+** button → autocomplete input. Pick an existing
  dinner or type a new one and create it on the fly.
- Drag a meal by its handle to reorder within a day or move it to another day.
- Swedish red days and notable eves (julafton, midsommarafton, …) are labelled
  and styled.

## Local development

```bash
npm install

# Secrets for local dev
cp .dev.vars.example .dev.vars   # then edit APP_PASSWORD / SESSION_SECRET

# Create the local D1 schema
npm run db:migrate:local

# Run the app (Vite + Worker + local D1 via the Cloudflare Vite plugin)
npm run dev
```

Then open the printed local URL and log in with the `APP_PASSWORD` from `.dev.vars`.

## Deploying to Cloudflare

1. **Create a D1 database** and put its id into `wrangler.jsonc`:

   ```bash
   npx wrangler d1 create foodweek
   # copy the returned database_id into wrangler.jsonc (replace REPLACE_WITH_YOUR_D1_DATABASE_ID)
   ```

2. **Apply migrations** to the remote database:

   ```bash
   npm run db:migrate
   ```

3. **Set the secrets** (these are not stored in the repo):

   ```bash
   npx wrangler secret put APP_PASSWORD
   npx wrangler secret put SESSION_SECRET   # use a long random string
   ```

4. **Deploy:**

   ```bash
   npm run deploy
   ```

## Project layout

```
worker/            Cloudflare Worker (Hono API + static asset serving)
  index.ts         Routes: /api/login, /api/meals, /api/dinners, ...
  auth.ts          Signed-cookie session helpers (Web Crypto HMAC)
migrations/        D1 SQL migrations
src/               React app
  components/       WeekView, DayColumn, MealCard, AddMeal, Login
  dates.ts          Week math (ISO week number, spans, Swedish names)
  holidays.ts       Swedish holiday computation
  api.ts            Typed fetch client
```

## Data model

- `dinners(name, uses, created_at)` — catalog of entered dinners, powers autocomplete.
- `meals(id, date, name, sort_order, created_at)` — a dinner planned for a day.
