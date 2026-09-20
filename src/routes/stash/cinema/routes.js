import { attachSeats, fetchSeats, fetchShowtimes, fetchTheaters, resolveTheater } from './booking'
import { slugify, TIMEZONE } from './normalize'

// Fetching a seat plan is one sequential request per showtime, so a window is capped at a handful.
const SEAT_LIMIT = 10
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

// Nobody plans a cinema trip more than a day out, and every extra day is another pair of upstream requests.
const MAX_DAYS_AHEAD = 1

const bkkDate = (daysAhead = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date(Date.now() + daysAhead * 86_400e3))

export const allowedDates = () => Array.from({ length: MAX_DAYS_AHEAD + 1 }, (_, day) => bkkDate(day))

const fail = (message, status = 400) => Response.json({ error: message, success: false }, { status })

const publicTheater = (theater) => ({
  id: theater.id,
  name: theater.name,
  nameTh: theater.nameTh,
  region: theater.region,
  slug: theater.slug,
  zone: theater.zone,
})

export const matchesMovie = (entry, movie) => {
  if (!movie) return true

  const wanted = slugify(movie)
  if (!wanted) return false

  const aliases = [entry.movie?.bind, slugify(entry.movie?.title), slugify(entry.movie?.titleTh)].filter(Boolean)
  return aliases.some((alias) => alias === wanted || alias.includes(wanted))
}

export const withinWindow = ({ from, time, to }, entry) => {
  if (time && entry.time !== time) return false
  if (from && entry.time < from) return false
  if (to && entry.time > to) return false
  return true
}

export const readQuery = (query) => {
  const dates = allowedDates()
  const date = query?.date || dates[0]
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'date must be YYYY-MM-DD' }
  if (!dates.includes(date)) return { error: `date must be one of ${dates.join(' or ')}` }

  for (const key of ['from', 'time', 'to']) {
    if (query?.[key] && !TIME_PATTERN.test(query[key])) return { error: `${key} must be HH:MM` }
  }

  // A time window keeps the answer to the handful of screenings somebody is actually choosing between.
  const [from, time, to] = [query?.from || '', query?.time || '', query?.to || '']
  if (!time && !(from && to)) return { error: 'a time window is required: pass time=HH:MM, or both from=HH:MM and to=HH:MM' }
  if (from && to && from > to) return { error: 'from must not be later than to' }

  return {
    date,
    detail: query?.detail === 'true',
    from,
    includePast: query?.past === 'true',
    movie: query?.movie || '',
    seats: query?.seats === 'true',
    time,
    to,
  }
}

const collectShowtimes = async (theaterReference, query, logger) => {
  const options = readQuery(query)
  if (options.error) return fail(options.error)

  const theater = await resolveTheater(theaterReference)
  if (!theater) return fail(`theater '${theaterReference}' was not found`, 404)

  const all = await fetchShowtimes({ date: options.date, theaterId: theater.id })
  const filtered = all
    .filter((entry) => options.includePast || !entry.past)
    .filter((entry) => matchesMovie(entry, options.movie))
    .filter((entry) => withinWindow(options, entry))

  let showtimes = filtered
  let truncated = false

  if (options.seats) {
    truncated = filtered.length > SEAT_LIMIT
    showtimes = await attachSeats(truncated ? filtered.slice(0, SEAT_LIMIT) : filtered, options.detail)
  }

  const available = options.seats ? showtimes.reduce((total, entry) => total + (entry.seats?.available ?? 0), 0) : null
  logger.info({ date: options.date, matched: filtered.length, seats: options.seats, theater: theater.id }, 'cinema showtimes served')

  return Response.json({
    ...(available !== null && { seatsAvailable: available }),
    ...(truncated && { seatsTruncated: SEAT_LIMIT }),
    date: options.date,
    showtimes,
    success: true,
    theater: publicTheater(theater),
    total: filtered.length,
  })
}

export const theaterList = async ({ query }) => {
  const theaters = await fetchTheaters()
  const search = (query?.search || '').toLowerCase()
  const matched = search
    ? theaters.filter((theater) => `${theater.name} ${theater.nameTh} ${theater.zone} ${theater.zoneTh}`.toLowerCase().includes(search))
    : theaters

  return Response.json({ success: true, theaters: matched.map(publicTheater), total: matched.length })
}

export const showtimeList = async ({ logger, query }) => {
  if (!query?.theater) return fail('theater query param is required')
  return collectShowtimes(query.theater, query, logger)
}

export const showtimeSeats = async ({ params, query }) => {
  if (!/^\d+$/.test(params.showtime)) return fail('showtime must be a numeric id from /collector/cinema/showtime')

  const plan = await fetchSeats(params.showtime)
  if (!plan) return fail(`seat plan for showtime '${params.showtime}' is unavailable`, 404)

  const { rows, ...summary } = plan
  return Response.json({ showtime: String(params.showtime), success: true, ...summary, ...(query?.detail === 'true' && { rows }) })
}

/** Shorthand for "which showtimes does this movie have at this branch", the common chat-style question. */
export const movieAtTheater = async ({ logger, params, query }) =>
  collectShowtimes(params.theater, { ...query, movie: params.movie }, logger)
