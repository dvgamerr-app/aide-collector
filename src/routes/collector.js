import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'
import { Elysia, t } from 'elysia'
import { sql } from 'kysely'

import { parseJson } from '../json'
import { getReminder, setReminder } from '../reminders'
import { cinemaWeek, TIMEZONE } from './stash/cinema/normalize'
import { movieAtTheater, showtimeList, showtimeSeats, theaterList } from './stash/cinema/routes'
import { ontHistory, ontLatest } from './stash/ont/routes'

const showtimeQuery = t.Object({
  date: t.Optional(t.String({ description: 'Show date YYYY-MM-DD; today or tomorrow only, defaults to today in Bangkok' })),
  detail: t.Optional(t.String({ description: 'Set to true to include the per-row seat map' })),
  from: t.Optional(
    t.String({ description: 'Earliest start time HH:MM, required together with to unless time is given', examples: ['15:00'] }),
  ),
  movie: t.Optional(t.String({ description: 'Movie slug or part of its title', examples: ['the-odyssey'] })),
  past: t.Optional(t.String({ description: 'Set to true to include screenings that already started' })),
  seats: t.Optional(t.String({ description: 'Set to true to look up seat availability per showtime (max 10, fetched one at a time)' })),
  theater: t.Optional(t.String({ description: 'Branch id, slug or part of its name', examples: ['paragon'] })),
  time: t.Optional(t.String({ description: 'Exact start time HH:MM; use instead of from/to', examples: ['15:00'] })),
  to: t.Optional(
    t.String({ description: 'Latest start time HH:MM, required together with from unless time is given', examples: ['18:00'] }),
  ),
})

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(relativeTime)

const cinema = async ({ db, query }) => {
  const { genre, release_date, search, week, year } = query

  let q = db
    .selectFrom('stash.cinema_showing')
    .select(['n_time', 'o_theater', 's_cover', 's_display', 's_genre', 's_section', 's_url', 't_release'])

  let hasFilter = false
  if (search) {
    q = q.where((eb) => eb.or([eb('s_name_en', 'ilike', `%${search}%`), eb('s_name_th', 'ilike', `%${search}%`)]))
    hasFilter = true
  } else if (release_date) {
    if (!release_date.match(/^\d{4}-\d{2}-\d{2}$/) || !dayjs(release_date).isValid()) {
      throw { message: 'Invalid release_date', status: 400 }
    }
    // t_release is stored as Bangkok midnight, so the day has to be compared in the same zone.
    q = q.where(sql`(t_release AT TIME ZONE ${TIMEZONE})::date`, '=', release_date)
    hasFilter = true
  } else if (week || year) {
    if (week) q = q.where('n_week', '=', week)
    if (year) q = q.where('n_year', '=', year)
    hasFilter = true
  }

  if (genre) q = q.where('s_genre', 'ilike', `%${genre}%`)

  if (!hasFilter || (!search && genre)) {
    // Must match the bucket the collector writes, otherwise the default listing is always empty.
    const { week: currentWeek, year: currentYear } = cinemaWeek()
    q = q.where('n_week', '=', currentWeek).where('n_year', '=', currentYear)
  }

  const results = await q.orderBy('t_release', 'desc').orderBy('s_display', 'asc').execute()

  return results.map((row) => ({
    ...row,
    o_theater: Object.keys(parseJson(row.o_theater) || {}),
    t_release: row.t_release ? dayjs(row.t_release).tz('Asia/Bangkok').format('YYYY-MM-DD') : null,
  }))
}

const goldSpot = (entries, spotPrice) =>
  (entries || []).reduce((total, entry) => total + (entry.oz || 0) * spotPrice + (entry.kg || 0) * spotPrice, 0)

