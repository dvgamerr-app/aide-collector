import { sql } from 'kysely'
import { randomUUID } from 'node:crypto'

import { AdGuard, ontBase, OntSession, pollInterval, sourceId } from './client'
import { storeSnapshot } from './storage'

const ont = new OntSession()
const adguard = new AdGuard()
let running = false
let stopping = false
let retryAt = 0
let failures = 0

export const closeOnt = async () => {
  stopping = true
  await ont.close()
}

const failure = (error, status) => Response.json({ error, success: false }, { status })

/** One synchronous collection per HTTP request; scheduling belongs to cron. */
export const collectOnt = async ({ db, logger }) => {
  if (stopping) return failure('Collector is shutting down', 503)
  if (!Bun.env.ONT_PASS) return failure('ONT_PASS is required', 503)
  if (running) return failure('ONT collection already running', 409)
  if (Date.now() < retryAt)
    return Response.json(
      { error: 'ONT retry backoff', retry_at: new Date(retryAt).toISOString(), success: false },
      { headers: { 'Retry-After': String(Math.ceil((retryAt - Date.now()) / 1000)) }, status: 429 },
    )
  running = true
  const started = performance.now()
  try {
    const source = sourceId()
    const interval = pollInterval()
    const result = await db.transaction().execute(async (transaction) => {
      // Lock by ONT origin, not label: another worker must not log in concurrently.
      const { rows } = await sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`ont:${ontBase()}`}, 0)) AS acquired`.execute(
        transaction,
      )
      if (!rows[0].acquired) return failure('ONT collection already running', 409)
      const latest = await transaction
        .selectFrom('stash.ont_collections')
        .select(['id', 'recorded_at'])
        .where('source', '=', source)
        .orderBy('recorded_at', 'desc')
        .limit(1)
        .executeTakeFirst()
      if (latest && Date.now() - +new Date(latest.recorded_at) < interval)
        return Response.json({ collection_id: latest.id, reason: 'minimum interval', skipped: true, success: true })

      const before = ont.requests
      let hosts
      try {
        hosts = await ont.read()
      } catch (error) {
        retryAt = Date.now() + Math.min(900000, interval * 2 ** Math.min(++failures, 10))
        logger.warn({ error: error.message }, 'ONT upstream unavailable')
        return failure(error.message, 502)
      }
      failures = 0
      retryAt = 0
      const recorded_at = new Date()
      const ag = await adguard.read(logger)
      if (stopping) return failure('Collector is shutting down', 503)
      const collection = { adguard_status: ag.status, host_count: hosts.length, id: randomUUID(), recorded_at, source }
      await storeSnapshot(transaction, hosts, ag, collection)
      return Response.json({
        ...collection,
        elapsed_ms: Math.round(performance.now() - started),
        ont_requests: ont.requests - before,
        skipped: false,
        success: true,
      })
    })
    logger.info({ elapsed_ms: Math.round(performance.now() - started), status: result.status }, 'ONT collection finished')
    return result
  } catch (error) {
    logger.error({ error: error.message }, 'ONT collection failed')
    return failure('ONT collection failed; check server logs', 500)
  } finally {
    running = false
  }
}
