import { describe, expect, it } from 'bun:test'

import { getSolarStatusTransition } from '.'

const NOW = new Date('2026-07-25T12:00:00.000Z').getTime()

describe('getSolarStatusTransition', () => {
  it('marks a record exactly 15 minutes old offline', () => {
    const recordAt = new Date(NOW - 15 * 60 * 1000)

    expect(getSolarStatusTransition(recordAt, 'online', NOW)).toEqual({
      shouldNotify: true,
      status: 'offline',
    })
  })

  it('alerts offline once when the latest record is older than 15 minutes', () => {
    const recordAt = new Date(NOW - 15 * 60 * 1000 - 1)

    expect(getSolarStatusTransition(recordAt, 'online', NOW)).toEqual({
      shouldNotify: true,
      status: 'offline',
    })
    expect(getSolarStatusTransition(recordAt, 'offline', NOW)).toEqual({
      shouldNotify: false,
      status: 'offline',
    })
  })

  it('alerts online only when recovering from offline', () => {
    const recordAt = new Date(NOW)

    expect(getSolarStatusTransition(recordAt, 'offline', NOW)).toEqual({
      shouldNotify: true,
      status: 'online',
    })
    expect(getSolarStatusTransition(recordAt, undefined, NOW)).toEqual({
      shouldNotify: false,
      status: 'online',
    })
  })

  it('treats a missing record as offline', () => {
    expect(getSolarStatusTransition(null, undefined, NOW)).toEqual({
      shouldNotify: true,
      status: 'offline',
    })
  })
})
