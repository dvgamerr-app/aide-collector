import dayjs from 'dayjs'

import { getReminder, setReminder } from '../../../reminders'
import {
  fetchAlarms,
  fetchConfigs,
  fetchDeviceDetails,
  fetchEnergyFlow,
  fetchKeyHistory,
  fetchLatestState,
  fetchRecordHistory,
  fetchStationCategoryDaily,
  fetchStationCategoryMonthly,
  fetchStationCategoryYearly,
  fetchStationGeneratedMonthly,
  fetchStationGeneratedTotal,
  fetchStationGeneratedYearly,
  getSolarToken,
  missingSolarEnv,
} from './api'
import {
  mapAlarms,
  mapCategorySummary,
  mapConfigSnapshots,
  mapDeviceSnapshot,
  mapEnergyFlow,
  mapGeneratedSummary,
  mapKeyHistoryPayload,
  mapRecordPayload,
  mapStatePayload,
} from './mappers'
import {
  insertSolarConfigSnapshots,
  insertSolarDeviceSnapshot,
  upsertSolarAlarms,
  upsertSolarEnergyFlow,
  upsertSolarLatestState,
  upsertSolarRecords,
  upsertSolarStationSummaries,
} from './storage'

const DEVICE_ID = Bun.env.SOLAR_DEVICE_ID
const LOOKBACK_HOURS = 3
const OFFLINE_AFTER_MS = 15 * 60 * 1000
const STATUS_REMINDER = 'solar_device_status'

const bkkDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date())
const bkkTime = (milliseconds) => new Date(milliseconds + 7 * 3600e3).toISOString().replace(/\.\d{3}Z$/, '+07:00')
const dayBound = (date) => `${date}T00:00:00+07:00`
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const trailing = (hours) => [bkkTime(Date.now() - hours * 3600e3), bkkTime(Date.now() + 5 * 60e3)]

const mapPayloads = (deviceId, payloads, mapper) => payloads.flatMap((payload) => mapper(deviceId, payload))

const dedupeRecords = (rows) => [...new Map(rows.map((row) => [`${row.device_id}\u0000${row.attr}\u0000${row.recorded_at}`, row])).values()]

const currentStationRows = async (token, stationId, date) => {
  const month = date.slice(0, 7)
  const year = date.slice(0, 4)
  const [daily, monthly, yearly, generatedMonthly, generatedYearly, generatedTotal] = await Promise.all([
    fetchStationCategoryDaily(token, stationId, date),
    fetchStationCategoryMonthly(token, stationId, month),
    fetchStationCategoryYearly(token, stationId, year),
    fetchStationGeneratedMonthly(token, stationId, month),
    fetchStationGeneratedYearly(token, stationId, year),
    fetchStationGeneratedTotal(token, stationId),
  ])

  return [
    ...mapCategorySummary(stationId, 'category_daily', daily),
    ...mapCategorySummary(stationId, 'category_monthly', monthly),
    ...mapCategorySummary(stationId, 'category_yearly', yearly),
    ...mapGeneratedSummary(stationId, 'generated_monthly', generatedMonthly),
    ...mapGeneratedSummary(stationId, 'generated_yearly', generatedYearly),
    ...mapGeneratedSummary(stationId, 'generated_total', generatedTotal),
  ]
}

const collectCurrent = async (db, token, fromTime, toTime) => {
  const observedAt = new Date().toISOString()
  const date = bkkDate()
  const details = await fetchDeviceDetails(token, DEVICE_ID)
  const stationId = details?.stationId == null ? null : String(details.stationId)
  if (!stationId) throw new Error('device details did not include stationId')

  const [recordHistory, keyHistory] = await Promise.all([
    fetchRecordHistory(token, DEVICE_ID, fromTime, toTime),
    fetchKeyHistory(token, DEVICE_ID, fromTime, toTime),
  ])
  const [alarms, latestState, energyFlow, configs, stationRows] = await Promise.all([
    fetchAlarms(token, DEVICE_ID),
    fetchLatestState(token, DEVICE_ID),
    fetchEnergyFlow(token, DEVICE_ID),
    fetchConfigs(token, DEVICE_ID),
    currentStationRows(token, stationId, date),
  ])

  const recordRows = mapPayloads(DEVICE_ID, recordHistory.payloads, mapRecordPayload)
  const keyRows = mapPayloads(DEVICE_ID, keyHistory.payloads, mapKeyHistoryPayload)
  const latestRows = mapStatePayload(DEVICE_ID, latestState, 'latest_state')
  const flowStateRows = mapStatePayload(DEVICE_ID, energyFlow?.deviceAttributeState, 'energy_flow_state')
  const telemetryRows = dedupeRecords([...keyRows, ...recordRows, ...latestRows, ...flowStateRows])
  const alarmRows = mapAlarms(alarms, observedAt)
  const configRows = mapConfigSnapshots(DEVICE_ID, configs, observedAt)
  const deviceRow = mapDeviceSnapshot(details, observedAt)
  const energyFlowRow = mapEnergyFlow(DEVICE_ID, energyFlow, observedAt)

  const counts = await db.transaction().execute(async (transaction) => ({
    alarms: await upsertSolarAlarms(transaction, alarmRows),
    configSnapshots: await insertSolarConfigSnapshots(transaction, configRows),
    deviceSnapshots: await insertSolarDeviceSnapshot(transaction, deviceRow),
    energyFlowSnapshots: await upsertSolarEnergyFlow(transaction, energyFlowRow),
    latestStateSnapshots: await upsertSolarLatestState(transaction, DEVICE_ID, latestState, observedAt),
    stationSummaryRows: await upsertSolarStationSummaries(transaction, stationRows),
    telemetryRows: await upsertSolarRecords(transaction, telemetryRows),
  }))

  return {
    counts,
    points: { keyHistory: keyHistory.points, recordHistory: recordHistory.points },
    stationId,
  }
}

