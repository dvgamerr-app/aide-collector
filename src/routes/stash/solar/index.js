import dayjs from 'dayjs'
import { sql } from 'kysely'

import { json } from '../../../db'
import { openSign } from './sign'

const ORIGIN = 'https://solar.siseli.com'
const BASE = `${ORIGIN}/apis`

const APP_ID = Bun.env.SOLAR_OPEN_APP_ID
const APP_SECRET = Bun.env.SOLAR_OPEN_APP_SECRET
// ponytail: base64 of {"account","password"} (password is md5 hex) — same shape as MEA_PAYLOAD
const PAYLOAD = Bun.env.SOLAR_PAYLOAD
const DEVICE_ID = Bun.env.SOLAR_DEVICE_ID

const PAGE = 300 // records/page. 5-min cadence -> 288/day, so a full day fits in one page
// trailing window for the hourly job. 5-min cadence + overlap tolerates ~2 missed runs; upsert dedups overlap
const LOOKBACK_HOURS = 3

const COMMON = {
  Accept: 'application/json',
  'Accept-Language': 'en',
  'Content-Type': 'application/json; charset=utf-8',
  'IOT-Time-Zone': 'Asia/Bangkok',
  Origin: ORIGIN,
  Referer: `${ORIGIN}/`,
}

const missingEnv = () => {
  const need = { SOLAR_DEVICE_ID: DEVICE_ID, SOLAR_OPEN_APP_ID: APP_ID, SOLAR_OPEN_APP_SECRET: APP_SECRET, SOLAR_PAYLOAD: PAYLOAD }
  const miss = Object.keys(need).filter((k) => !need[k])
  return miss.length ? `missing env: ${miss.join(', ')}` : null
}

// today's date in Bangkok (YYYY-MM-DD) without pulling a tz plugin; day boundary as the API expects it
const bkkDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date())
const dayBound = (ymd) => `${ymd}T00:00:00+07:00`
// Bangkok wall-clock instant with +07:00 offset (UTC + 7h relabelled), for sub-day windows
const bkkTime = (ms) => new Date(ms + 7 * 3600e3).toISOString().replace(/\.\d{3}Z$/, '+07:00')
const trailing = (hours) => [bkkTime(Date.now() - hours * 3600e3), bkkTime(Date.now() + 5 * 60e3)]

// open-signed POST (login / refresh). Platform wraps everything as { code, data, msg }; code 0 = ok.
const openPost = async (path, body) => {
  const headers = { ...COMMON, 'IOT-Token': 'null', ...openSign({ appId: APP_ID, body, encSecret: APP_SECRET, method: 'POST' }) }
  const res = await fetch(`${BASE}${path}`, { body, headers, method: 'POST' })
  const data = await res.json()
  if (data.code !== 0) throw new Error(`${path} failed: code ${data.code} ${data.msg || ''}`)
  return data.data
}

// token-authed POST. Returns the raw envelope so the caller can react to an auth-expired code.
const apiPost = async (path, token, body) => {
  const res = await fetch(`${BASE}${path}`, { body, headers: { ...COMMON, 'IOT-Token': token }, method: 'POST' })
  const data = await res.json()
  return { code: data.code, data: data.data }
}

const storeToken = async (db, d) => {
  const tk = {
    accessExpire: d.accessTokenWillExpiredAt,
    accessToken: d.accessToken,
    refreshExpire: d.refreshTokenWillExpiredAt,
    refreshToken: d.refreshToken,
  }
  const note = sql`${JSON.stringify(tk)}::jsonb`
  await db
    .insertInto('reminder')
    .values({ name: 'solar_token', note })
    .onConflict((oc) => oc.column('name').doUpdateSet({ note }))
    .execute()
  return tk
}

const login = async (db) => storeToken(db, await openPost('/login/account', atob(PAYLOAD)))

const refresh = async (db, tk) =>
  storeToken(
    db,
    await openPost('/login/refresh/access/token', JSON.stringify({ accessToken: tk.accessToken, refreshToken: tk.refreshToken })),
  )

// reuse cached token (60s margin); refresh when access expired, full login when refresh also expired.
// ponytail: assumes *WillExpiredAt are epoch-ms (matches the MEA token cache convention)
const getToken = async (db) => {
  const row = await db.selectFrom('reminder').select('note').where('name', '=', 'solar_token').executeTakeFirst()
  const tk = row && json(row.note)
  const now = Date.now() + 60_000
  if (!tk) return login(db)
  if (tk.accessExpire > now) return tk
  if (tk.refreshExpire > now) {
    try {
      return await refresh(db, tk)
    } catch {
      return login(db)
    }
  }
  return login(db)
}

