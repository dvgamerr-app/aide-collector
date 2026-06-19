import dayjs from 'dayjs'
import weekOfYear from 'dayjs/plugin/weekOfYear'
import { sql } from 'kysely'

import { json } from '../../db'

dayjs.extend(weekOfYear)

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
  const byName = new Map()

  for (const row of cinemaRows) {
    const existing = byName.get(row.name_en) || byName.get(row.name_th)
    if (existing) {
      existing.theater = Object.assign(existing.theater, row.theater)
      mergeKey.push(row)
    } else {
      byName.set(row.name_en, row)
      byName.set(row.name_th, row)
      uniqueKey.push(row)
    }
  }

  return { mergeKey, uniqueKey }
}

export const cinema = async ({ body, db, logger }) => {
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
