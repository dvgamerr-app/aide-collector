import { describe, expect, it } from 'bun:test'

import { mapDrawValues } from './lottery'

const draw = (firstPrize) => ({
  prizes: {
    1: [firstPrize],
    6: ['333', '444'],
    7: ['55'],
    10: ['111', '222'],
  },
  str: '2026-08-01',
})

describe('mapDrawValues', () => {
  it('maps a batch and keeps the final value for a duplicate draw date', () => {
    expect(mapDrawValues([draw('123456'), draw('654321')])).toEqual([
      {
        back_three: ['111', '222'],
        back_two: ['55'],
        draw: '2026-08-01',
        first_prize: '654321',
        front_three: ['333', '444'],
      },
    ])
  })
})
