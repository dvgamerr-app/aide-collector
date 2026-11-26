import dayjs from 'dayjs'

import { alreadyRunning, startExclusive } from '../../../background-job'
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
const CURRENT_DEADLINE_MS = 24_000

const bkkDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date())
const bkkTime = (milliseconds) => new Date(milliseconds + 7 * 3600e3).toISOString().replace(/\.\d{3}Z$/, '+07:00')
const dayBound = (date) => `${date}T00:00:00+07:00`
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const trailing = (hours) => [bkkTime(Date.now() - hours * 3600e3), bkkTime(Date.now() + 5 * 60e3)]

const mapPayloads = (deviceId, payloads, mapper) => payloads.flatMap((payload) => mapper(deviceId, payload))

const dedupeRecords = (rows) => [...new Map(rows.map((row) => [`${row.device_id}\u0000${row.attr}\u0000${row.recorded_at}`, row])).values()]

const readSource = async (name, request, failedSources, logger) => {
  try {
    return await request
  } catch (error) {
    failedSources.push(name)
    logger.warn({ error: error.message, source: name }, 'Solar source unavailable')
    return undefined
  }
}

const currentStationRows = async (token, stationId, date, signal, read) => {
  const month = date.slice(0, 7)
  const year = date.slice(0, 4)
  const categories = [
    ['category_daily', fetchStationCategoryDaily(token, stationId, date, signal)],
    ['category_monthly', fetchStationCategoryMonthly(token, stationId, month, signal)],
    ['category_yearly', fetchStationCategoryYearly(token, stationId, year, signal)],
  ]
  const generation = [
    ['generated_monthly', fetchStationGeneratedMonthly(token, stationId, month, signal)],
    ['generated_yearly', fetchStationGeneratedYearly(token, stationId, year, signal)],
    ['generated_total', fetchStationGeneratedTotal(token, stationId, signal)],
  ]
  const rows = await Promise.all([
    ...categories.map(async ([name, request]) => mapCategorySummary(stationId, name, await read(name, request))),
    ...generation.map(async ([name, request]) => mapGeneratedSummary(stationId, name, await read(name, request))),
  ])
  return rows.flat()
}

