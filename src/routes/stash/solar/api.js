import { getReminder, setReminder } from '../../../reminders'
import { openSign } from './sign'

const ORIGIN = 'https://solar.siseli.com'
const BASE = `${ORIGIN}/apis`
const PAGE_SIZE = 300

const APP_ID = Bun.env.SOLAR_OPEN_APP_ID
const APP_SECRET = Bun.env.SOLAR_OPEN_APP_SECRET
const PAYLOAD = Bun.env.SOLAR_PAYLOAD

const COMMON = {
  Accept: 'application/json',
  'Accept-Language': 'en',
  'Content-Type': 'application/json; charset=utf-8',
  'IOT-Time-Zone': 'Asia/Bangkok',
  Origin: ORIGIN,
  Referer: `${ORIGIN}/`,
}

export const missingSolarEnv = (deviceId) => {
  const need = {
    SOLAR_DEVICE_ID: deviceId,
    SOLAR_OPEN_APP_ID: APP_ID,
    SOLAR_OPEN_APP_SECRET: APP_SECRET,
    SOLAR_PAYLOAD: PAYLOAD,
  }
  const missing = Object.keys(need).filter((key) => !need[key])
  return missing.length ? `missing env: ${missing.join(', ')}` : null
}

const responseJson = async (response, path) => {
  if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`)
  try {
    return await response.json()
  } catch {
    throw new Error(`${path} failed: invalid JSON response`)
  }
}

const openPost = async (path, body) => {
  const headers = { ...COMMON, 'IOT-Token': 'null', ...openSign({ appId: APP_ID, body, encSecret: APP_SECRET, method: 'POST' }) }
  const envelope = await responseJson(await fetch(`${BASE}${path}`, { body, headers, method: 'POST' }), path)
  if (envelope.code !== 0) throw new Error(`${path} failed: code ${envelope.code} ${envelope.message || envelope.msg || ''}`)
  return envelope.data
}

const apiRequest = async (path, token, method = 'GET', body) => {
  const response = await fetch(`${BASE}${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { ...COMMON, 'IOT-Token': token },
    method,
  })
  const envelope = await responseJson(response, path)
  if (envelope.code !== 0) throw new Error(`${path} failed: code ${envelope.code} ${envelope.message || envelope.msg || ''}`)
  return envelope.data
}

const get = (path, token) => apiRequest(path, token)
const post = (path, token, body = {}) => apiRequest(path, token, 'POST', body)

const storeToken = async (db, data) => {
  const token = {
    accessExpire: data.accessTokenWillExpiredAt,
    accessToken: data.accessToken,
    refreshExpire: data.refreshTokenWillExpiredAt,
    refreshToken: data.refreshToken,
  }
  await setReminder(db, 'solar_token', token)
  return token
}

const login = async (db) => storeToken(db, await openPost('/login/account', atob(PAYLOAD)))

const refresh = async (db, token) =>
  storeToken(
    db,
    await openPost('/login/refresh/access/token', JSON.stringify({ accessToken: token.accessToken, refreshToken: token.refreshToken })),
  )

export const getSolarToken = async (db) => {
  const token = await getReminder(db, 'solar_token')
  const now = Date.now() + 60_000
  if (!token) return login(db)
  if (token.accessExpire > now) return token
  if (token.refreshExpire > now) {
    try {
      return await refresh(db, token)
    } catch {
      return login(db)
    }
  }
  return login(db)
}

const fetchColumnarHistory = async (path, token, deviceId, fromTime, toTime) => {
  const payloads = []
  let points = 0

  for (let page = 1; page <= 500; page++) {
    const data = await post(path, token, {
      count: PAGE_SIZE,
      deviceId,
      fromTime,
      orderByTimeAsc: false,
      page,
      toTime,
    })
    const payload = data?.payload || {}
    const got = payload.timeSeries?.length || 0
    if (got) payloads.push(payload)
    points += got

    const totalPages = Number(data?.total)
    if ((Number.isFinite(totalPages) && page >= totalPages) || (!Number.isFinite(totalPages) && got < PAGE_SIZE)) break
  }

  return { payloads, points }
}

export const fetchRecordHistory = (token, deviceId, fromTime, toTime) =>
  fetchColumnarHistory('/deviceState/simple/attribute/record/list/v1', token, deviceId, fromTime, toTime)

export const fetchKeyHistory = (token, deviceId, fromTime, toTime) =>
  fetchColumnarHistory('/deviceState/simple/attribute/keys/history/v1', token, deviceId, fromTime, toTime)

export const fetchAlarms = async (token, deviceId) => {
  const alarms = []
  const count = 100

  for (let page = 1; page <= 500; page++) {
    const data = await post('/alarm/query/list', token, { count, deviceId, page })
    const list = data?.list || []
    alarms.push(...list)

    const totalPages = Number(data?.total)
    if ((Number.isFinite(totalPages) && page >= totalPages) || (!Number.isFinite(totalPages) && list.length < count)) break
  }

  return alarms
}

export const fetchLatestState = (token, deviceId) =>
  get(`/deviceState/simple/state/latest/v1?deviceId=${encodeURIComponent(deviceId)}&dataSource=`, token)

export const fetchDeviceDetails = (token, deviceId) => get(`/device/details?deviceId=${encodeURIComponent(deviceId)}`, token)

export const fetchEnergyFlow = (token, deviceId) =>
  get(`/deviceState/simple/energy/flow/v1?deviceId=${encodeURIComponent(deviceId)}&dataSource=`, token)

export const fetchConfigs = (token, deviceId) => post(`/remote/device/configs/cache/get?deviceId=${encodeURIComponent(deviceId)}`, token)

const stationPath = (name, stationId, summaryCategoryKey) => {
  const query = new URLSearchParams({ stationId })
  if (summaryCategoryKey) query.set('summaryCategoryKey', summaryCategoryKey)
  return `/stationOverView/${name}?${query}`
}

export const fetchStationCategoryDaily = (token, stationId, date) =>
  post(stationPath('stateAttributeSummary/category/daily', stationId, 'pvInverterPowerClass'), token, { time: date })

export const fetchStationCategoryMonthly = (token, stationId, month) =>
  post(stationPath('stateAttributeSummary/category/monthly', stationId, 'pvInverterElectricityQuantityClass'), token, {
    time: month,
  })

export const fetchStationCategoryYearly = (token, stationId, year) =>
  post(stationPath('stateAttributeSummary/category/yearly', stationId, 'pvInverterElectricityQuantityClass'), token, { time: year })

export const fetchStationGeneratedMonthly = (token, stationId, month) =>
  post(stationPath('generatedEnergy/monthly', stationId), token, { time: month })

export const fetchStationGeneratedYearly = (token, stationId, year) =>
  post(stationPath('generatedEnergy/yearly', stationId), token, { time: year })

export const fetchStationGeneratedTotal = (token, stationId) => post(stationPath('generatedEnergy/total', stationId), token)