// columnar payload -> EAV rows: timeSeries[i] is the timestamp, fields[attr][i].vd the value at that time.
// non-numeric attrs (firmwareVersion, productSerialNumber, batteryStatus, ...) drop out — they're device
// metadata, not timeseries metrics. timeSeries timestamps are UTC ("...Z"); timestamptz stores the instant.
const mapPayload = (deviceId, payload) => {
  const times = payload?.timeSeries || []
  const rows = []
  for (const [attr, series] of Object.entries(payload?.fields || {})) {
    for (let i = 0; i < times.length; i++) {
      const value = Number(series[i]?.vd)
      if (Number.isFinite(value)) rows.push({ attr, device_id: deviceId, recorded_at: times[i], value })
    }
  }
  return rows
}

// paginate one time window fully. ponytail: 500-page cap as a runaway guard
const fetchRows = async (token, deviceId, fromTime, toTime) => {
  const rows = []
  let points = 0
  for (let page = 1; page <= 500; page++) {
    const body = JSON.stringify({ count: PAGE, deviceId, fromTime, orderByTimeAsc: false, page, toTime })
    const { code, data } = await apiPost('/deviceState/simple/attribute/record/list/v1', token, body)
    if (code !== 0) throw new Error(`record list failed: code ${code}`)
    const got = data?.payload?.timeSeries?.length || 0
    rows.push(...mapPayload(deviceId, data?.payload))
    points += got
    if (got < PAGE) break
  }
  return { points, rows }
}

const upsertRecords = async (db, rows) => {
  if (!rows.length) return 0
  for (let i = 0; i < rows.length; i += 1000) {
    await db
      .insertInto('stash.solar_record')
      .values(rows.slice(i, i + 1000))
      .onConflict((oc) => oc.columns(['device_id', 'attr', 'recorded_at']).doUpdateSet((eb) => ({ value: eb.ref('excluded.value') })))
      .execute()
  }
  return rows.length
}

const collect = async (db, token, fromTime, toTime) => {
  const { points, rows } = await fetchRows(token, DEVICE_ID, fromTime, toTime)
  return { points, rows: await upsertRecords(db, rows) }
}

// incremental: pull the last LOOKBACK_HOURS only — sized to the hourly job, not a full day
export const solar = async ({ db, logger }) => {
  const miss = missingEnv()
  if (miss) return Response.json({ error: miss, success: false }, { status: 500 })
  try {
    const token = await getToken(db)
    const [from, to] = trailing(LOOKBACK_HOURS)
    const { points, rows } = await collect(db, token.accessToken, from, to)
    logger.info(`solar: ${rows} rows from ${points} points (last ${LOOKBACK_HOURS}h)`)
    return Response.json({ points, rows, success: true })
  } catch (error) {
    logger.error({ error: error.message }, 'Error collecting solar')
    return Response.json({ error: error.message, success: false }, { status: 500 })
  }
}

const runBulk = async (db, logger, targetDate) => {
  let cursor = bkkDate()
  let total = 0
  try {
    // ponytail: sequential day-by-day backfill, 1 req/sec between days; refresh token per day for long runs
    while (cursor >= targetDate) {
      const token = await getToken(db)
      const next = dayjs(cursor).add(1, 'day').format('YYYY-MM-DD')
      const { rows } = await collect(db, token.accessToken, dayBound(cursor), dayBound(next))
      total += rows
      logger.info(`bulk solar ${cursor}: ${rows} rows (total ${total}, until ${targetDate})`)
      cursor = dayjs(cursor).subtract(1, 'day').format('YYYY-MM-DD')
      await new Promise((r) => setTimeout(r, 1000))
    }
    logger.info(`bulk solar done: ${total} rows until ${targetDate}`)
  } catch (error) {
    logger.error(`bulk solar failed at ${cursor}: ${error.message} (total ${total}, until ${targetDate})`)
  }
}

// ponytail: return 202 immediately — backfill takes minutes, can't block the request (like lottery bulk)
export const solarBulk = async ({ db, logger, query }) => {
  const miss = missingEnv()
  if (miss) return Response.json({ error: miss, success: false }, { status: 500 })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
    return Response.json({ error: 'date query param required (YYYY-MM-DD)', success: false }, { status: 400 })
  }
  void runBulk(db, logger, query.date)
  return new Response(null, { status: 202 })
}

// self-check: columnar payload maps to one row per (attr, time) with index alignment; non-numeric dropped.
// run: bun src/routes/stash/solar/index.js
if (import.meta.main) {
  const sample = {
    fields: {
      batteryStatus: [{ vd: 'Idle' }, { vd: 'Idle' }], // non-numeric -> dropped
      pv1Power: [{ vd: '0' }, { vd: '0' }],
      pv1Voltage: [{ vd: '11.5' }, { vd: '11.8' }],
    },
    timeSeries: ['2026-06-10T16:56:16Z', '2026-06-10T16:51:15Z'],
  }
  const rows = mapPayload('dev1', sample)
  if (rows.length !== 4) throw new Error(`expected 4 rows (2 numeric attrs x 2 times), got ${rows.length}`)
  const v = rows.find((r) => r.attr === 'pv1Voltage' && r.recorded_at === '2026-06-10T16:51:15Z')
  if (v?.value !== 11.8) throw new Error(`index alignment broken: ${JSON.stringify(v)}`)
  console.log('solar mapPayload self-check OK')
}
