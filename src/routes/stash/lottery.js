import dayjs from 'dayjs'

const LOTTERY_API = 'https://api.thairath.co.th/tr-api/phalcon/api-lottery/history'
const FETCH_HEADERS = {
  accept: '*/*',
  origin: 'https://www.thairath.co.th',
  referer: 'https://www.thairath.co.th/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
}

const fetchDraws = async (date) => {
  const url = date ? `${LOTTERY_API}?date=${date}` : LOTTERY_API
  const res = await fetch(url, { headers: FETCH_HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const { data } = await res.json()
  return data || []
}

const upsertDraws = async (db, draws) => {
  for (const draw of draws) {
    const p = draw.prizes
    await db
      .insertInto('stash.lottery')
      .values({
        back_three: p['10'],
        back_two: p['7'],
        draw: draw.str,
        first_prize: p['1'][0],
        front_three: p['6'],
      })
      .onConflict((oc) =>
        oc.column('draw').doUpdateSet((eb) => ({
          back_three: eb.ref('excluded.back_three'),
          back_two: eb.ref('excluded.back_two'),
          first_prize: eb.ref('excluded.first_prize'),
          front_three: eb.ref('excluded.front_three'),
        })),
      )
      .execute()
  }
}

export const lottery = async ({ db, logger }) => {
  try {
    const draws = await fetchDraws()
    if (!draws.length) return Response.json({ error: 'No data from API', success: false }, { status: 502 })
    await upsertDraws(db, [draws[0]])
    return Response.json({ draw: draws[0].str, success: true })
  } catch (error) {
    logger.error({ error: error.message }, 'Error fetching lottery')
    return Response.json({ error: error.message, success: false }, { status: 500 })
  }
}

const runBulk = async (db, logger, targetDate) => {
  let cursorDate = null
  let total = 0
  try {
    // ponytail: sequential 1-req/sec loop to avoid rate-limit; each call returns 6 draws going back by date
    while (true) {
      const draws = await fetchDraws(cursorDate)
      if (!draws.length) break

      const relevant = draws.filter((d) => d.str >= targetDate)
      if (relevant.length) {
        await upsertDraws(db, relevant)
        total += relevant.length
      }

      const oldest = draws[draws.length - 1].str
      logger.info(`bulk lottery ${oldest}: ${total} draws (until ${targetDate})`)

      if (oldest <= targetDate) break

      cursorDate = dayjs(oldest).subtract(1, 'day').format('YYYY-MM-DD')
      await new Promise((r) => setTimeout(r, 1000))
    }
    logger.info(`bulk lottery done: ${total} draws until ${targetDate}`)
  } catch (error) {
    logger.error(`bulk lottery failed: ${error.message} (total ${total}, until ${targetDate})`)
  }
}

export const lotteryBulk = async ({ db, logger, query }) => {
  const targetDate = query.date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    return Response.json({ error: 'date query param required (YYYY-MM-DD)', success: false }, { status: 400 })
  }

  // ponytail: return 202 immediately — bulk takes 100+ seconds, can't block the request
  void runBulk(db, logger, targetDate)
  return new Response(null, { status: 202 })
}
