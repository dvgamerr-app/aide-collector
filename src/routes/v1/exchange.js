import { ApiError } from './http'

const MAX_CURRENCIES = 10
const CODE = /^[A-Z]{3}$/

const parseCodes = (raw, fallback) => {
  const codes = String(raw || fallback)
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean)
  if (!codes.length || codes.length > MAX_CURRENCIES || codes.some((code) => !CODE.test(code)))
    throw new ApiError(400, 'Invalid currency', `Use 1-${MAX_CURRENCIES} comma separated ISO 4217 codes`)
  return [...new Set(codes)]
}

/** Units of `quote` for one `ccy`; both are stored per USD and USD itself is always 1. */
export const crossRate = (perUsd, ccy, quote) => perUsd.get(quote) / perUsd.get(ccy)

const round = (value) => Math.round(value * 10000) / 10000

export const exchangeRates = async ({ db, query }) => {
  const currencies = parseCodes(query.ccy, 'USD')
  const quote = parseCodes(query.quote, 'THB')[0]

  const rows = await db.selectFrom('stash.exchange_rate').select(['ccy', 'per_usd', 'updated_at']).execute()
  if (!rows.length) throw new ApiError(503, 'No exchange rates yet', 'The currency collector has not run yet')

  const perUsd = new Map([['USD', 1], ...rows.map((row) => [row.ccy, Number(row.per_usd)])])
  const updated = new Map(rows.map((row) => [row.ccy, row.updated_at]))
  const missing = [...new Set([quote, ...currencies])].filter((ccy) => !perUsd.has(ccy))
  if (missing.length)
    throw new ApiError(
      404,
      'Currency not collected',
      `No rate for ${missing.join(', ')}; collect it with PATCH /stash/currency?symbols=${missing.join(',')}`,
    )

  const stamp = (ccy) => updated.get(ccy) ?? updated.get(quote)
  return {
    items: currencies.map((ccy) => {
      // Yahoo publishes a single price, so buy and sell are the same number.
      const rate = round(crossRate(perUsd, ccy, quote))
      return { buy: rate, ccy, sell: rate, updatedAt: new Date(Math.min(+new Date(stamp(ccy)), +new Date(stamp(quote)))).toISOString() }
    }),
    quote,
  }
}
