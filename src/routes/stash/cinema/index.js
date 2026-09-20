import { collectMajor } from './major'
import { dedupeCinemaRows, fromLegacyPayload, mergeCinemaEntries, toCinemaRow } from './normalize'
import { CinemaChallengeError, collectSf } from './sf'
import { storeCinemaShowings } from './storage'

const PROVIDERS = [
  { collect: collectMajor, name: 'major' },
  { collect: collectSf, name: 'sf' },
]

const runProvider = async ({ collect, name }) => {
  try {
    const entries = await collect()
    return { entries, movies: entries.length, ok: true, source: name }
  } catch (error) {
    const blocked = error instanceof CinemaChallengeError
    return { blocked, entries: [], error: error.message, movies: 0, ok: false, source: name }
  }
}

const persist = async (db, entries, observedAt) => {
  const rows = dedupeCinemaRows(mergeCinemaEntries(entries).map((entry) => toCinemaRow(entry, observedAt)))
  if (!rows.length) return { removed: 0, rows: 0, stored: 0 }

  const { removed, stored } = await storeCinemaShowings(db, rows)
  return { removed, rows: rows.length, stored }
}

export const cinema = async ({ db, logger }) => {
  const observedAt = new Date()

  try {
    const results = await Promise.all(PROVIDERS.map(runProvider))
    const entries = results.flatMap((result) => result.entries)

    const failed = results.filter((result) => !result.ok)
    for (const result of failed) {
      logger[result.blocked ? 'warn' : 'error']({ error: result.error, source: result.source }, 'cinema source unavailable')
    }

    if (!entries.length) {
      const reason = failed.map((result) => `${result.source}: ${result.error}`).join('; ') || 'no movies returned'
      return Response.json({ error: reason, success: false }, { status: 502 })
    }

    const { removed, rows, stored } = await persist(db, entries, observedAt)
    const sources = Object.fromEntries(
      results.map((result) => [result.source, result.ok ? { movies: result.movies, ok: true } : { error: result.error, ok: false }]),
    )

    logger.info({ removed, rows, sources, stored }, 'cinema collected')
    return Response.json({ merged: rows, removed, sources, stored, success: true })
  } catch (error) {
    logger.error({ error: error.message }, 'Error collecting cinema')
    return Response.json({ error: error.message, success: false }, { status: 500 })
  }
}

/** Ingest endpoint kept for the standalone scraper that posts already-scraped batches. */
export const cinemaIngest = async ({ body, db, logger }) => {
  try {
    const entries = fromLegacyPayload(body)
    if (!entries.length) return Response.json({ merged: 0, removed: 0, stored: 0, success: true })

    const { removed, rows, stored } = await persist(db, entries, new Date())
    logger.info({ received: body?.length ?? 0, removed, rows, stored }, 'cinema ingested')

    return Response.json({ merged: rows, removed, stored, success: true })
  } catch (error) {
    logger.error({ error: error.message }, 'Error ingesting cinema')
    return Response.json({ error: error.message, success: false }, { status: 500 })
  }
}
