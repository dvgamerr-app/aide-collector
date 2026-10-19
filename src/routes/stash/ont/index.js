import { sql } from 'kysely'
import { randomUUID } from 'node:crypto'

import { AdGuard, backoff, ontBase, OntSession, pollInterval, sourceId } from './client'
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

const SHUTTING_DOWN = 'Collector is shutting down'
const ALREADY_RUNNING = 'ONT collection already running'

/** Why this request cannot start a collection right now, or null when it can. */
const refusal = () => {
  if (stopping) return failure(SHUTTING_DOWN, 503)
  if (!Bun.env.ONT_PASS) return failure('ONT_PASS is required', 503)
  if (running) return failure(ALREADY_RUNNING, 409)
  if (Date.now() >= retryAt) return null
  return Response.json(
    { error: 'ONT retry backoff', retry_at: new Date(retryAt).toISOString(), success: false },
    { headers: { 'Retry-After': String(Math.ceil((retryAt - Date.now()) / 1000)) }, status: 429 },
  )
}

const latestCollection = (transaction, source) =>
  transaction
    .selectFrom('stash.ont_collections')
    .select(['id', 'recorded_at'])
    .where('source', '=', source)
    .orderBy('recorded_at', 'desc')
    .limit(1)
    .executeTakeFirst()

const readHosts = async (logger) => {
  try {
    const hosts = await ont.read(logger)
    failures = 0
    retryAt = 0
    return { hosts }
  } catch (error) {
    retryAt = Date.now() + backoff(++failures)
    logger.warn({ error: error.message }, 'ONT upstream unavailable')
    return { error: error?.message ?? String(error) }
  }
}

const collect = async (transaction, logger, started) => {
  const source = sourceId()
  // Lock by ONT origin, not label: another worker must not log in concurrently.
  const { rows } = await sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`ont:${ontBase()}`}, 0)) AS acquired`.execute(transaction)
  if (!rows[0].acquired) return failure(ALREADY_RUNNING, 409)

  const latest = await latestCollection(transaction, source)
  if (latest && Date.now() - +new Date(latest.recorded_at) < pollInterval())
    return Response.json({ collection_id: latest.id, reason: 'minimum interval', skipped: true, success: true })

  const before = ont.requests
  const { error, hosts } = await readHosts(logger)
  if (error !== undefined) return failure(error, 502)

  const recorded_at = new Date()
  const ag = await adguard.read(logger)
  if (stopping) return failure(SHUTTING_DOWN, 503)

  const collection = { adguard_status: ag.status, host_count: hosts.length, id: randomUUID(), recorded_at, source }
  await storeSnapshot(transaction, hosts, ag, collection)
  return Response.json({
    ...collection,
    elapsed_ms: Math.round(performance.now() - started),
    ont_requests: ont.requests - before,
    skipped: false,
    success: true,
  })
}

/** One synchronous collection per HTTP request; scheduling belongs to cron. */
export const collectOnt = async ({ db, logger }) => {
  const refused = refusal()
  if (refused) return refused

  running = true
  const started = performance.now()
  try {
    const result = await db.transaction().execute((transaction) => collect(transaction, logger, started))
    logger.info({ elapsed_ms: Math.round(performance.now() - started), status: result.status }, 'ONT collection finished')
    return result
  } catch (error) {
    logger.error({ error: error.message }, 'ONT collection failed')
    return failure('ONT collection failed; check server logs', 500)
  } finally {
    running = false
  }
}