const collectHistoricalDay = async (db, token, stationId, date) => {
  const next = dayjs(date).add(1, 'day').format('YYYY-MM-DD')
  const [recordHistory, keyHistory, dailySummary] = await Promise.all([
    fetchRecordHistory(token, DEVICE_ID, dayBound(date), dayBound(next)),
    fetchKeyHistory(token, DEVICE_ID, dayBound(date), dayBound(next)),
    fetchStationCategoryDaily(token, stationId, date),
  ])

  const telemetryRows = dedupeRecords([
    ...mapPayloads(DEVICE_ID, keyHistory.payloads, mapKeyHistoryPayload),
    ...mapPayloads(DEVICE_ID, recordHistory.payloads, mapRecordPayload),
  ])
  const stationRows = mapCategorySummary(stationId, 'category_daily', dailySummary)

  return db.transaction().execute(async (transaction) => ({
    keyPoints: keyHistory.points,
    recordPoints: recordHistory.points,
    stationRows: await upsertSolarStationSummaries(transaction, stationRows),
    telemetryRows: await upsertSolarRecords(transaction, telemetryRows),
  }))
}

const collectHistoricalPeriods = async (db, logger, stationId, targetDate) => {
  const currentDate = bkkDate()
  const total = { stationRows: 0 }
  let month = dayjs(targetDate).startOf('month')
  const lastMonth = dayjs(currentDate).startOf('month')

  while (!month.isAfter(lastMonth, 'month')) {
    const token = await getSolarToken(db)
    const value = month.format('YYYY-MM')
    const [category, generated] = await Promise.all([
      fetchStationCategoryMonthly(token.accessToken, stationId, value),
      fetchStationGeneratedMonthly(token.accessToken, stationId, value),
    ])
    const rows = [
      ...mapCategorySummary(stationId, 'category_monthly', category),
      ...mapGeneratedSummary(stationId, 'generated_monthly', generated),
    ]
    total.stationRows += await upsertSolarStationSummaries(db, rows)
    logger.info(`bulk solar station month ${value}: ${rows.length} rows`)
    month = month.add(1, 'month')
    await pause(250)
  }

  let year = dayjs(targetDate).startOf('year')
  const lastYear = dayjs(currentDate).startOf('year')
  while (!year.isAfter(lastYear, 'year')) {
    const token = await getSolarToken(db)
    const value = year.format('YYYY')
    const [category, generated] = await Promise.all([
      fetchStationCategoryYearly(token.accessToken, stationId, value),
      fetchStationGeneratedYearly(token.accessToken, stationId, value),
    ])
    const rows = [
      ...mapCategorySummary(stationId, 'category_yearly', category),
      ...mapGeneratedSummary(stationId, 'generated_yearly', generated),
    ]
    total.stationRows += await upsertSolarStationSummaries(db, rows)
    logger.info(`bulk solar station year ${value}: ${rows.length} rows`)
    year = year.add(1, 'year')
    await pause(250)
  }

  const token = await getSolarToken(db)
  const generatedTotal = await fetchStationGeneratedTotal(token.accessToken, stationId)
  total.stationRows += await upsertSolarStationSummaries(db, mapGeneratedSummary(stationId, 'generated_total', generatedTotal))
  return total
}

