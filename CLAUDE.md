# CLAUDE.md

## Project guide

- Runtime: Bun 1.3+ with Elysia.
- Database: PostgreSQL through Kysely/Postgres.js.
- Entry point: `src/index.js`.
- Schema changes: Kysely migration modules in `src/migrations`; startup does not run them automatically.
- External collectors: `src/routes/stash` (gold, lottery, MEA, MWA, solar and cinema).
- Cinema scraping lives in `src/routes/stash/cinema`; it uses `fetch` + `HTMLRewriter`, never a headless browser. See `docs/cinema-collector.md`.
- JSON/JSONB normalization: `parseJson` in `src/json.js` (Postgres.js may return JSONB strings).
- Shared JSON reminder persistence: `src/reminders.js`; use `getReminder`/`setReminder` instead of repeating JSONB upsert queries.
- Request metadata is request-local and comes from `requestContext` in `src/middleware.js`; do not store trace IDs or start times in Elysia's shared application `store`.

## Development commands

```bash
bun install
bun run migration:run
bun run dev
bun run test
bun run lint
bun run format
bun run build
```

The build output is `build/index.js` and is ignored by Git. Use `bun run lint:fix` or `bun run format:fix` only when intentional file rewrites are acceptable.

## Technical-debt update (2026-08-02)

- Replaced the shared mutable `store.traceId` with Elysia-derived request-local `traceId` and `requestStartedAt`. This prevents concurrent requests from overwriting one another's trace ID.
- Corrected response duration logging to measure `performance.now() - requestStartedAt`; the previous value represented process uptime divided by 1,000 and was not request latency.
- Added focused tests for caller-provided/generated trace IDs and elapsed-time calculation.
- Centralized repeated `reminder` JSONB reads/upserts in `src/reminders.js`, and adopted it for gold reminder data plus MEA/Solar tokens and Solar device status.
- Moved JSONB string normalization into side-effect-free `src/json.js`, avoiding database-client initialization when only a parser/helper module is imported.
- Changed lottery persistence from one insert/upsert per draw to one multi-row upsert per fetched batch, reducing database round-trips while retaining the same conflict-update fields.
- Initialized Day.js relative-time support once at module load and parses the latest gold-market numeric fields once without mutating the database result object.
- Added read-only `test`, `lint`, `format`, and production `build` package scripts so local and CI verification use stable commands.
- Excluded generated `build/**` bundles in the flat ESLint config so lint results cover source files consistently even after a local build.
- Corrected README setup: migrations are explicit, documented all MEA/Solar environment variables and current endpoints, and updated the Solar route description to its trailing-window behavior.
- Extended Solar persistence beyond numeric record-list values: string/raw telemetry, alarms, device/latest/energy-flow/config snapshots and station summaries now have queryable schemas; the bulk job backfills record/key history plus daily/monthly/yearly station buckets.

## Cinema collector update (2026-09-18)

- Absorbed the standalone `etl-cinema-scraper` (Puppeteer) into `src/routes/stash/cinema`, replacing the headless browser with `fetch` + `HTMLRewriter`; a full Major Cineplex run is ~0.7s instead of ~60s and the runtime image no longer needs Chromium.
- Major Cineplex Thai/English listings are fetched concurrently under separate `connect.sid` sessions and paired by movie path.
- Reads genre and running time from the hover card (`div.mlbc-cate`, `div.mlbc-time`) instead of the badge, which only exposed the first genre and no duration for roughly half the catalogue.
- `n_week`/`n_year` now record the collection week in Asia/Bangkok, matching what `GET /collector/cinema` filters on; the previous release-week value made the default listing almost always empty.
- Replaced the full-table duplicate scan plus one `DELETE` per duplicate with an in-memory single-pass merge and one set-based statement per name column, scoped to the week buckets the batch touched.
- `PATCH /stash/cinema` collects; `POST /stash/cinema` still ingests the legacy scraper payload.
- SF Cinema moved to `sfcinema.com` and now sits behind a Cloudflare interactive challenge; the provider detects it, logs a warning and degrades instead of failing the run.

## Cinema showtime/seat API (2026-09-18)

- Added live read-through endpoints under `/collector/cinema` for theaters, showtimes and seat availability. They never write to the database; only the branch list is cached in memory for six hours.
- Backed by three Major endpoints: `GET /home/cinema_bar/all`, `POST /booking2/get_showtime/` (the trailing slash matters, otherwise it 308s) and `GET /booking2/get_seat/{id}/`, whose seat plan is a JSON blob embedded in a `seat_data_string` variable rather than rendered markup.
- Branch lists and showtimes are fetched in both languages in parallel and paired by branch/showtime id, so a movie or branch can be asked for by its Thai or English name.
- Seat availability counts Vista `Status === 0`; seat lookups are issued one at a time and capped at 10 showtimes per request so a lookup never loads Major concurrently. The branch list is cached for 24 hours.
- Showtime queries must carry a time window (`time`, or `from` plus `to`) and a `date` of today or tomorrow. Both bounds keep a question narrow enough that the upstream load stays small.
- `src/routes/stash/cinema/session.js` holds the shared Major session helper used by both the collector and the booking client.

## Verification

Run all of the following before handoff:

```bash
bun run test
bun run lint
bun run format
bun run build
git diff --check
```

Current expected test inventory after this update: 53 tests across middleware, lottery/MEA/MWA/Solar mapping, token authorization, Solar device-status transitions, cinema normalisation/parsing, and cinema branch/showtime/seat parsing.