export const collectCurrent = async ({ db, deviceId, fromTime, logger, signal, token, toTime }) => {
  const observedAt = new Date().toISOString()
  const date = bkkDate()
  const details = await fetchDeviceDetails(token, deviceId, signal)
  const stationId = details?.stationId == null ? null : String(details.stationId)
  if (!stationId) throw new Error('device details did not include stationId')

  const failedSources = []
  const read = (name, request) => readSource(name, request, failedSources, logger)
  const deviceSnapshots = await insertSolarDeviceSnapshot(db, mapDeviceSnapshot(details, observedAt))
  const [recordHistory, keyHistory] = await Promise.all([
    read('recordHistory', fetchRecordHistory(token, deviceId, fromTime, toTime, signal)),
    read('keyHistory', fetchKeyHistory(token, deviceId, fromTime, toTime, signal)),
  ])
  const historyRows = dedupeRecords([
    ...mapPayloads(deviceId, keyHistory?.payloads ?? [], mapKeyHistoryPayload),
    ...mapPayloads(deviceId, recordHistory?.payloads ?? [], mapRecordPayload),
  ])
  if (historyRows.length) await db.transaction().execute((transaction) => upsertSolarRecords(transaction, historyRows))

  const [alarms, latestState, energyFlow, configs, stationRows] = await Promise.all([
    read('alarms', fetchAlarms(token, deviceId, signal)),
    read('latestState', fetchLatestState(token, deviceId, signal)),
    read('energyFlow', fetchEnergyFlow(token, deviceId, signal)),
    read('configs', fetchConfigs(token, deviceId, signal)),
    currentStationRows(token, stationId, date, signal, read),
  ])

  const stateRows = dedupeRecords([
    ...mapStatePayload(deviceId, latestState, 'latest_state'),
    ...mapStatePayload(deviceId, energyFlow?.deviceAttributeState, 'energy_flow_state'),
  ])
  const counts = await db.transaction().execute(async (transaction) => {
    await upsertSolarRecords(transaction, stateRows)
    return {
      alarms: await upsertSolarAlarms(transaction, mapAlarms(alarms ?? [], observedAt)),
      configSnapshots: await insertSolarConfigSnapshots(transaction, mapConfigSnapshots(deviceId, configs, observedAt)),
      deviceSnapshots,
      energyFlowSnapshots: await upsertSolarEnergyFlow(transaction, mapEnergyFlow(deviceId, energyFlow, observedAt)),
      latestStateSnapshots: await upsertSolarLatestState(transaction, deviceId, latestState, observedAt),
      stationSummaryRows: await upsertSolarStationSummaries(transaction, stationRows),
      telemetryRows: dedupeRecords([...historyRows, ...stateRows]).length,
    }
  })

  return {
    counts,
    failedSources: failedSources.sort(),
    points: { keyHistory: keyHistory?.points ?? 0, recordHistory: recordHistory?.points ?? 0 },
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

const HISTORY_PERIODS = [
  {
    category: fetchStationCategoryMonthly,
    categoryType: 'category_monthly',
    format: 'YYYY-MM',
    generated: fetchStationGeneratedMonthly,
    generatedType: 'generated_monthly',
    unit: 'month',
  },
  {
    category: fetchStationCategoryYearly,
    categoryType: 'category_yearly',
    format: 'YYYY',
    generated: fetchStationGeneratedYearly,
    generatedType: 'generated_yearly',
    unit: 'year',
  },
]

const collectHistoricalPeriods = async (db, logger, stationId, targetDate) => {
  const currentDate = bkkDate()
  const total = { stationRows: 0 }

  for (const { category: fetchCategory, categoryType, format, generated: fetchGenerated, generatedType, unit } of HISTORY_PERIODS) {
    const last = dayjs(currentDate).startOf(unit)
    for (let period = dayjs(targetDate).startOf(unit); !period.isAfter(last, unit); period = period.add(1, unit)) {
      const token = await getSolarToken(db)
      const value = period.format(format)
      const [category, generated] = await Promise.all([
        fetchCategory(token.accessToken, stationId, value),
        fetchGenerated(token.accessToken, stationId, value),
      ])
      const rows = [...mapCategorySummary(stationId, categoryType, category), ...mapGeneratedSummary(stationId, generatedType, generated)]
      total.stationRows += await upsertSolarStationSummaries(db, rows)
      logger.info(`bulk solar station ${unit} ${value}: ${rows.length} rows`)
      await pause(250)
    }
  }

  const token = await getSolarToken(db)
  const generatedTotal = await fetchStationGeneratedTotal(token.accessToken, stationId)
  total.stationRows += await upsertSolarStationSummaries(db, mapGeneratedSummary(stationId, 'generated_total', generatedTotal))
  return total
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
    const signal = AbortSignal.timeout(CURRENT_DEADLINE_MS)
    const token = await getSolarToken(db, signal)
    const [fromTime, toTime] = trailing(hours)
    const collected = await collectCurrent({ db, deviceId: DEVICE_ID, fromTime, logger, signal, token: token.accessToken, toTime })
    logger.info(
      { ...collected.counts, ...collected.points, failedSources: collected.failedSources },
      `solar: collection finished (last ${hours}h)`,
    )
    result = {
      body: { counts: collected.counts, failedSources: collected.failedSources, points: collected.points, success: true },
      status: 200,
    }
  } catch (error) {
    logger.error({ error: error.message }, 'Error collecting solar')
    result = { body: { error: error.message, success: false }, status: 500 }
  }

  return Response.json(result.body, { status: result.status })
}

const runBulk = async (db, logger, targetDate) => {
  let cursor = bkkDate()
  const total = { keyPoints: 0, recordPoints: 0, stationRows: 0, telemetryRows: 0 }

  try {
    const firstToken = await getSolarToken(db)
    const [fromTime, toTime] = trailing(LOOKBACK_HOURS)
    const current = await collectCurrent({ db, deviceId: DEVICE_ID, fromTime, logger, token: firstToken.accessToken, toTime })

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

  const started = startExclusive(
    'solar bulk',
    () => runBulk(db, logger, targetDate),
    (error) => logger.error({ error: error.message }, 'bulk solar crashed'),
  )
  return started ? new Response(null, { status: 202 }) : alreadyRunning('solar bulk')
}
