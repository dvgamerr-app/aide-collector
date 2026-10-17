import { describe, expect, test } from 'bun:test'

import { ApiError } from './http'
import { eachDay, parseRange } from './range'

const NOW = new Date('2026-10-17T20:00:00Z') // already 2026-10-18 in Bangkok

describe('parseRange', () => {
  test('defaults to the 365 Bangkok days ending today', () => {
    const range = parseRange({}, NOW)
    expect(range.to).toBe('2026-10-18')
    expect(range.from).toBe('2025-10-19')
    expect(range.days).toBe(365)
    expect(range.start.toISOString()).toBe('2025-10-18T17:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-10-18T17:00:00.000Z')
  })

  test('treats to as inclusive', () => {
    const range = parseRange({ from: '2026-09-01', to: '2026-09-30' }, NOW)
    expect(range.days).toBe(30)
    expect(range.end.toISOString()).toBe('2026-09-30T17:00:00.000Z')
  })

  test.each(['2026-13-01', '2026-02-30', '26-01-01', 'yesterday'])('rejects %s', (from) => {
    expect(() => parseRange({ from }, NOW)).toThrow(ApiError)
  })

  test('rejects an inverted or oversized range', () => {
    expect(() => parseRange({ from: '2026-10-02', to: '2026-10-01' }, NOW)).toThrow('from must not be after to')
    expect(() => parseRange({ from: '2000-01-01' }, NOW)).toThrow('at most 5 years')
  })
})

describe('eachDay', () => {
  test('lists every day inclusive, across a month end', () => {
    expect(eachDay('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02'])
  })
})