const sendDiscordStatus = async (webhookUrl, status, deviceId, lastRecordAt) => {
  if (!webhookUrl) throw new Error('missing env: DISCORD_WEBHOOK')
  const detail = lastRecordAt ? ` (ข้อมูลล่าสุด: ${lastRecordAt.toISOString()})` : ' (ยังไม่พบข้อมูล)'
  const content = status === 'offline' ? `🔴 อุปกรณ์ ${deviceId} ออฟไลน์${detail}` : `🟢 อุปกรณ์ ${deviceId} กลับมาออนไลน์แล้ว`
  const response = await fetch(webhookUrl, {
    body: JSON.stringify({ content }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) throw new Error(`Discord webhook failed: HTTP ${response.status}`)
}

const latestRecordAt = async (db, deviceId) => {
  const row = await db
    .selectFrom('stash.solar_record')
    .select((eb) => eb.fn.max('recorded_at').as('recorded_at'))
    .where('device_id', '=', deviceId)
    .executeTakeFirst()
  return row?.recorded_at ? new Date(row.recorded_at) : null
}

const storedDeviceStatus = (db) => getReminder(db, STATUS_REMINDER)

const storeDeviceStatus = async (db, deviceId, status, recordAt, now) => {
  await setReminder(db, STATUS_REMINDER, {
    changedAt: new Date(now).toISOString(),
    deviceId,
    lastRecordAt: recordAt?.toISOString() || null,
    status,
  })
}

export const getSolarStatusTransition = (recordAt, previousStatus, now = Date.now()) => {
  const status = recordAt && now - recordAt.getTime() < OFFLINE_AFTER_MS ? 'online' : 'offline'
  const shouldNotify = previousStatus !== status && !(status === 'online' && previousStatus !== 'offline')
  return { shouldNotify, status }
}

export const checkSolarDeviceStatus = async ({
  db,
  deviceId = DEVICE_ID,
  logger,
  notify = sendDiscordStatus,
  now = Date.now(),
  webhookUrl = Bun.env.DISCORD_WEBHOOK,
}) => {
  const recordAt = await latestRecordAt(db, deviceId)
  const previous = await storedDeviceStatus(db)
  const previousStatus = previous?.deviceId === deviceId ? previous.status : undefined
  const { shouldNotify, status } = getSolarStatusTransition(recordAt, previousStatus, now)

  if (previousStatus === status) return status

  if (!shouldNotify) {
    await storeDeviceStatus(db, deviceId, status, recordAt, now)
    return status
  }

  await notify(webhookUrl, status, deviceId, recordAt)
  await storeDeviceStatus(db, deviceId, status, recordAt, now)
  logger.info(`solar device ${deviceId}: ${status}`)
  return status
}

const parseInterval = (value) => {
  const match = /^(\d+)(h|m)$/.exec(value || '')
  if (!match) return null
  return match[2] === 'h' ? Number(match[1]) : Number(match[1]) / 60
}

export const solar = async ({ db, logger, query }) => {
  const missing = missingSolarEnv(DEVICE_ID)
  if (missing) return Response.json({ error: missing, success: false }, { status: 500 })

  const hours = parseInterval(query?.interval) ?? LOOKBACK_HOURS
  let result
  try {
    const token = await getSolarToken(db)
    const [fromTime, toTime] = trailing(hours)
    const collected = await collectCurrent(db, token.accessToken, fromTime, toTime)
    logger.info({ ...collected.counts, ...collected.points }, `solar: collected all sources (last ${hours}h)`)
    result = { body: { counts: collected.counts, points: collected.points, success: true }, status: 200 }
  } catch (error) {
    logger.error({ error: error.message }, 'Error collecting solar')
    result = { body: { error: error.message, success: false }, status: 500 }
  }

  try {
    await checkSolarDeviceStatus({ db, logger })
  } catch (error) {
    logger.error({ error: error.message }, 'Error checking solar device status')
  }

  return Response.json(result.body, { status: result.status })
}

const runBulk = async (db, logger, targetDate) => {
  let cursor = bkkDate()
  const total = { keyPoints: 0, recordPoints: 0, stationRows: 0, telemetryRows: 0 }

  try {
    const firstToken = await getSolarToken(db)
    const [fromTime, toTime] = trailing(LOOKBACK_HOURS)
    const current = await collectCurrent(db, firstToken.accessToken, fromTime, toTime)

    while (cursor >= targetDate) {
      const token = await getSolarToken(db)
      const result = await collectHistoricalDay(db, token.accessToken, current.stationId, cursor)
      for (const key of Object.keys(total)) total[key] += result[key] || 0
      logger.info({ ...result, date: cursor, targetDate }, 'bulk solar day stored')
      cursor = dayjs(cursor).subtract(1, 'day').format('YYYY-MM-DD')
      if (cursor >= targetDate) await pause(1000)
    }

    const periodResult = await collectHistoricalPeriods(db, logger, current.stationId, targetDate)
    total.stationRows += periodResult.stationRows
    logger.info({ ...total, targetDate }, 'bulk solar done')
  } catch (error) {
    logger.error({ ...total, error: error.message, failedAt: cursor, targetDate }, 'bulk solar failed')
  }
}

export const solarBulk = async ({ db, logger, query }) => {
  const missing = missingSolarEnv(DEVICE_ID)
  if (missing) return Response.json({ error: missing, success: false }, { status: 500 })

  const targetDate = query.date
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(targetDate) && dayjs(targetDate).format('YYYY-MM-DD') === targetDate
  if (!validDate || targetDate > bkkDate()) {
    return Response.json({ error: 'date query param must be a valid past/current date (YYYY-MM-DD)', success: false }, { status: 400 })
  }

  void runBulk(db, logger, targetDate)
  return new Response(null, { status: 202 })
}
