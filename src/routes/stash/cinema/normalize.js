import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'
import weekOfYear from 'dayjs/plugin/weekOfYear'

dayjs.extend(customParseFormat)
dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(weekOfYear)

export const TIMEZONE = 'Asia/Bangkok'

const BIND_LIMIT = 200
const GENRE_LIMIT = 120
const HOUR_MARKER = /\bhrs?\b|hour|\u0E0A\u0E21/i
const RELEASE_FORMATS = ['DD MMM YYYY', 'D MMM YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY']
const THEATER_PRIORITY = ['sf', 'major']

/** Collapse the whitespace that server-rendered cinema markup pads every node with. */
export const collapse = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()

/** Slug used to bind the same movie across theater chains. Thai letters are kept so Thai-only titles survive. */
export const slugify = (value) =>
  collapse(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u0e00-\u0e7f]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BIND_LIMIT)

/**
 * Release dates are published without a zone; anchor them to Bangkok so the stored day never shifts.
 * dayjs.tz() mis-parses when handed an array of formats, so each format is matched on its own.
 */
export const parseRelease = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value

  const text = collapse(value)
  if (!text) return null

  for (const format of RELEASE_FORMATS) {
    if (dayjs(text, format, true).isValid()) return dayjs.tz(text, format, TIMEZONE).toDate()
  }

  const loose = dayjs.tz(text, TIMEZONE)
  return loose.isValid() ? loose.toDate() : null
}

/** Handles both the flat '95 mins' badge and the hover card's '01 HR. 35 MINS' / '01 ชม. 35 นาที'. */
export const parseMinutes = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0

  const text = collapse(value)
  const numbers = (text.match(/\d+/g) || []).map(Number)
  if (!numbers.length) return 0

  return HOUR_MARKER.test(text) ? numbers[0] * 60 + (numbers[1] || 0) : numbers[0]
}

/**
 * Week bucket a collection run belongs to, in Bangkok time.
 * `weekOfYear` restarts at 1 inside late December, so the calendar year has to follow the week.
 */
export const cinemaWeek = (value = new Date()) => {
  const local = dayjs(value).tz(TIMEZONE)
  const week = local.week()
  const month = local.month()
  if (week === 1 && month === 11) return { week, year: local.year() + 1 }
  if (week >= 52 && month === 0) return { week, year: local.year() - 1 }
  return { week, year: local.year() }
}

export const cinemaAliases = (entry) => {
  const aliases = [entry.bind, slugify(entry.nameEn), slugify(entry.nameTh), slugify(entry.display)]
  return [...new Set(aliases)].filter(Boolean)
}

/**
 * Fold entries coming from several theater chains into one record per movie.
 * Single pass over the input with an alias index, so re-scraping stays linear instead of quadratic.
 */
export const mergeCinemaEntries = (entries) => {
  const index = new Map()
  const merged = []

  for (const entry of entries || []) {
    if (!entry?.bind) continue

    const aliases = cinemaAliases(entry)
    const target = aliases.reduce((found, alias) => found || index.get(alias), null)

    if (!target) {
      const record = { ...entry, theater: { ...entry.theater } }
      merged.push(record)
      for (const alias of aliases) index.set(alias, record)
      continue
    }

    target.theater = { ...target.theater, ...entry.theater }
    target.display ||= entry.display
    target.genre ||= entry.genre
    target.minutes ||= entry.minutes
    target.nameEn ||= entry.nameEn
    target.nameTh ||= entry.nameTh
    target.release ||= entry.release
    if (entry.section === 'showing') target.section = 'showing'
    for (const alias of aliases) if (!index.has(alias)) index.set(alias, target)
  }

  return merged
}

const theaterAsset = (theater, key) => {
  for (const source of THEATER_PRIORITY) {
    if (theater?.[source]?.[key]) return theater[source][key]
  }
  for (const value of Object.values(theater || {})) {
    if (value?.[key]) return value[key]
  }
  return ''
}

export const toCinemaRow = (entry, observedAt = new Date()) => {
  const { week, year } = cinemaWeek(observedAt)
  const display = collapse(entry.display) || collapse(entry.nameEn) || collapse(entry.nameTh)
  const theater = entry.theater || {}

  return {
    n_time: parseMinutes(entry.minutes),
    n_week: week,
    n_year: year,
    o_theater: theater,
    s_bind: entry.bind,
    s_cover: theaterAsset(theater, 'cover'),
    s_display: display,
    s_genre: collapse(entry.genre).slice(0, GENRE_LIMIT),
    s_name_en: collapse(entry.nameEn) || display,
    s_name_th: collapse(entry.nameTh) || display,
    s_section: entry.section === 'coming' ? 'coming' : 'showing',
    s_url: theaterAsset(theater, 'url'),
    t_release: entry.release ?? null,
  }
}

/** Rows are keyed by (s_bind, n_week, n_year); a repeated key in one statement aborts the whole upsert. */
export const dedupeCinemaRows = (rows) => [
  ...new Map(rows.map((row) => [`${row.s_bind}\u0000${row.n_week}\u0000${row.n_year}`, row])).values(),
]

/** Accepts the payload shape posted by the standalone etl-cinema-scraper. */
export const fromLegacyPayload = (items) =>
  (items || [])
    .map((item) => {
      const display = collapse(item?.display) || collapse(item?.name_en) || collapse(item?.name_th) || collapse(item?.name)
      const bind = slugify(item?.bind) || slugify(item?.name) || slugify(display)
      if (!bind) return null

      return {
        bind,
        display,
        genre: collapse(item?.genre),
        minutes: parseMinutes(item?.time ?? item?.timeMin),
        nameEn: collapse(item?.name_en),
        nameTh: collapse(item?.name_th),
        release: parseRelease(item?.release),
        section: item?.section === 'coming' ? 'coming' : 'showing',
        theater: item?.theater || {},
      }
    })
    .filter(Boolean)
