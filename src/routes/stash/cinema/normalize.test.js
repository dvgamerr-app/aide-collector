import { describe, expect, it } from 'bun:test'

import {
  cinemaWeek,
  dedupeCinemaRows,
  fromLegacyPayload,
  mergeCinemaEntries,
  parseMinutes,
  parseRelease,
  slugify,
  toCinemaRow,
} from './normalize'

describe('cinema normalisation', () => {
  it('binds Thai-only titles instead of dropping them', () => {
    expect(slugify('  Girls Like Girls! ')).toBe('girls-like-girls')
    expect(slugify('ผ่าพิภพไททัน การจู่โจมครั้งสุดท้าย')).toBe('ผ่าพิภพไททัน-การจู่โจมครั้งสุดท้าย')
    expect(slugify('***')).toBe('')
  })

  it('parses the listing date formats and rejects unusable values', () => {
    // Bangkok midnight, so the stored day stays 03 Sep regardless of the container timezone.
    expect(parseRelease('03 Sep 2026')).toEqual(new Date('2026-09-02T17:00:00.000Z'))
    expect(parseRelease('2026-09-03')).toEqual(new Date('2026-09-02T17:00:00.000Z'))
    expect(parseRelease('เร็ว ๆ นี้')).toBeNull()
    expect(parseRelease('')).toBeNull()
  })

  it('reads the running time out of padded markup text', () => {
    expect(parseMinutes('95\n   นาที')).toBe(95)
    expect(parseMinutes('150 mins')).toBe(150)
    expect(parseMinutes('01 HR. 35 MINS')).toBe(95)
    expect(parseMinutes('02 ชม. 30 นาที')).toBe(150)
    expect(parseMinutes('digital')).toBe(0)
  })

  it('keeps the week and year aligned across the December boundary', () => {
    expect(cinemaWeek(new Date('2026-09-18T03:00:00Z'))).toEqual({ week: 38, year: 2026 })
    expect(cinemaWeek(new Date('2026-12-31T03:00:00Z'))).toEqual({ week: 1, year: 2027 })
  })
})

describe('cinema merging', () => {
  const major = {
    bind: 'girls-like-girls',
    display: 'Girls Like Girls',
    genre: 'Drama',
    minutes: 95,
    nameEn: 'Girls Like Girls',
    nameTh: '',
    release: new Date('2026-09-02T17:00:00.000Z'),
    section: 'coming',
    theater: { major: { cover: 'major.jpg', url: 'https://major/girls' } },
  }

  it('folds the same movie from both chains into one record', () => {
    const merged = mergeCinemaEntries([
      major,
      {
        bind: 'girls-like-girls',
        display: 'Girls Like Girls',
        genre: '',
        minutes: 0,
        nameEn: 'Girls Like Girls',
        nameTh: 'เกิร์ลส์ ไลค์ เกิร์ลส์',
        release: null,
        section: 'showing',
        theater: { sf: { cover: 'sf.jpg', url: 'https://sf/girls' } },
      },
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      genre: 'Drama',
      minutes: 95,
      nameTh: 'เกิร์ลส์ ไลค์ เกิร์ลส์',
      section: 'showing',
      theater: { major: { url: 'https://major/girls' }, sf: { url: 'https://sf/girls' } },
    })
  })

  it('matches across chains through the title alias when the slugs differ', () => {
    const merged = mergeCinemaEntries([
      major,
      { ...major, bind: 'girls-like-girls-2026', theater: { sf: { cover: 'sf.jpg', url: 'https://sf/girls' } } },
    ])

    expect(merged).toHaveLength(1)
    expect(Object.keys(merged[0].theater)).toEqual(['major', 'sf'])
  })

  it('does not mutate the caller entries while merging', () => {
    mergeCinemaEntries([major, { ...major, theater: { sf: { cover: 'sf.jpg', url: 'https://sf/girls' } } }])
    expect(Object.keys(major.theater)).toEqual(['major'])
  })
})

describe('cinema row mapping', () => {
  const observedAt = new Date('2026-09-18T03:00:00Z')

  it('falls back to the remaining chain when the preferred one has no assets', () => {
    const row = toCinemaRow(
      {
        bind: 'sardar-2',
        display: 'Sardar 2',
        genre: 'Action',
        minutes: 150,
        nameEn: 'Sardar 2',
        nameTh: 'ซาร์ดาร์ 2',
        release: new Date('2026-09-09T17:00:00.000Z'),
        section: 'showing',
        theater: { major: { cover: 'major.jpg', url: 'https://major/sardar' }, sf: { cover: '', url: '' } },
      },
      observedAt,
    )

    expect(row).toMatchObject({
      n_time: 150,
      n_week: 38,
      n_year: 2026,
      s_cover: 'major.jpg',
      s_section: 'showing',
      s_url: 'https://major/sardar',
    })
  })

  it('stores a missing release date as null and mirrors a missing translation', () => {
    const row = toCinemaRow({ bind: 'untitled', display: 'Untitled', release: null, theater: {} }, observedAt)

    expect(row.t_release).toBeNull()
    expect(row.s_name_en).toBe('Untitled')
    expect(row.s_name_th).toBe('Untitled')
    expect(row.s_cover).toBe('')
  })

  it('drops repeated conflict keys that would abort the upsert', () => {
    const rows = [
      { n_time: 1, n_week: 38, n_year: 2026, s_bind: 'a' },
      { n_time: 2, n_week: 38, n_year: 2026, s_bind: 'a' },
      { n_time: 3, n_week: 38, n_year: 2026, s_bind: 'b' },
    ]

    expect(dedupeCinemaRows(rows).map((row) => row.n_time)).toEqual([2, 3])
  })
})

describe('cinema legacy payload', () => {
  it('accepts the shape posted by the standalone scraper', () => {
    expect(
      fromLegacyPayload([
        {
          bind: 'girls-like-girls',
          display: 'Girls Like Girls',
          genre: 'Drama',
          name: 'girls-like-girls',
          name_en: 'Girls Like Girls',
          name_th: 'เกิร์ลส์',
          release: '2026-09-03',
          theater: { major: { cover: 'c.jpg', url: 'u' } },
          timeMin: '95',
        },
        { display: '', name: '***' },
      ]),
    ).toEqual([
      {
        bind: 'girls-like-girls',
        display: 'Girls Like Girls',
        genre: 'Drama',
        minutes: 95,
        nameEn: 'Girls Like Girls',
        nameTh: 'เกิร์ลส์',
        release: new Date('2026-09-02T17:00:00.000Z'),
        section: 'showing',
        theater: { major: { cover: 'c.jpg', url: 'u' } },
      },
    ])
  })
})
