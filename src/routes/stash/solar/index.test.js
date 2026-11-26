import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely'

import { collectCurrent } from './index'

const time = '2026-11-26T07:43:27Z'
const data = new Map([
  ['/apis/device/details', { id: 'dev1', isOnline: true, lastDataAt: time, stationId: 'station1' }],
  ['/apis/deviceState/simple/attribute/keys/history/v1', { payload: { fields: { batterySOC: [65] }, timeSeries: [time] }, total: 1 }],
  [
    '/apis/deviceState/simple/attribute/record/list/v1',
    { payload: { fields: { generationPower: [{ vd: '2.4' }] }, timeSeries: [time] }, total: 1 },
  ],
  ['/apis/deviceState/simple/energy/flow/v1', { deviceAttributeState: { fields: { gridPower: { value: 0.2 } }, time } }],
  ['/apis/deviceState/simple/state/latest/v1', { fields: { loadPower: { value: 1.2 } }, time }],
  ['/apis/stationOverView/generatedEnergy/total', [{ generatedEnergy: 10, time: '2026' }]],
])

afterEach(() => mock.restore())

const fixture = () => {
  const queries = []
  const logger = { warn: mock() }
  const db = new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      if (event.level === 'query') queries.push(event.query)
    },
  })
  const writes = (table) => queries.filter((query) => query.sql.startsWith(`insert into "stash"."${table}"`))

  return {
    collect: (signal) =>
      collectCurrent({ db, deviceId: 'dev1', fromTime: time, logger, signal, token: 'test-token', toTime: time }).finally(() =>
        db.destroy(),
      ),
    logger,
    writes,
  }
}

const solarResponse = (url) => Response.json({ code: 0, data: data.get(new URL(url).pathname) ?? null })

it('commits the online snapshot and graph samples before a failing energy-flow request', async () => {
  const { collect, logger, writes } = fixture()
  let attempts = 0
  let coreCommitted = false
  spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (new URL(url).pathname !== '/apis/deviceState/simple/energy/flow/v1') return solarResponse(url)
    attempts++
    coreCommitted =
      writes('solar_device_snapshot').length === 1 && writes('solar_record').some((query) => query.parameters.includes('generationPower'))
    throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })
  })

  const result = await collect()

  expect(coreCommitted).toBe(true)
  expect(attempts).toBe(2)
  expect(result.failedSources).toEqual(['energyFlow'])
  expect(result.counts).toMatchObject({
    deviceSnapshots: 1,
    energyFlowSnapshots: 0,
    latestStateSnapshots: 1,
    stationSummaryRows: 1,
    telemetryRows: 3,
  })
  expect(writes('solar_device_snapshot')[0].parameters).toContain(time)
  expect(writes('solar_energy_flow')).toHaveLength(0)
  expect(logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.stringContaining('ECONNRESET'), source: 'energyFlow' }),
    'Solar source unavailable',
  )
})

it('keeps record history and successful station summaries when two other API requests fail', async () => {
  const { collect, writes } = fixture()
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = new URL(url).pathname
    if (path.endsWith('/keys/history/v1') || path.endsWith('/category/yearly')) return new Response(null, { status: 503 })
    return solarResponse(url)
  })

  const result = await collect()

  expect(fetch.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/category/yearly'))).toHaveLength(1)
  expect(result.failedSources).toEqual(['category_yearly', 'keyHistory'])
  expect(result.points).toEqual({ keyHistory: 0, recordHistory: 1 })
  expect(result.counts).toMatchObject({ deviceSnapshots: 1, energyFlowSnapshots: 1, stationSummaryRows: 1, telemetryRows: 3 })
  expect(writes('solar_station_summary')[0].parameters).toContain('generated_total')
})

it('cancels an in-flight slow source at the collection deadline without retrying', async () => {
  const { collect, writes } = fixture()
  const deadline = new AbortController()
  const pending = Promise.withResolvers()
  let attempts = 0
  spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (new URL(url).pathname !== '/apis/deviceState/simple/energy/flow/v1') return solarResponse(url)
    attempts++
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      pending.resolve()
    })
  })

  const result = collect(deadline.signal)
  await pending.promise
  deadline.abort(new DOMException('timed out', 'TimeoutError'))

  expect((await result).failedSources).toEqual(['energyFlow'])
  expect(attempts).toBe(1)
  expect(writes('solar_record')[0].parameters).toContain('generationPower')
})
