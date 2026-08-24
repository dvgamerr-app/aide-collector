import { describe, expect, it } from 'bun:test'

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
  stationRecordedAt,
} from './mappers'

describe('Solar telemetry mappers', () => {
  it('keeps numeric history queryable and preserves non-numeric/leading-zero values', () => {
    const rows = mapRecordPayload('dev1', {
      fields: {
        batteryStatus: [{ vd: '011' }],
        firmwareVersion: [{ vd: 'V05.10-U' }],
        pv1Voltage: [{ vd: '508.5' }],
      },
      timeSeries: ['2026-08-24T03:39:44Z'],
    })

    expect(rows.find((row) => row.attr === 'pv1Voltage')).toMatchObject({ value: 508.5, value_text: null })
    expect(rows.find((row) => row.attr === 'batteryStatus')).toMatchObject({ value: 11, value_text: '011' })
    expect(rows.find((row) => row.attr === 'firmwareVersion')).toMatchObject({ value: null, value_text: 'V05.10-U' })
  })

  it('maps primitive key history and skips missing samples without shifting timestamps', () => {
    const rows = mapKeyHistoryPayload('dev1', {
      fields: { batteryWarning: ['0', '1'], PowerHardwareVersion: ['3CT.20_32A', null] },
      timeSeries: ['2026-08-24T03:39:44Z', '2026-08-24T03:34:43Z'],
    })

    expect(rows).toHaveLength(3)
    expect(rows.find((row) => row.attr === 'PowerHardwareVersion')).toMatchObject({
      recorded_at: '2026-08-24T03:39:44Z',
      value: null,
      value_text: '3CT.20_32A',
    })
    expect(rows.find((row) => row.attr === 'batteryWarning' && row.value === 1)?.recorded_at).toBe('2026-08-24T03:34:43Z')
  })

  it('maps latest state metadata and energy-flow values', () => {
    const payload = {
      deviceAttributeState: {
        fields: {
          batteryPower: { value: -1.2 },
          batterySOC: { value: 80 },
          firmwareVersion: { nameDisplay: 'Firmware Version', unit: '', value: 'V05.10-U', valueDisplay: 'V05.10-U' },
        },
        time: '2026-08-24T03:39:44Z',
      },
      gridFlow: { flowDirection: 2, value: { value: 0.3 } },
      loadFlow: { flowDirection: 2, value: { value: 1.5 } },
      pvPanelFlow: { flowDirection: 1, value: { value: 2.4 } },
    }

    expect(mapStatePayload('dev1', payload.deviceAttributeState).find((row) => row.attr === 'firmwareVersion')).toMatchObject({
      name_display: 'Firmware Version',
      source: 'latest_state',
      value_text: 'V05.10-U',
    })
    expect(mapEnergyFlow('dev1', payload, '2026-08-24T03:40:00Z')).toMatchObject({
      battery_power: -1.2,
      battery_soc: 80,
      grid_direction: 2,
      grid_power: 0.3,
      load_power: 1.5,
      pv_direction: 1,
      pv_power: 2.4,
    })
  })
})

describe('Solar snapshot mappers', () => {
  it('maps alarms, device details and config values to stable keys', () => {
    const observedAt = '2026-08-24T03:40:00Z'
    const alarms = mapAlarms(
      [
        {
          createdAt: '2026-08-23T14:43:40Z',
          deviceId: 'dev1',
          disappearedAt: '2026-08-24T03:17:05Z',
          firedValue: '1',
          id: 'alarm1',
          isProcessed: true,
          key: 'batteryNoConnected',
          level: 2,
          name: 'Battery No Connected',
          stationId: 'station1',
          status: 2,
        },
      ],
      observedAt,
    )
    expect(alarms[0]).toMatchObject({ alarm_id: 'alarm1', alarm_key: 'batteryNoConnected', cleared_at: '2026-08-24T03:17:05Z' })

    expect(
      mapDeviceSnapshot({ dailyProducedQuantity: 4.162, id: 'dev1', isOnline: true, ratedPower: 8, stationId: 'station1' }, observedAt),
    ).toMatchObject({ daily_produced_quantity: 4.162, device_id: 'dev1', is_online: true, rated_power: 8 })

    expect(
      mapConfigSnapshots(
        'dev1',
        { emergencySOC: { key: 'emergencySOC', unit: '%', value: 15, valueDisplay: '15', valueType: 1 } },
        observedAt,
      )[0],
    ).toMatchObject({ config_key: 'emergencySOC', value_numeric: 15, value_text: null })
  })

  it('normalizes station bucket times and keeps source/granularity separate', () => {
    expect(stationRecordedAt('2026-08-24 00:30:00')).toBe('2026-08-24T00:30:00+07:00')
    expect(stationRecordedAt('2026-08')).toBe('2026-08-01T00:00:00+07:00')
    expect(stationRecordedAt('2026')).toBe('2026-01-01T00:00:00+07:00')

    const categoryRows = mapCategorySummary('station1', 'category_monthly', {
      category: { key: 'pvInverterElectricityQuantityClass' },
      properties: [
        {
          property: { key: 'pvGeneratedEnergy', name: 'Energy Generated', unit: 'kWh' },
          timePoints: [{ isRealValue: true, time: '2026-08-01', value: 21.042 }],
        },
      ],
    })
    expect(categoryRows[0]).toMatchObject({
      attr: 'pvGeneratedEnergy',
      recorded_at: '2026-08-01T00:00:00+07:00',
      source: 'category_monthly',
      value: 21.042,
    })

    expect(mapGeneratedSummary('station1', 'generated_total', [{ generatedEnergy: 2102.526, time: '2026' }])[0]).toMatchObject({
      attr: 'generatedEnergy',
      source: 'generated_total',
      value: 2102.526,
    })
  })
})
