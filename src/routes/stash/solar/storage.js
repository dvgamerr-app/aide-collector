import { sql } from 'kysely'

const jsonb = (value) => sql`${value}::jsonb`

export const upsertSolarRecords = async (db, rows) => {
  for (let index = 0; index < rows.length; index += 1000) {
    await db
      .insertInto('stash.solar_record')
      .values(rows.slice(index, index + 1000))
      .onConflict((conflict) =>
        conflict.columns(['device_id', 'attr', 'recorded_at']).doUpdateSet((eb) => ({
          name_display: eb.ref('excluded.name_display'),
          source: eb.ref('excluded.source'),
          unit: eb.ref('excluded.unit'),
          updated_at: sql`now()`,
          value: eb.ref('excluded.value'),
          value_display: eb.ref('excluded.value_display'),
          value_text: eb.ref('excluded.value_text'),
        })),
      )
      .execute()
  }
  return rows.length
}

export const upsertSolarAlarms = async (db, rows) => {
  if (!rows.length) return 0
  const values = rows.map((row) => ({ ...row, raw: jsonb(row.raw) }))

  await db
    .insertInto('stash.solar_alarm')
    .values(values)
    .onConflict((conflict) =>
      conflict.column('alarm_id').doUpdateSet((eb) => ({
        alarm_key: eb.ref('excluded.alarm_key'),
        category: eb.ref('excluded.category'),
        cleared_at: eb.ref('excluded.cleared_at'),
        cleared_value: eb.ref('excluded.cleared_value'),
        collected_at: eb.ref('excluded.collected_at'),
        description: eb.ref('excluded.description'),
        device_id: eb.ref('excluded.device_id'),
        fired_at: eb.ref('excluded.fired_at'),
        fired_value: eb.ref('excluded.fired_value'),
        is_processed: eb.ref('excluded.is_processed'),
        is_read: eb.ref('excluded.is_read'),
        level: eb.ref('excluded.level'),
        name: eb.ref('excluded.name'),
        raw: eb.ref('excluded.raw'),
        station_id: eb.ref('excluded.station_id'),
        status: eb.ref('excluded.status'),
        updated_at: sql`now()`,
      })),
    )
    .execute()

  return values.length
}

export const insertSolarDeviceSnapshot = async (db, row) => {
  await db
    .insertInto('stash.solar_device_snapshot')
    .values({ ...row, raw: jsonb(row.raw) })
    .onConflict((conflict) => conflict.columns(['device_id', 'observed_at']).doNothing())
    .execute()
  return 1
}

export const upsertSolarLatestState = async (db, deviceId, payload, collectedAt) => {
  if (!payload?.time) return 0
  await db
    .insertInto('stash.solar_latest_state')
    .values({ collected_at: collectedAt, device_id: deviceId, raw: jsonb(payload), recorded_at: payload.time })
    .onConflict((conflict) =>
      conflict.columns(['device_id', 'recorded_at']).doUpdateSet((eb) => ({
        collected_at: eb.ref('excluded.collected_at'),
        raw: eb.ref('excluded.raw'),
        updated_at: sql`now()`,
      })),
    )
    .execute()
  return 1
}

export const upsertSolarEnergyFlow = async (db, row) => {
  if (!row) return 0
  await db
    .insertInto('stash.solar_energy_flow')
    .values({ ...row, raw: jsonb(row.raw) })
    .onConflict((conflict) =>
      conflict.columns(['device_id', 'recorded_at']).doUpdateSet((eb) => ({
        battery_direction: eb.ref('excluded.battery_direction'),
        battery_power: eb.ref('excluded.battery_power'),
        battery_soc: eb.ref('excluded.battery_soc'),
        collected_at: eb.ref('excluded.collected_at'),
        grid_direction: eb.ref('excluded.grid_direction'),
        grid_power: eb.ref('excluded.grid_power'),
        load_direction: eb.ref('excluded.load_direction'),
        load_power: eb.ref('excluded.load_power'),
        pv_direction: eb.ref('excluded.pv_direction'),
        pv_power: eb.ref('excluded.pv_power'),
        raw: eb.ref('excluded.raw'),
        updated_at: sql`now()`,
      })),
    )
    .execute()
  return 1
}

export const insertSolarConfigSnapshots = async (db, rows) => {
  if (!rows.length) return 0
  const values = rows.map((row) => ({ ...row, raw: jsonb(row.raw) }))

  await db
    .insertInto('stash.solar_config_snapshot')
    .values(values)
    .onConflict((conflict) => conflict.columns(['device_id', 'config_key', 'observed_at']).doNothing())
    .execute()
  return values.length
}

export const upsertSolarStationSummaries = async (db, rows) => {
  if (!rows.length) return 0

  for (let index = 0; index < rows.length; index += 1000) {
    await db
      .insertInto('stash.solar_station_summary')
      .values(rows.slice(index, index + 1000))
      .onConflict((conflict) =>
        conflict.columns(['station_id', 'source', 'category_key', 'attr', 'time_key']).doUpdateSet((eb) => ({
          is_real_value: eb.ref('excluded.is_real_value'),
          name_display: eb.ref('excluded.name_display'),
          recorded_at: eb.ref('excluded.recorded_at'),
          unit: eb.ref('excluded.unit'),
          updated_at: sql`now()`,
          value: eb.ref('excluded.value'),
          value_text: eb.ref('excluded.value_text'),
        })),
      )
      .execute()
  }

  return rows.length
}
