# Public API (`/v1`)

`/v1/*` is the only route exposed to the public internet. Everything else (`/stash`, `/collector`, `/notify`, `/reminder`, `/lottery`, `/docs`, `/health`) stays internal and must be blocked at the ingress.

Consumers: the portfolio site (`dvgamerr-app.github.io`) pulls these endpoints before build and writes `coding.json`, `experience.json`, `insights.json` and `telemetry.json`. Response keys reuse the names already in those files, extra keys are additive.

## Rules

- `GET` only, no auth, no writes. Other methods answer `405`.
- Errors are `application/problem+json` (RFC 9457): `400`, `404`, `422`, `503` (+ `Retry-After` when data is not collected yet).
- `Cache-Control: public, max-age=300`; CORS is `GET` only.
- Date window: `from`/`to` as `YYYY-MM-DD` (Asia/Bangkok), default is the last 12 months, wider than 5 years is `400`.
- Only aggregates leave the service: no heartbeat file names, project names or branches, no private repository names.

## Where each endpoint reads from

`GET` never calls an external API.

| Data                             | Source                                        | How                                                                                                                                         |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| WakaTime (time, days, telemetry) | database `wakatime` (`DATABASE_WAKATIME_URL`) | read directly, in-memory cache of 10 minutes. Not stashed: a stash would duplicate a database that already answers every query in 80-300 ms |
| GitHub                           | GitHub GraphQL + REST                         | `PATCH /stash/github` writes `stash.github_repo`                                                                                            |
| Exchange rates                   | Yahoo Finance                                 | `PATCH /stash/currency` writes `stash.exchange_rate`                                                                                        |

## Endpoints

| Endpoint                                       | Fills                                                       |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `GET /v1/coding`                               | `coding.json` (+ `experience.coding.bytes`, `skill.coding`) |
| `GET /v1/coding/days?from&to`                  | `insights.data.days`                                        |
| `GET /v1/telemetry?from&to`                    | `telemetry.json`                                            |
| `GET /v1/repositories?owner=&limit=&cursor=`   | `experience.repos`                                          |
| `GET /v1/exchange-rates?ccy=USD,JPY&quote=THB` | `experience.currencry`                                      |

### `GET /v1/telemetry`

Same keys as `telemetry.json`. `aiAssisted.monthly[].aiLines`/`humanLines` stay percentages (sum 100, computed from added lines); the raw counts are in `lines`. Removed lines are kept separately and never mixed into the percentage.

```json
{
  "timezone": "Asia/Bangkok",
  "rangeStart": "2025-10-17",
  "rangeEnd": "2026-10-17",
  "generatedAt": "2026-10-17T08:00:00Z",
  "workType": { "categories": [{ "name": "AI Coding", "percent": 58, "seconds": 0 }], "editorsCount": 3, "longestStreakDays": 55 },
  "aiAssisted": {
    "aiLinePercent": 80,
    "agentSessions": 1195,
    "longestTaskSeconds": 13396,
    "linesPerMillionTokens": 116,
    "lines": { "ai": { "added": 0, "removed": 0 }, "human": { "added": 0, "removed": 0 } },
    "monthly": [
      {
        "month": "Sep",
        "period": "2026-09",
        "aiLines": 62,
        "humanLines": 38,
        "lines": { "ai": { "added": 0, "removed": 0 }, "human": { "added": 0, "removed": 0 } }
      }
    ],
    "models": [
      {
        "name": "Claude Sonnet 5",
        "hours": 149,
        "key": "claude-sonnet-5",
        "agent": "claude",
        "tokens": { "input": 0, "output": 0 },
        "estCostUSD": 0,
        "priced": true
      }
    ],
    "tokens": { "inputTokens": 0, "outputTokens": 0, "estCostUSD": 0 }
  }
}
```

Computation (all on `wakatime.public.heartbeats`):

- Duration: gap to the next heartbeat, capped at 5 minutes (`GAP_SECONDS` in `src/routes/v1/waka.js`). A 5 minute cap reproduces WakaTime's own per-day totals (`insights.json`) to within ~5% and its all-time total (11,167 h) to within ~2%, while the profile's 15 minute timeout overshoots by ~40%.
- Category: `lower()` then mapped back to a display name (`ai coding` and `AI Coding` are the same bucket).
- Lines: `added = sum(greatest(x, 0))`, `removed = sum(greatest(-x, 0))` for `ai_line_changes` / `human_line_changes`.
- Model: token in `source_user_agents.user_agent` (`sonnet/5-5`, `opus/4-8`, `gpt/5.6-sol-xhigh`, `fable/5`), effort suffix stripped, joined to `ai_model_pricing` for the display name and cost. Rows without a token fall back to the agent name (`ai_agent_key`). A model missing from the pricing table is costed with the `default` row and reported with `priced: false`. AI heartbeats that carry neither a model nor an agent are listed as `unknown` and are not costed (their tokens still count in `tokens`).
- `linesPerMillionTokens = aiAdded / ((input + output) / 1e6)`.
- Sessions: `count(distinct ai_session)`. `longestTaskSeconds` is the longest unbroken run inside one session (it ends where the next heartbeat of that session is more than 5 minutes away), because one session id can be resumed over several days.
- Editors: distinct editor names, taken from the `<editor>-wakatime/` token of the plugin string.
- Streak: longest run of consecutive Bangkok days with any coding time.

