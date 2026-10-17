import { sql } from 'kysely'

const YAHOO = (ccy) => `https://query1.finance.yahoo.com/v8/finance/chart/USD${ccy}=X?interval=1d&range=1d`
const MAX_SYMBOLS = 20

/** Units of `ccy` per one US dollar from a Yahoo chart payload, or null when the symbol is unknown. */
export const parseYahooRate = (payload) => {
  const price = Number(payload?.chart?.result?.[0]?.meta?.regularMarketPrice)
  return Number.isFinite(price) && price > 0 ? price : null
}

export const parseSymbols = (raw) => {
  const symbols = String(raw ?? '')
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean)
  const bad = symbols.find((symbol) => !/^[A-Z]{3}$/.test(symbol) || symbol === 'USD')
  if (bad) throw Object.assign(new Error(`Invalid currency '${bad}'; use ISO 4217 codes other than USD, e.g. JPY,EUR`), { status: 400 })
  return symbols
}

const fetchRate = async (ccy) => {
  const response = await fetch(YAHOO(ccy), { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } })
  if (!response.ok) throw new Error(`Yahoo ${ccy} HTTP ${response.status}`)
  const rate = parseYahooRate(await response.json())
  if (rate === null) throw new Error(`Yahoo ${ccy}: no regularMarketPrice`)
  return rate
}

/** Refreshes THB, every currency already stored and the ones asked for in `symbols`. */
export const currency = async ({ db, logger, query }) => {
  const requested = parseSymbols(query?.symbols)
  const stored = await db.selectFrom('stash.exchange_rate').select('ccy').execute()
  const symbols = [...new Set(['THB', ...stored.map((row) => row.ccy), ...requested])].slice(0, MAX_SYMBOLS)

  const results = await Promise.allSettled(symbols.map(fetchRate))
  const updated = {}
  const failed = {}
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') updated[symbols[index]] = result.value
    else failed[symbols[index]] = result.reason.message
  }

  const rows = Object.entries(updated).map(([ccy, per_usd]) => ({ ccy, per_usd: String(per_usd), updated_at: sql`now()` }))
  if (rows.length)
    await db
      .insertInto('stash.exchange_rate')
      .values(rows)
      .onConflict((oc) =>
        oc.column('ccy').doUpdateSet((eb) => ({ per_usd: eb.ref('excluded.per_usd'), updated_at: eb.ref('excluded.updated_at') })),
      )
      .execute()

  if (Object.keys(failed).length) logger.warn({ failed }, 'Some exchange rates could not be fetched')
  const success = rows.length > 0
  return Response.json({ failed, success, updated }, { status: success ? 200 : 502 })
}
