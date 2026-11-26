import { logger } from '../../../config'
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

const errorCode = (error) => error.code ?? error.cause?.code
const retryable = (error, signal) => !signal?.aborted && ['ECONNRESET', 'SOLAR_TIMEOUT'].includes(errorCode(error))
const elapsed = (started) => Math.round(performance.now() - started)

const requestOnce = async (path, options, signal) => {
  const timeout = AbortSignal.timeout(5_000)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    requestSignal.throwIfAborted()
    const response = await fetch(`${BASE}${path}`, { ...options, signal: requestSignal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const envelope = await response.json()
    if (envelope.code !== 0) throw new Error(`upstream code ${envelope.code}`)
    return envelope.data
  } catch (error) {
    if (timeout.aborted) throw Object.assign(new Error('request timeout', { cause: error }), { code: 'SOLAR_TIMEOUT' })
    throw error
  }
}

const request = async (path, options, signal, retry = false) => {
  const endpoint = path.split('?')[0]
  const started = performance.now()
  try {
    return await requestOnce(path, options, signal).catch((error) => {
      if (!retry || !retryable(error, signal)) throw error
      logger.warn({ elapsedMs: elapsed(started), endpoint, error: errorCode(error) }, 'retrying Solar API request')
      return requestOnce(path, options, signal)
    })
  } catch (error) {
    const reason = signal?.aborted ? 'collection deadline reached' : errorCode(error) || error.message
    throw new Error(`${options.method} ${endpoint} failed after ${elapsed(started)}ms: ${reason}`, { cause: error })
  }
}

const openPost = (path, body, signal) => {
  const headers = { ...COMMON, 'IOT-Token': 'null', ...openSign({ appId: APP_ID, body, encSecret: APP_SECRET, method: 'POST' }) }
  return request(path, { body, headers, method: 'POST' }, signal)
}

const apiRequest = (path, token, method, signal, body) =>
  request(
    path,
    {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { ...COMMON, 'IOT-Token': token },
      method,
    },
    signal,
    true,
  )

const get = (path, token, signal) => apiRequest(path, token, 'GET', signal)
const post = (path, token, body, signal) => apiRequest(path, token, 'POST', signal, body)

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

const login = async (db, signal) => storeToken(db, await openPost('/login/account', atob(PAYLOAD), signal))

const refresh = async (db, token, signal) =>
  storeToken(
    db,
    await openPost(
      '/login/refresh/access/token',
      JSON.stringify({ accessToken: token.accessToken, refreshToken: token.refreshToken }),
      signal,
    ),
  )

export const getSolarToken = async (db, signal) => {
  const token = await getReminder(db, 'solar_token')
  const now = Date.now() + 60_000
  if (!token) return login(db, signal)
  if (token.accessExpire > now) return token
  if (token.refreshExpire > now) {
    try {
      return await refresh(db, token, signal)
    } catch (error) {
      // Falling back to a fresh login hides why the refresh failed, so leave a trace of it.
      logger.warn({ error: error.message }, 'solar token refresh failed, logging in again')
      return login(db, signal)
    }
  }
  return login(db, signal)
}

const fetchColumnarHistory = async (path, token, deviceId, { fromTime, toTime }, signal) => {
  const payloads = []
  let points = 0

  for (let page = 1; page <= 500; page++) {
    const data = await post(
      path,
      token,
      {
        count: PAGE_SIZE,
        deviceId,
        fromTime,
        orderByTimeAsc: false,
        page,
        toTime,
      },
      signal,
    )
    const payload = data?.payload || {}
    const got = payload.timeSeries?.length || 0
    if (got) payloads.push(payload)
    points += got

    const totalPages = Number(data?.total)
    if ((Number.isFinite(totalPages) && page >= totalPages) || (!Number.isFinite(totalPages) && got < PAGE_SIZE)) break
  }

  return { payloads, points }
}

export const fetchRecordHistory = (token, deviceId, fromTime, toTime, signal) =>
  fetchColumnarHistory('/deviceState/simple/attribute/record/list/v1', token, deviceId, { fromTime, toTime }, signal)

export const fetchKeyHistory = (token, deviceId, fromTime, toTime, signal) =>
  fetchColumnarHistory('/deviceState/simple/attribute/keys/history/v1', token, deviceId, { fromTime, toTime }, signal)

export const fetchAlarms = async (token, deviceId, signal) => {
  const alarms = []
  const count = 100

  for (let page = 1; page <= 500; page++) {
    const data = await post('/alarm/query/list', token, { count, deviceId, page }, signal)
    const list = data?.list || []
    alarms.push(...list)

    const totalPages = Number(data?.total)
    if ((Number.isFinite(totalPages) && page >= totalPages) || (!Number.isFinite(totalPages) && list.length < count)) break
  }

  return alarms
}

export const fetchLatestState = (token, deviceId, signal) =>
  get(`/deviceState/simple/state/latest/v1?deviceId=${encodeURIComponent(deviceId)}&dataSource=`, token, signal)

export const fetchDeviceDetails = (token, deviceId, signal) =>
  get(`/device/details?deviceId=${encodeURIComponent(deviceId)}`, token, signal)

export const fetchEnergyFlow = (token, deviceId, signal) =>
  get(`/deviceState/simple/energy/flow/v1?deviceId=${encodeURIComponent(deviceId)}&dataSource=`, token, signal)

export const fetchConfigs = (token, deviceId, signal) =>
  post(`/remote/device/configs/cache/get?deviceId=${encodeURIComponent(deviceId)}`, token, {}, signal)

const stationPath = (name, stationId, summaryCategoryKey) => {
  const query = new URLSearchParams({ stationId })
  if (summaryCategoryKey) query.set('summaryCategoryKey', summaryCategoryKey)
  return `/stationOverView/${name}?${query}`
}

export const fetchStationCategoryDaily = (token, stationId, date, signal) =>
  post(stationPath('stateAttributeSummary/category/daily', stationId, 'pvInverterPowerClass'), token, { time: date }, signal)

export const fetchStationCategoryMonthly = (token, stationId, month, signal) =>
  post(
    stationPath('stateAttributeSummary/category/monthly', stationId, 'pvInverterElectricityQuantityClass'),
    token,
    {
      time: month,
    },
    signal,
  )

export const fetchStationCategoryYearly = (token, stationId, year, signal) =>
  post(stationPath('stateAttributeSummary/category/yearly', stationId, 'pvInverterElectricityQuantityClass'), token, { time: year }, signal)

export const fetchStationGeneratedMonthly = (token, stationId, month, signal) =>
  post(stationPath('generatedEnergy/monthly', stationId), token, { time: month }, signal)

export const fetchStationGeneratedYearly = (token, stationId, year, signal) =>
  post(stationPath('generatedEnergy/yearly', stationId), token, { time: year }, signal)

export const fetchStationGeneratedTotal = (token, stationId, signal) =>
  post(stationPath('generatedEnergy/total', stationId), token, {}, signal)