### `GET /v1/coding`

Same keys as `coding.json` (`wakatime`, `total`, `public`, `private`, `languages`, `commits`, `loc`, `updated`, `average_seconds`, `weekly_seconds`, `best_seconds`, `daytime`, `weektime`) plus `bytes` (language -> bytes) and `popular` (top languages by bytes).

- `daytime`: 24 values, seconds coded per hour of the day over the last 365 days. `weektime`: 7 values, Monday first. The site only uses them relative to the maximum.
- `average_seconds` is the mean over every day of the 365-day window (idle days count as zero), `weekly_seconds` the mean of the last seven days and `best_seconds` the largest day, the same definitions the old `coding.json` used. `wakatime` is the all-time total as `H hrs M mins` (`totalSeconds` carries the raw value).
- Because AI agents keep emitting heartbeats around the clock, recent days can approach 24 h, so these figures are much higher than the older, pre-agent `coding.json`.
- `commits`, `loc`, `total/public/private`, `languages`, `bytes`, `popular` come from `stash.github_repo`; the time fields come from `wakatime`.

### `GET /v1/exchange-rates`

```json
{ "quote": "THB", "items": [{ "ccy": "USD", "buy": 32.41, "sell": 32.41, "updatedAt": "…" }] }
```

Yahoo returns one price, so `buy` equals `sell` (as in the original prototype `collector/currency.js`). Rates are stored per USD and cross-converted on read, so `ccy=JPY&quote=THB` works from the same table. A currency that was never collected answers `404` with a hint to call `PATCH /stash/currency?symbols=JPY`.

## Collectors (internal, cron)

| Endpoint                                | Source                                                                | Writes                | Cron    |
| --------------------------------------- | --------------------------------------------------------------------- | --------------------- | ------- |
| `PATCH /stash/currency?symbols=JPY,EUR` | Yahoo `USD{SYM}=X`                                                    | `stash.exchange_rate` | hourly  |
| `PATCH /stash/github`                   | GraphQL (repos, languages, commits) + REST `stats/contributors` (LOC) | `stash.github_repo`   | monthly |

- `currency`: always refreshes `THB` and every currency already stored, plus the ones in `symbols`.
- `github`: background job, `409` while one runs. Owners: the user behind `GH_USER_TOKEN`, `dvgamerr-app`, `dl-fansub`, `untirkx` (`GH_APP_TOKEN`), `ourkk` (`GH_OURKK_TOKEN`) and `scg-wedo` (`GH_WORK_TOKEN`); every token is only used for reads. A repository is kept only when `GH_AUTHOR_EMAIL` has at least one commit on its default branch, so repositories without contributions are skipped (and pruned if stored earlier). The cron runs once a month (`0 3 1 * *`) with `?full=true` so every repository gets its LOC in that one run; without `full` LOC is recomputed only for repos whose `pushed_at` changed, at most 50 per run. Public repositories are collected as well as private ones (private names are only counted, never listed). A GitHub `202` (stats still computing) is left for the next run.
- Commits = the owner's commits on the default branch; LOC = additions − deletions of the owner. `/v1/coding` leaves out any repository whose net LOC is negative, so deletions never pull the total down (the per-repository value stays in `stash.github_repo.loc`).

## Environment

| Variable                | Purpose                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_WAKATIME_URL` | read-only connection to database `wakatime`; unset answers `503` on the WakaTime endpoints only                                                                                    |
| `GH_USER_TOKEN`         | read-only GitHub token of the account itself (`GH_TOKEN`/`GITHUB_TOKEN` still work as fallbacks)                                                                                   |
| `GH_APP_TOKEN`          | read-only token for `dvgamerr-app`, `dl-fansub`, `untirkx` (formerly `GH_ORGS_TOKEN`, still accepted; falls back to the user token)                                                |
| `GH_OURKK_TOKEN`        | read-only token for the `ourkk` organisation (listed like the other organisations)                                                                                                 |
| `GH_WORK_TOKEN`         | read-only token for the work organisation `scg-wedo`: counted in the totals, repositories never listed                                                                             |
| `GH_AUTHOR_EMAIL`       | commit author e-mail(s) used to keep only repositories the owner has committed to, default `kananekt@scg.com`, `kem@ns.co.th`, `thkananek@central.co.th`, `info.dvgamer@gmail.com` |

## Schema (migration `012_v1`)

- `stash.github_repo` — `full_name` PK, `owner`, `description`, `stars`, `url`, `is_private`, `is_fork`, `pushed_at`, `languages` jsonb (`{name: bytes}`), `commits`, `loc`, `stat_pushed_at`, `updated_at`.
- `stash.exchange_rate` — `ccy` PK, `per_usd` numeric, `updated_at`.

## Rollout checklist

1. Deploy: startup applies `012_v1` itself (creates `stash.github_repo` and `stash.exchange_rate`); `bun run migration:run` does the same on demand.
2. Set `DATABASE_WAKATIME_URL` and the `GH_*_TOKEN` variables.
3. Add the new lines of `docs/crontab`, then call `PATCH /stash/currency` and `PATCH /stash/github` once by hand; repeat the GitHub call (or use `?full=true`) until `locPending` in the log reaches 0.
4. Block everything except `/v1/*` at the ingress (including `/docs`, which lists the internal routes).
