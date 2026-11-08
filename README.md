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
- Tap a dinner to edit its name, recipe link and notes. Details belong to the
  dish, so they show up on every day it's planned. A ↗ icon opens the recipe.
- Swedish red days and notable eves (julafton, midsommarafton, …) are labelled
  and styled.
- Read-only **calendar feed** (ICS) so the plan shows up in Home Assistant or a
  phone calendar.
- Read-only **widget page** (`/widget`) with this week's dinners, made for
  embedding in a Home Assistant dashboard.

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

   `npm run deploy` applies any pending D1 migrations before deploying the
   Worker. If you deploy some other way (for example Cloudflare's Git
   integration), run `npm run db:migrate` first, because the new code
   expects the new schema.

## Home Assistant

There are two public, read-only ways to show the plan. Changing anything still
requires logging in.

### Widget (Webpage card)

`/widget` renders this week's dinners as a small styled page with a transparent
background, so it blends into a dashboard card. It highlights today, dims past
days, shows Swedish holidays, and reloads itself every 10 minutes. Dinners with
a recipe link are tappable and open the recipe in a new window. The ‹ and ›
buttons move between weeks; when another week is showing, it returns to the
current week after 2 minutes.

Add a **Webpage** card to the dashboard with the URL
`https://<your-worker-domain>/widget`. A 7-day week needs roughly 340 px of
height, so set the card's aspect ratio to about `90%`.

Options (query parameters):

- `theme=light` or `theme=dark` to force a colour scheme. By default it follows
  the device's setting.
- `week=1` shows next week (`week=-1` shows last week).
- `accent=FF9F0A` sets the highlight colour (hex, without `#`) to match your
  dashboard.

`/widget` is listed in `assets.run_worker_first` in `wrangler.jsonc`. Without
that, Cloudflare answers browser page loads with the app's `index.html`
before the Worker runs.

### Calendar feed

The Worker exposes the planned dinners as an iCalendar feed. Each dinner is an
all-day event; the feed covers 8 weeks back and 26 weeks ahead.

1. In Home Assistant: **Settings → Devices & services → Add integration →
   Remote Calendar**. Give it a name like `Middagar` and the URL:

   ```
   https://<your-worker-domain>/api/calendar.ics
   ```

   This creates an entity such as `calendar.middagar`.

2. Put it on a dashboard with a **Calendar** card (week or list view). The
   entity's `message` attribute is today's dinner, which you can show in a
   Tile or Entity card.

3. Remote Calendar only re-downloads the feed about once a day. To see changes
   sooner, add an automation that calls `homeassistant.update_entity` on
   `calendar.middagar` every 15 minutes (a time-pattern trigger).

The same URL works as a calendar subscription on a phone or in Google
Calendar. The feed is public and read-only: anyone with the URL can see the
dinner list, but changing anything still requires logging in.

## Project layout

```
worker/            Cloudflare Worker (Hono API + static asset serving)
  index.ts         Routes: /api/login, /api/meals, /api/dishes, ...
  auth.ts          Signed-cookie session helpers (Web Crypto HMAC)
  ical.ts          iCalendar writer for the calendar feed
  widget.ts        Server-rendered week widget for dashboards
migrations/        D1 SQL migrations
src/               React app
  components/       WeekView, DayColumn, MealCard, AddMeal, Login
  dates.ts          Week math (ISO week number, spans, Swedish names)
  holidays.ts       Swedish holiday computation
  api.ts            Typed fetch client
```

## Data model

- `dishes(id, name, uses, recipe_url, notes, created_at)`: every dish that has
  been entered, with a UUID `id`. Names are unique, ignoring case. This powers
  autocomplete.
- `meals(id, date, dish_id, sort_order, created_at)`: a dish planned for a day.
  It references `dishes.id`, so renaming a dish updates every day it's planned.
