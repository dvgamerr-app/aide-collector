import { collapse, slugify } from './normalize'
import { fetchWithRetry, mapPool } from './request'
import { MAJOR_ORIGIN, majorHeaders, majorSession } from './session'

// Seat plans are fetched one at a time so a lookup never puts concurrent load on Major.
const SEAT_CONCURRENCY = 1
const THEATER_CACHE_MS = 24 * 3600e3

const BRANCH_URL = `${MAJOR_ORIGIN}/home/cinema_bar/all`
const SEAT_URL = (showtime) => `${MAJOR_ORIGIN}/booking2/get_seat/${showtime}/`
const SHOWTIME_URL = `${MAJOR_ORIGIN}/booking2/get_showtime/`

// Vista marks a bookable seat with status 0; anything else is sold, held, broken or a house seat.
const SEAT_AVAILABLE = 0

const textSink = (assign) => {
  const state = { active: false, buffer: '' }
  return {
    element(element) {
      state.active = true
      state.buffer = ''
      element.onEndTag(() => {
        if (state.active) assign(collapse(state.buffer))
        state.active = false
        state.buffer = ''
      })
    },
    text(chunk) {
      if (state.active) state.buffer += chunk.text
    },
  }
}

export const parseTheaters = async (html) => {
  const theaters = []
  let region = ''
  let zone = ''

  await new HTMLRewriter()
    .on('div[data-id-bkk], div[data-id-central], div[data-id-north], div[data-id-west], div[data-id-northeast], div[data-id-south]', {
      element(element) {
        for (const [name] of element.attributes) {
          if (name.startsWith('data-id-')) region = name.slice('data-id-'.length)
        }
      },
    })
    .on(
      'div.zone_name h3',
      textSink((value) => {
        zone = value
      }),
    )
    .on('div.cinema_div_list a.bcbl-branches', {
      element(element) {
        const id = element.getAttribute('data-cinema-id')
        const name = collapse(element.getAttribute('data-branch-title'))
        if (id && name) theaters.push({ id, name, region, slug: slugify(name), zone })
      },
    })
    .transform(new Response(html))
    .arrayBuffer()

  return [...new Map(theaters.map((theater) => [theater.id, theater])).values()]
}

