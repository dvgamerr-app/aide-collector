import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'
import weekOfYear from 'dayjs/plugin/weekOfYear'
import { Elysia, t } from 'elysia'
import { sql } from 'kysely'
import numeral from 'numeral'

import { json } from '../db'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(weekOfYear)
dayjs.extend(relativeTime)

const cinema = async ({ db, query }) => {
  const { genre, release_date, search, week, year } = query

  let q = db.selectFrom('stash.cinema_showing').select(['n_time', 'o_theater', 's_cover', 's_display', 's_genre', 's_url', 't_release'])

  let hasFilter = false
  if (search) {
    q = q.where((eb) => eb.or([eb('s_name_en', 'ilike', `%${search}%`), eb('s_name_th', 'ilike', `%${search}%`)]))
    hasFilter = true
  } else if (release_date) {
    if (!release_date.match(/^\d{4}-\d{2}-\d{2}$/) || !dayjs(release_date).isValid()) {
      throw { message: 'Invalid release_date', status: 400 }
    }
    q = q.where('t_release', '=', release_date)
    hasFilter = true
  } else if (week || year) {
    if (week) q = q.where('n_week', '=', week)
    if (year) q = q.where('n_year', '=', year)
    hasFilter = true
  }

  if (genre) q = q.where('s_genre', 'ilike', `%${genre}%`)

  if (!hasFilter || (!search && genre)) {
    q = q.where('n_week', '=', dayjs().week()).where('n_year', '=', dayjs().year())
  }

  const results = await q.orderBy('t_release desc').orderBy('s_display asc').execute()

  return results.map((row) => ({
    ...row,
    o_theater: Object.keys(json(row.o_theater)),
    t_release: dayjs(row.t_release).tz('Asia/Bangkok').format('YYYY-MM-DD'),
  }))
}

const goldCalculator = (entries, market, key) =>
  (entries || [])
    .map((entry) => {
      const cost = (entry.oz || 0) * (entry.usd || 0) + (entry.kg || 0) * (entry.usd || 0)
      const spot = (entry.oz || 0) * parseFloat(market.tout) + (entry.kg || 0) * parseFloat(market.tout)
      return { cost, profit: spot - cost, spot }
    })
    .reduce((total, e) => total + e[key], 0)

const gold = async ({ db, logger, query, store }) => {
  const traceId = store?.traceId
  const currency = query?.currency || 'USD'

  let {
    rows: [goldReminder],
  } = await sql`SELECT r.note FROM reminder r WHERE name = 'gold'`.execute(db)

  let {
    rows: [market],
  } = await sql`SELECT * FROM stash.gold ORDER BY updated_at DESC LIMIT 1`.execute(db)

  if (!goldReminder) {
    const note = { deposit: 1, gold96: [], gold99: [{ oz: 1, usd: 0 }], wallet: 0 }
    await db
      .insertInto('reminder')
      .values({ name: 'gold', note: sql`${JSON.stringify(note)}::jsonb` })
      .onConflict((oc) => oc.column('name').doUpdateSet({ note: sql`${JSON.stringify(note)}::jsonb` }))
      .execute()
    goldReminder = { note }
  }

  if (!market) {
    market = { tin: '0', tin_ico: 'none', tout: '0', tout_ico: 'none', usd_buy: '33.5', usd_sale: '34.5' }
    await db.insertInto('stash.gold').values(market).execute()
  }

  market = Object.assign(market, {
    tin: parseFloat(market.tin),
    tout: parseFloat(market.tout),
    usd_buy: parseFloat(market.usd_buy),
    usd_sale: parseFloat(market.usd_sale),
  })

  const { deposit, gold96, gold99, wallet } = json(goldReminder.note)

  const costTotal = goldCalculator(gold99, market, 'spot') + goldCalculator(gold96, market, 'spot')
  const depositTotal = deposit / market.usd_buy
  const profitTotal = costTotal + wallet - depositTotal
  const profitPercent = Math.round((profitTotal / depositTotal) * 100 * 100) / 100

  const trands = market.tout_ico === 'up' ? 'เพิ่มขึ้น' : 'ลดลง'
  logger.info(
    `[${traceId}] 🪙 ${profitTotal > 0 ? 'กำไร' : 'ขาดทุน'} ${numeral(profitTotal * parseFloat(market.usd_sale)).format('0,0')} บาท (${profitTotal > 0 ? '+' : ''}${profitPercent}%) ราคา${trands} `,
  )

  delete market.tin
  delete market.tin_ico

  return {
    exchange: { buy: parseFloat(market.usd_buy), sale: parseFloat(market.usd_sale) },
    profitPercent,
    profitTotal: Math.round(profitTotal * (currency === 'THB' ? market.usd_sale : 1) * 100) / 100,
    spot: { tout: parseFloat(market.tout), tout_ico: market.tout_ico },
    total: Math.round((costTotal + wallet) * (currency === 'THB' ? market.usd_buy : 1) * 100) / 100,
    updated_at: dayjs(market.updated_at).fromNow(),
  }
}

const route = new Elysia({ prefix: '/collector' })

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
