# CLAUDE.md

## Project guide

- Runtime: Bun 1.3+ with Elysia.
- Database: PostgreSQL through Kysely/Postgres.js.
- Entry point: `src/index.js`.
- Schema changes: Kysely migration modules in `src/migrations`; startup does not run them automatically.
- External collectors: `src/routes/stash` (gold, lottery, MEA, solar and cinema ingestion).
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

## Verification

Run all of the following before handoff:

```bash
bun run test
bun run lint
bun run format
bun run build
git diff --check
```

Current expected test inventory after this update: 11 tests across middleware, lottery batch mapping, token authorization and Solar device-status transitions.