export const parseShowtimes = async (html) => {
  const showtimes = []
  let movie = null
  let hall = null
  let hallLine = 0

  await new HTMLRewriter()
    .on('div.bscbb-movie', {
      element(element) {
        movie = { bind: '', genre: '', minutes: '', title: '', url: '' }
        element.onEndTag(() => {
          movie = null
        })
      },
    })
    .on(
      'div.bscbbm-cover-title',
      textSink((value) => {
        if (movie) movie.title = value
      }),
    )
    .on(
      'div.bscbbm-cover-cate',
      textSink((value) => {
        if (movie) movie.genre = value.replace(/\s*\/\s*$/, '')
      }),
    )
    .on(
      'div.bscbbm-cover-time',
      textSink((value) => {
        if (movie) movie.minutes = value
      }),
    )
    .on('div.bscbbm-cover-see-detail a', {
      element(element) {
        if (!movie) return
        const path = element.getAttribute('href') || ''
        movie.bind = slugify(path.replace(/^\/movie\//, ''))
        movie.url = path.startsWith('http') ? path : `${MAJOR_ORIGIN}${path}`
      },
    })
    .on('div.bscbbm-theatre-list', {
      element(element) {
        hall = { audio: '', name: '' }
        hallLine = 0
        element.onEndTag(() => {
          hall = null
        })
      },
    })
    // The hall block lists the screen name first and the audio/subtitle track second.
    .on(
      'div.bscbbm-theatre-list-name ul.bscbbmt li',
      textSink((value) => {
        if (!hall) return
        if (hallLine === 0) hall.name = value
        else if (hallLine === 1 && value) hall.audio = value
        hallLine += 1
      }),
    )
    .on('div.bscbbm-theatre-list-time a', {
      element(element) {
        const showtime = element.getAttribute('data-showtime')
        const classes = element.getAttribute('class') || ''
        if (!showtime) {
          // A past screening renders as a plain 'pasted' label without a booking id.
          if (classes.includes('pasted')) showtimes.push({ hall: { ...hall }, movie: { ...movie }, past: true, showtime: null, time: '' })
          return
        }
        showtimes.push({ hall: { ...hall }, movie: { ...movie }, past: false, showtime, time: '' })
      },
    })
    .on(
      'div.bscbbm-theatre-list-time a',
      textSink((value) => {
        const last = showtimes.at(-1)
        if (last && !last.time) last.time = value
      }),
    )
    .transform(new Response(html))
    .arrayBuffer()

  return showtimes.filter((entry) => entry.time)
}

/** The seat plan arrives as a JSON blob embedded in the booking fragment, not as rendered markup. */
export const parseSeatPlan = (html) => {
  const match = /seat_data_string\s*=\s*'([\s\S]*?)'\s*;/.exec(html)
  if (!match) return null

  let payload
  try {
    payload = JSON.parse(match[1])
  } catch {
    return null
  }

  const rows = []
  let available = 0
  let total = 0

  for (const row of payload?.result?.seats || []) {
    const seats = []
    for (const column of row.Columns || []) {
      if (column?.Id === undefined) continue
      const free = column.Status === SEAT_AVAILABLE
      seats.push({ available: free, column: column.Position?.ColumnIndex ?? null, id: column.Id, type: column.AreaCategoryCode })
      total += 1
      if (free) available += 1
    }
    if (seats.length) rows.push({ available: seats.filter((seat) => seat.available).length, name: row.Name, seats, total: seats.length })
  }

  return { available, occupied: total - available, rows, tickets: parseTickets(payload?.result?.tickets), total }
}

const parseTickets = (tickets) => {
  const seen = new Map()
  for (const group of tickets || []) {
    for (const ticket of Object.values(group || {})) {
      if (ticket?.TicketCode && !seen.has(ticket.TicketCode)) {
        seen.set(ticket.TicketCode, { code: ticket.TicketCode, name: ticket.Ticket, price: ticket.Price, seatType: ticket.SeatType })
      }
    }
  }
  return [...seen.values()]
}

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

const theaterAliases = (theater) => [theater.slug, theater.slugTh]
const theaterNames = (theater) => [theater.name.toLowerCase(), theater.nameTh.toLowerCase()]

// Branch names are written inconsistently ('เมกาบางนา' vs a searched 'เมกา บางนา'), so separators are dropped.
const compact = (value) => slugify(value).replaceAll('-', '')
const theaterCompact = (theater) => [compact(theater.name), compact(theater.nameTh)]

const NO_MATCH = Number.POSITIVE_INFINITY

const theaterRank = (theater, { lowered, shrunk, slug }) => {
  const aliases = theaterAliases(theater)
  const names = theaterNames(theater)

  if (aliases.includes(slug) || names.includes(lowered)) return 0
  if (aliases.some((alias) => alias.startsWith(slug)) || names.some((name) => name.startsWith(lowered))) return 1
  if (aliases.some((alias) => alias.includes(slug)) || names.some((name) => name.includes(lowered))) return 2

  const shrunkNames = theaterCompact(theater)
  if (shrunkNames.some((name) => name.startsWith(shrunk))) return 3
  if (shrunkNames.some((name) => name.includes(shrunk))) return 4

  // Last resort: every word of the reference appears somewhere in the name ('imax paragon').
  const words = slug.split('-').filter(Boolean)
  if (words.length > 1 && aliases.some((alias) => words.every((word) => alias.includes(word)))) return 5

  return NO_MATCH
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

  const parts = { lowered: wanted.toLowerCase(), shrunk, slug }
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
