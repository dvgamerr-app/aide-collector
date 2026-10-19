import { mapPool } from '../../../concurrency'
import { parseSeatPlan, parseShowtimes, parseTheaters } from './booking-parse'
import { collapse, MAJOR_ORIGIN, slugify } from './normalize'
import { fetchWithRetry } from './request'
import { majorHeaders, majorSession } from './session'

// Seat plans are fetched one at a time so a lookup never puts concurrent load on Major.
const SEAT_CONCURRENCY = 1
const THEATER_CACHE_MS = 24 * 3600e3

const BRANCH_URL = `${MAJOR_ORIGIN}/home/cinema_bar/all`
const SEAT_URL = (showtime) => `${MAJOR_ORIGIN}/booking2/get_seat/${showtime}/`
const SHOWTIME_URL = `${MAJOR_ORIGIN}/booking2/get_showtime/`

const branchList = async (lang) => {
  const cookie = await majorSession(lang)
  const response = await fetchWithRetry(BRANCH_URL, { headers: majorHeaders(cookie) })
  if (!response.ok) throw new Error(`major branch list failed: HTTP ${response.status}`)

  return parseTheaters(await response.text())
}

let theaterCache = { expires: 0, value: null }

/** Both languages are loaded so a branch can be looked up by its Thai or English name. */
export const fetchTheaters = async () => {
  if (theaterCache.value && theaterCache.expires > Date.now()) return theaterCache.value

  const [english, thai] = await Promise.all([branchList('en'), branchList('th')])
  if (!english.length) throw new Error('major branch list returned no theaters')

  const thaiById = new Map(thai.map((theater) => [theater.id, theater]))
  const theaters = english.map((theater) => {
    const local = thaiById.get(theater.id)
    return { ...theater, nameTh: local?.name || theater.name, slugTh: local?.slug || theater.slug, zoneTh: local?.zone || theater.zone }
  })

  theaterCache = { expires: Date.now() + THEATER_CACHE_MS, value: theaters }
  return theaters
}

const lower = (value) => value.toLowerCase()

// Branch names are written inconsistently ('เมกาบางนา' vs a searched 'เมกา บางนา'), so separators are dropped.
const compact = (value) => slugify(value).replaceAll('-', '')

const NO_MATCH = Number.POSITIVE_INFINITY

// Ordered from strongest to weakest; a theater's rank is the index of the first test it passes.
const RANK_TESTS = [
  ({ aliases, names }, { lowered, slug }) => aliases.includes(slug) || names.includes(lowered),
  ({ aliases, names }, { lowered, slug }) =>
    aliases.some((alias) => alias.startsWith(slug)) || names.some((name) => name.startsWith(lowered)),
  ({ aliases, names }, { lowered, slug }) => aliases.some((alias) => alias.includes(slug)) || names.some((name) => name.includes(lowered)),
  ({ shrunkNames }, { shrunk }) => shrunkNames.some((name) => name.startsWith(shrunk)),
  ({ shrunkNames }, { shrunk }) => shrunkNames.some((name) => name.includes(shrunk)),
  // Last resort: every word of the reference appears somewhere in the name ('imax paragon').
  ({ aliases }, { words }) => words.length > 1 && aliases.some((alias) => words.every((word) => alias.includes(word))),
]

// Keyed by the theater object, so the cached branch list derives its match keys once per cache period.
const matchKeys = new WeakMap()

const theaterKeys = (theater) => {
  if (!matchKeys.has(theater)) {
    const names = [theater.name, theater.nameTh]
    matchKeys.set(theater, { aliases: [theater.slug, theater.slugTh], names: names.map(lower), shrunkNames: names.map(compact) })
  }
  return matchKeys.get(theater)
}

const theaterRank = (theater, parts) => {
  const keys = theaterKeys(theater)
  const rank = RANK_TESTS.findIndex((test) => test(keys, parts))
  return rank === -1 ? NO_MATCH : rank
}

