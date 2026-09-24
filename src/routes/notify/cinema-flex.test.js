import { describe, expect, it } from 'bun:test'

import { buildCinemaFlex } from './cinema-flex'

const movie = (overrides = {}) => ({
  n_time: 118,
  o_theater: ['major', 'sf'],
  s_cover: 'https://example.test/cover.jpg',
  s_display: 'Some Movie: Part Two',
  t_release: '2026-09-18',
  ...overrides,
})

describe('buildCinemaFlex', () => {
  it('builds one flex carousel with a bubble per movie when under the bubble limit', () => {
    const [message] = buildCinemaFlex([movie(), movie({ s_display: 'Another Movie' })], 'weekly digest')

    expect(message.type).toBe('flex')
    expect(message.altText).toBe('weekly digest')
    expect(message.contents.type).toBe('carousel')
    expect(message.contents.contents).toHaveLength(2)
    expect(message.contents.contents[0].type).toBe('bubble')
  })

  it('splits more than 10 movies into multiple carousels with numbered altText', () => {
    const movies = Array.from({ length: 12 }, (_, index) => movie({ s_display: `Movie ${index}` }))
    const messages = buildCinemaFlex(movies, 'weekly digest')

    expect(messages).toHaveLength(2)
    expect(messages[0].contents.contents).toHaveLength(10)
    expect(messages[1].contents.contents).toHaveLength(2)
    expect(messages[0].altText).toBe('weekly digest [1/2]')
    expect(messages[1].altText).toBe('weekly digest [2/2]')
  })

  it('only badges theaters the movie actually screens at', () => {
    const [message] = buildCinemaFlex([movie({ o_theater: ['sf'] })], 'weekly digest')
    const poster = message.contents.contents[0].body.contents[0]

    expect(poster.contents).toHaveLength(2)
    expect(poster.contents[1].contents[0].text).toBe('SF Cinema')
  })

  it('falls back to a placeholder release label when unreleased', () => {
    const [message] = buildCinemaFlex([movie({ t_release: null })], 'weekly digest')
    const info = message.contents.contents[0].body.contents[1]

    expect(info.contents[1].text).toBe('เร็วๆ นี้')
  })
})
