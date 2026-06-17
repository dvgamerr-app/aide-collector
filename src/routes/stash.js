import dayjs from 'dayjs'
import weekOfYear from 'dayjs/plugin/weekOfYear'
import { Elysia } from 'elysia'
import { sql } from 'kysely'

import { json } from '../db'

dayjs.extend(weekOfYear)

const GOLD_API = 'https://register.ylgbullion.co.th/api/price/gold'

const upsertCinema = async (db, body) => {
  if (!body?.length) return
  for (let i = 0; i < body.length; i += 10) {
    const chunk = body.slice(i, i + 10)
    const values = chunk.map((cinema) => ({
      n_time: cinema.time,
      n_week: dayjs(cinema.release).week(),
      n_year: dayjs(cinema.release).year(),
      o_theater: sql`${JSON.stringify(cinema.theater)}::jsonb`,
      s_bind: cinema.bind,
      s_cover: cinema.theater.sf?.cover || cinema.theater.major.cover,
      s_display: cinema.display,
      s_genre: cinema.genre,
      s_name_en: cinema.name_en,
      s_name_th: cinema.name_th,
      s_url: cinema.theater.sf?.url || cinema.theater.major.url,
      t_release: new Date(cinema.release),
    }))

    await db
      .insertInto('stash.cinema_showing')
      .values(values)
      .onConflict((oc) =>
        oc.columns(['s_bind', 'n_week', 'n_year']).doUpdateSet((eb) => ({
          n_time: eb.ref('excluded.n_time'),
          n_week: eb.ref('excluded.n_week'),
          n_year: eb.ref('excluded.n_year'),
          o_theater: sql`"stash"."cinema_showing".o_theater || excluded.o_theater`,
          s_cover: eb.ref('excluded.s_cover'),
          s_display: eb.ref('excluded.s_display'),
          s_genre: eb.ref('excluded.s_genre'),
          s_name_en: eb.ref('excluded.s_name_en'),
          s_name_th: eb.ref('excluded.s_name_th'),
          s_url: eb.ref('excluded.s_url'),
          t_release: eb.ref('excluded.t_release'),
        })),
      )
      .execute()
  }
}

const handleDuplicates = (cinemaRows) => {
  const mergeKey = []
  const uniqueKey = []
  const seen = new Set()

  for (const row of cinemaRows) {
    const isDuplicate = seen.has(row.name_en) || seen.has(row.name_th)
    if (isDuplicate) {
      const existing = uniqueKey.find((e) => e.name_en === row.name_en || e.name_th === row.name_th)
      if (existing) existing.theater = Object.assign(existing.theater, row.theater)
      mergeKey.push(row)
    } else {
      seen.add(row.name_en)
      seen.add(row.name_th)
      uniqueKey.push(row)
    }
  }

  return { mergeKey, uniqueKey }
}

const cinema = async ({ body, db, logger }) => {
  try {
    await upsertCinema(db, body)

    const { rows: duplica } = await sql`
      WITH duplicate AS (
        SELECT s_name_en name FROM "stash"."cinema_showing"
        GROUP BY s_name_en, n_week, n_year HAVING COUNT(*) > 1
        UNION ALL
        SELECT s_name_th name FROM "stash"."cinema_showing"
        GROUP BY s_name_th, n_week, n_year HAVING COUNT(*) > 1
      )
      SELECT
        c.s_bind bind, c.s_name_en name_en, c.s_name_th name_th, c.s_display display, c.t_release release, c.s_genre genre, c.n_week week,
        c.n_year "year", c.n_time "time", c.s_url url, c.s_cover cover, c.o_theater theater
      FROM duplicate d
      LEFT JOIN "stash"."cinema_showing" c ON c.s_name_en = d.name OR c.s_name_th = d.name;
    `.execute(db)

    for (const row of duplica) row.theater = json(row.theater)
    const { mergeKey, uniqueKey } = handleDuplicates(duplica)
    logger.info(`Remove duplicate ${mergeKey.length} keys.`)
    for (const c of mergeKey) {
      await sql`DELETE FROM "stash"."cinema_showing" WHERE n_week = ${c.week} AND n_year = ${c.year} AND s_bind = ${c.bind}`.execute(db)
    }

    await upsertCinema(db, uniqueKey)
    return new Response(null, { status: 201 })
  } catch (ex) {
    logger.error(ex)
    return new Response(JSON.stringify({ error: ex.toString() }), { status: 500 })
  }
}

const gold = async ({ db }) => {
  try {
    const response = await fetch(GOLD_API, {
      headers: { 'Accept-Encoding': 'deflate, gzip;q=1.0, *;q=0.5', 'Content-Type': 'application/json; charset=utf-8' },
      method: 'GET',
    })
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)

    const goldData = await response.json()
    const usdBuy = parseFloat(goldData.exchange_buy) || 33
    const usdSale = parseFloat(goldData.exchange_sale) || 33

    await db
      .insertInto('stash.gold')
      .values({
        tin: goldData.spot.tin.toString(),
        tin_ico: goldData.spot['tin-ico'],
        tout: goldData.spot.tout.toString(),
        tout_ico: goldData.spot['tout-ico'],
        updated_at: new Date(goldData.update_date),
        usd_buy: usdBuy.toString(),
        usd_sale: usdSale.toString(),
      })
      .onConflict((oc) => oc.doNothing())
      .execute()

    return Response.json({
      inserted: {
        tin: goldData.spot.tin,
        tinIco: goldData.spot['tin-ico'],
        tout: goldData.spot.tout,
        toutIco: goldData.spot['tout-ico'],
        updatedAt: goldData.update_date,
        usdBuy,
        usdSale,
      },
      success: true,
    })
  } catch (error) {
    console.error('Error fetching gold data:', error)
    return Response.json({ error: error.message, success: false }, { status: 500 })
  }
}

const route = new Elysia({ prefix: '/stash' })

route.patch('/gold', gold, {
  detail: { description: 'Fetch current gold spot price and store it.', summary: 'Stash gold price', tags: ['Stash'] },
})
route.post('/cinema', cinema, {
  detail: { description: 'Upsert cinema showing data and de-duplicate entries.', summary: 'Stash cinema showing', tags: ['Stash'] },
})

export default route