/**
 * Match a numeric branch id, an exact slug, or a partial name in either language.
 * Major does not return the branches in a stable order, so candidates are ranked
 * exact > prefix > substring and then by the shortest name: 'พารากอน' has to resolve to
 * 'พารากอน ซีนีเพล็กซ์', not to 'ไอแมกซ์ เลเซอร์ พารากอน ซีนีเพล็กซ์'.
 */
export const matchTheater = (theaters, reference) => {
  const wanted = collapse(reference)
  if (!wanted) return null
  if (/^\d+$/.test(wanted)) return theaters.find((theater) => theater.id === wanted) || null

  const slug = slugify(wanted)
  const shrunk = compact(wanted)

  // A reference that slugifies to nothing must not reach the substring passes,
  // where every branch would match the empty needle.
  if (!slug || !shrunk) return null

  const parts = { lowered: lower(wanted), shrunk, slug, words: slug.split('-').filter(Boolean) }
  let best = null
  let bestRank = NO_MATCH
  let bestLength = NO_MATCH

  for (const theater of theaters) {
    const rank = theaterRank(theater, parts)
    if (rank === NO_MATCH) continue

    const length = theater.name.length + theater.nameTh.length
    if (rank < bestRank || (rank === bestRank && length < bestLength)) {
      best = theater
      bestRank = rank
      bestLength = length
    }
  }

  return best
}

export const resolveTheater = async (reference) => matchTheater(await fetchTheaters(), reference)

const showtimeList = async ({ date, lang, theaterId }) => {
  const cookie = await majorSession(lang)
  const body = new URLSearchParams({
    cinema_text: theaterId,
    date_link: date,
    flag_special_cinema: 'normal',
    flag_type_showtime: 'one_cinema',
    movie_text: '',
  })

  const response = await fetchWithRetry(SHOWTIME_URL, {
    body,
    headers: majorHeaders(cookie, { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }),
    method: 'POST',
  })
  if (!response.ok) throw new Error(`major showtime lookup failed: HTTP ${response.status}`)

  return parseShowtimes(await response.text())
}

/** Both languages are read in parallel so a movie can be asked for by its Thai or English title. */
export const fetchShowtimes = async ({ date, theaterId }) => {
  const [english, thai] = await Promise.all([showtimeList({ date, lang: 'en', theaterId }), showtimeList({ date, lang: 'th', theaterId })])

  const thaiById = new Map(thai.filter((entry) => entry.showtime).map((entry) => [entry.showtime, entry]))

  return english.map((entry) => {
    const local = entry.showtime ? thaiById.get(entry.showtime) : null
    return {
      ...entry,
      hall: { ...entry.hall, nameTh: local?.hall?.name || entry.hall.name },
      movie: { ...entry.movie, genreTh: local?.movie?.genre || entry.movie.genre, titleTh: local?.movie?.title || entry.movie.title },
    }
  })
}

export const fetchSeats = async (showtime) => {
  const id = String(showtime).replace(/\D/g, '')
  if (!id) throw new Error('showtime id must be numeric')

  const cookie = await majorSession('en')
  const response = await fetchWithRetry(SEAT_URL(id), { headers: majorHeaders(cookie) })
  if (!response.ok) throw new Error(`major seat plan failed: HTTP ${response.status}`)

  return parseSeatPlan(await response.text())
}

export const attachSeats = (showtimes, detail) =>
  mapPool(showtimes, SEAT_CONCURRENCY, async (entry) => {
    if (entry.past || !entry.showtime) return { ...entry, seats: null }

    try {
      const plan = await fetchSeats(entry.showtime)
      if (!plan) return { ...entry, seats: null }

      const { rows, ...summary } = plan
      return { ...entry, seats: detail ? { ...summary, rows } : summary }
    } catch (error) {
      return { ...entry, seats: null, seatsError: error.message }
    }
  })
