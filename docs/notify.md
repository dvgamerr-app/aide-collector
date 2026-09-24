# Notify

Pushes LINE messages through [notice-manager](https://notice.dvgamerr.app), which owns the LINE channel access token, chat registration and delivery retries. This service only builds message payloads and calls its external API — it never talks to LINE directly.

## Client

`src/notify.js` exports `sendNotify(bot, chatId, messages)`:

```bash
curl -X POST 'https://notice.dvgamerr.app/v1/bots/popcorn/chats/{chat-id}/messages' \
  -H 'X-API-Key: ...' \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"type":"text","text":"Hello"}]}'
```

`messages` is 1-5 raw [LINE message objects](https://developers.line.biz/en/reference/messaging-api/#message-objects) (text, flex, ...); notice-manager forwards them as-is via `/message/push`.

Required env: `NOTIFY_API_KEY` (per-bot API key from notice-manager), `NOTIFY_BASE` (defaults to `https://notice.dvgamerr.app`).

## Cinema digest

`POST /notify/cinema` reads the current week's `s_section = 'showing'` rows from `stash.cinema_showing` (see `docs/cinema-collector.md`), builds a LINE flex carousel per 10 movies (`src/routes/notify/cinema-flex.js`, ported from the old standalone `etl-cinema-scraper`'s `line-flex.js`), and pushes them to the chat in `NOTIFY_CINEMA_CHAT` on the `popcorn` bot. Movies without a poster (`s_cover`) are skipped since the card layout depends on it. A movie only makes the digest if `t_release` falls inside the Monday-Sunday window it's being sent for (`weekWindow()`) — this drops both advance-booking previews Major tags `showing` weeks before they open, and long-running carryovers that opened in an earlier week and are still playing but aren't "this week's" movie.

Cron calls the same endpoint twice a week (see `docs/crontab`, `0 6 * * 1,4`) and the handler tells the runs apart from the server's own day of week (Bangkok time), no query parameter or "already notified" flag involved:

- **Monday** — sends every now-showing movie for the week.
- **Thursday** — sends only movies whose row for this week's `(n_week, n_year)` bucket didn't exist yet on Monday, using `t_created` (migration `011_cinema_created`). That column is set once at insert and is never touched by the upsert's `onConflict.doUpdateSet`, so a movie that was already showing on Monday keeps its Monday timestamp all week, while one first scraped on Tuesday/Wednesday gets a later one — filtering `t_created > mondayOfWeek()` is exactly "added since Monday's send".

```bash
curl -X POST http://localhost:3000/notify/cinema
# Monday:   { "movies": 34, "onlyNew": false, "pushed": 4, "success": true }
# Thursday: { "movies": 3,  "onlyNew": true,  "pushed": 1, "success": true }
```

## Adding another notification

Reuse `sendNotify(bot, chatId, messages)` with a different bot slug/chat id and a message builder of your own; there is no cinema-specific coupling in `src/notify.js`.
