import { describe, expect, test } from 'bun:test'

import { parseSymbols, parseYahooRate } from '../stash/currency'
import { crossRate, exchangeRates } from './exchange'
import { ApiError } from './http'

const fakeDb = (rows) => ({ selectFrom: () => ({ select: () => ({ execute: async () => rows }) }) })
const rows = [
  { ccy: 'THB', per_usd: '33.5', updated_at: new Date('2026-10-17T05:00:00Z') },
  { ccy: 'JPY', per_usd: '150', updated_at: new Date('2026-10-17T04:00:00Z') },
]

describe('crossRate', () => {
  test('prices one unit of ccy in the quote currency', () => {
    const perUsd = new Map([
      ['JPY', 150],
      ['THB', 33.5],
      ['USD', 1],
    ])
    expect(crossRate(perUsd, 'USD', 'THB')).toBe(33.5)
    expect(crossRate(perUsd, 'JPY', 'THB')).toBeCloseTo(0.22333, 4)
    expect(crossRate(perUsd, 'THB', 'THB')).toBe(1)
  })
})

describe('exchangeRates', () => {
  test('defaults to USD in THB with buy equal to sell', async () => {
    const result = await exchangeRates({ db: fakeDb(rows), query: {} })
    expect(result).toEqual({ items: [{ buy: 33.5, ccy: 'USD', sell: 33.5, updatedAt: '2026-10-17T05:00:00.000Z' }], quote: 'THB' })
  })

  test('cross-converts other currencies and reports the oldest source timestamp', async () => {
    const { items } = await exchangeRates({ db: fakeDb(rows), query: { ccy: 'jpy,usd', quote: 'THB' } })
    expect(items.map((item) => item.ccy)).toEqual(['JPY', 'USD'])
    expect(items[0]).toMatchObject({ buy: 0.2233, updatedAt: '2026-10-17T04:00:00.000Z' })
  })

  test('answers 404 with a collector hint for a currency that was never collected', async () => {
    const error = await exchangeRates({ db: fakeDb(rows), query: { ccy: 'EUR' } }).catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(404)
    expect(error.message).toContain('PATCH /stash/currency?symbols=EUR')
  })

  test('answers 503 before the first collection and 400 for malformed codes', async () => {
    expect((await exchangeRates({ db: fakeDb([]), query: {} }).catch((e) => e)).status).toBe(503)
    expect((await exchangeRates({ db: fakeDb(rows), query: { ccy: 'US' } }).catch((e) => e)).status).toBe(400)
    expect(
      (
        await exchangeRates({
          db: fakeDb(rows),
          query: { ccy: Array.from({ length: 11 }, (_, i) => `A${'ABCDEFGHIJK'[i]}Z`).join(',') },
        }).catch((e) => e)
      ).status,
    ).toBe(400)
  })
})

describe('currency collector helpers', () => {
  test('reads units per USD from the Yahoo chart payload', () => {
    expect(parseYahooRate({ chart: { result: [{ meta: { regularMarketPrice: 33.44 } }] } })).toBe(33.44)
    expect(parseYahooRate({ chart: { result: [{ meta: {} }] } })).toBeNull()
    expect(parseYahooRate({ chart: { result: null } })).toBeNull()
    expect(parseYahooRate(null)).toBeNull()
  })

  test('parses and validates symbols', () => {
    expect(parseSymbols(' jpy, eur ,')).toEqual(['JPY', 'EUR'])
    expect(parseSymbols(undefined)).toEqual([])
    expect(() => parseSymbols('JPY,USD')).toThrow('Invalid currency')
    expect(() => parseSymbols('euro')).toThrow('Invalid currency')
  })
})