const gold = async ({ db, logger, query, traceId }) => {
  const currency = query?.currency || 'USD'

  let goldReminder = await getReminder(db, 'gold')

  let {
    rows: [market],
  } = await sql`SELECT * FROM stash.gold ORDER BY updated_at DESC LIMIT 1`.execute(db)

  if (!goldReminder) {
    goldReminder = { deposit: 1, gold96: [], gold99: [{ oz: 1, usd: 0 }], wallet: 0 }
    await setReminder(db, 'gold', goldReminder)
  }

  if (!market) {
    market = { tin: '0', tin_ico: 'none', tout: '0', tout_ico: 'none', usd_buy: '33.5', usd_sale: '34.5' }
    await db.insertInto('stash.gold').values(market).execute()
  }

  const numericMarket = {
    ...market,
    tin: parseFloat(market.tin),
    tout: parseFloat(market.tout),
    usd_buy: parseFloat(market.usd_buy),
    usd_sale: parseFloat(market.usd_sale),
  }

  const { deposit, gold96, gold99, wallet } = goldReminder

  const costTotal = goldSpot(gold99, numericMarket.tout) + goldSpot(gold96, numericMarket.tout)
  const depositTotal = deposit / numericMarket.usd_buy
  const profitTotal = costTotal + wallet - depositTotal
  const profitPercent = Math.round((profitTotal / depositTotal) * 100 * 100) / 100

  const trands = numericMarket.tout_ico === 'up' ? 'เพิ่มขึ้น' : 'ลดลง'
  logger.info(
    `[${traceId}] 🪙 ${profitTotal > 0 ? 'กำไร' : 'ขาดทุน'} ${Math.round(profitTotal * numericMarket.usd_sale).toLocaleString('th-TH')} บาท (${profitTotal > 0 ? '+' : ''}${profitPercent}%) ราคา${trands} `,
  )

  return {
    exchange: { buy: numericMarket.usd_buy, sale: numericMarket.usd_sale },
    profitPercent,
    profitTotal: Math.round(profitTotal * (currency === 'THB' ? numericMarket.usd_sale : 1) * 100) / 100,
    spot: { tout: numericMarket.tout, tout_ico: numericMarket.tout_ico },
    total: Math.round((costTotal + wallet) * (currency === 'THB' ? numericMarket.usd_buy : 1) * 100) / 100,
    updated_at: dayjs(numericMarket.updated_at).fromNow(),
  }
}

const route = new Elysia({ prefix: '/collector' })

route.get('/ont', ontLatest, {
  detail: { description: 'Read the latest complete ONT snapshot from PostgreSQL.', summary: 'Get ONT devices', tags: ['Collector'] },
})

route.get('/ont/:mac/history', ontHistory, {
  detail: {
    description: 'Read device samples (last 24 hours by default, maximum 31 days).',
    summary: 'Get ONT device history',
    tags: ['Collector'],
  },
  params: t.Object({ mac: t.String({ pattern: '^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$' }) }),
  query: t.Object({
    from: t.Optional(t.String({ format: 'date-time' })),
    limit: t.Optional(t.Numeric({ maximum: 5000, minimum: 1, multipleOf: 1 })),
    to: t.Optional(t.String({ format: 'date-time' })),
  }),
})

route.get('/cinema', cinema, {
  detail: {
    description: 'Fetch cinema showing data with optional filtering by genre, release date, search term, week, or year',
    summary: 'Get cinema showing',
    tags: ['Collector'],
  },
  query: t.Object({
    genre: t.Optional(t.String()),
    release_date: t.Optional(t.String()),
    search: t.Optional(t.String()),
    week: t.Optional(t.Number()),
    year: t.Optional(t.Number()),
  }),
})

route.get('/cinema/theater', theaterList, {
  detail: {
    description: 'List every Major Cineplex branch with its Thai/English name and zone. Fetched live, never stored.',
    summary: 'Get cinema theaters',
    tags: ['Collector'],
  },
  query: t.Object({ search: t.Optional(t.String({ description: 'Match against branch name or zone', examples: ['paragon'] })) }),
})

route.get('/cinema/showtime', showtimeList, {
  detail: {
    description:
      'Live showtimes for one branch inside a required time window, optionally with per-showtime seat availability. Answers "which screen and how many seats are free at 15:00".',
    summary: 'Get cinema showtimes',
    tags: ['Collector'],
  },
  query: showtimeQuery,
})

route.get('/cinema/showtime/:showtime/seat', showtimeSeats, {
  detail: {
    description: 'Live seat plan for one showtime: free/occupied counts, ticket prices and, with detail=true, the per-row seat map.',
    summary: 'Get cinema seats',
    tags: ['Collector'],
  },
  params: t.Object({ showtime: t.String({ description: 'Showtime id from /collector/cinema/showtime', examples: ['6306778'] }) }),
  query: t.Object({ detail: t.Optional(t.String({ description: 'Set to true to include the per-row seat map' })) }),
})

route.get('/cinema/:movie/:theater', movieAtTheater, {
  detail: {
    description:
      'Shorthand for the showtimes of one movie at one branch, with the same required time window as /collector/cinema/showtime.',
    summary: 'Get cinema showtimes by movie and theater',
    tags: ['Collector'],
  },
  params: t.Object({
    movie: t.String({ description: 'Movie slug or part of its title', examples: ['the-odyssey'] }),
    theater: t.String({ description: 'Branch id, slug or part of its name', examples: ['paragon'] }),
  }),
  query: showtimeQuery,
})

route.get('/gold', gold, {
  detail: {
    description: 'Fetch current gold prices and calculate profit/loss based on stored investment data.',
    summary: 'Get gold price',
    tags: ['Collector'],
  },
  query: t.Object({
    currency: t.Optional(t.Union([t.Literal('THB'), t.Literal('USD')], { description: 'Currency for price display', example: 'THB' })),
  }),
})

export default route
