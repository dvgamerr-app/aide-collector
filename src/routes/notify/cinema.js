import dayjs from 'dayjs'

import { parseJson } from '../../json'
import { sendNotify } from '../../notify'
import { cinemaWeek, TIMEZONE } from '../stash/cinema/normalize'
import { buildCinemaFlex } from './cinema-flex'

const BOT = 'popcorn'
// LINE caps a single push at 5 message objects, so a big week is sent as several pushes instead of one.
const PUSH_LIMIT = 5
const THURSDAY = 4

/** Monday 00:00 in Bangkok of the week `at` falls in; dayjs().day() is 0=Sunday..6=Saturday. */
const mondayOfWeek = (at = new Date()) => {
  const now = dayjs(at).tz(TIMEZONE)
  const isoDay = now.day() || 7
  return now.subtract(isoDay - 1, 'day').startOf('day')
}

/** [Monday 00:00, next Monday 00:00) in Bangkok — the calendar week this movie must have opened in. */
const weekWindow = () => {
  const start = mondayOfWeek()
  return { end: start.add(7, 'day').toDate(), start: start.toDate() }
}

/**
 * Monday sends the whole week; Thursday sends only movies whose row for this week bucket didn't exist yet
 * on Monday, using the insert-only `t_created` column instead of a separate "already notified" flag.
 */
const fetchNowShowing = async (db, { onlyNew }) => {
  const { week, year } = cinemaWeek()
  const { end, start } = weekWindow()
  let query = db
    .selectFrom('stash.cinema_showing')
    .select(['n_time', 'o_theater', 's_cover', 's_display', 't_release'])
    .where('n_week', '=', week)
    .where('n_year', '=', year)
    .where('s_section', '=', 'showing')
    .where('s_cover', '!=', '')
    // Major lists advance-booking previews under "Now Showing" ahead of their real opening, and keeps
    // long-running carryovers tagged 'showing' too, so only a t_release inside this Mon-Sun window counts.
    .where('t_release', '>=', start)
    .where('t_release', '<', end)

  if (onlyNew) query = query.where('t_created', '>', mondayOfWeek().toDate())

  const rows = await query.orderBy('t_release', 'desc').orderBy('s_display', 'asc').execute()
  // o_theater is a jsonb map of theater -> {cover, url}; the flex card only needs which chains screen it.
  return rows.map((row) => ({ ...row, o_theater: Object.keys(parseJson(row.o_theater) || {}) }))
}

export const notifyCinema = async ({ db, logger }) => {
  const chat = Bun.env.NOTIFY_CINEMA_CHAT
  if (!chat) return Response.json({ error: 'NOTIFY_CINEMA_CHAT is not configured', success: false }, { status: 500 })

  const onlyNew = dayjs().tz(TIMEZONE).day() === THURSDAY

  try {
    const rows = await fetchNowShowing(db, { onlyNew })
    if (!rows.length) return Response.json({ movies: 0, pushed: 0, success: true })

    const { week, year } = cinemaWeek()
    const altText = onlyNew
      ? `ป๊อปคอนแจ้งหนังใหม่ที่เพิ่งเข้าฉายสัปดาห์ที่ ${week} ปี ${year} ครับผม`
      : `ป๊อปคอนขอเสนอ โปรแกรมหนังประจำสัปดาห์ที่ ${week} ปี ${year} ครับผม`
    const messages = buildCinemaFlex(rows, altText)

    let pushed = 0
    for (let index = 0; index < messages.length; index += PUSH_LIMIT) {
      const batch = messages.slice(index, index + PUSH_LIMIT)
      await sendNotify(BOT, chat, batch)
      pushed += batch.length
    }

    logger.info({ movies: rows.length, onlyNew, pushed }, 'cinema notify sent')
    return Response.json({ movies: rows.length, onlyNew, pushed, success: true })
  } catch (error) {
    logger.error({ error: error.message }, 'Error sending cinema notify')
    return Response.json({ error: error.message, success: false }, { status: 500 })
  }
}
