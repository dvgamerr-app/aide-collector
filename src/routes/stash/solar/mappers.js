const optionalNumber = (value) => {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const optionalText = (value) => (value == null ? null : String(value))

const scalar = (raw, preserveString = false) => {
  const numeric = optionalNumber(raw)
  let text = null

  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (preserveString || numeric == null || (/^[+-]?0\d/.test(trimmed) && trimmed !== '0')) text = raw
  } else if (raw != null && typeof raw !== 'number') {
    text = typeof raw === 'object' ? JSON.stringify(raw) : String(raw)
  }

  return { numeric, text }
}

const fieldItem = (item) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    return {
      display: item.valueDisplay ?? item.vd ?? null,
      hidden: item.isHidden ?? null,
      name: item.nameDisplay ?? item.name ?? null,
      raw: item.value ?? item.v ?? item.vd ?? null,
      unit: item.unit ?? null,
    }
  }
  return { display: item == null ? null : String(item), hidden: null, name: null, raw: item, unit: null }
}

const mapColumnarPayload = (deviceId, payload, source, accessor) => {
  const rows = []
  const times = payload?.timeSeries || []

  for (const [attr, series] of Object.entries(payload?.fields || {})) {
    for (let index = 0; index < times.length; index++) {
      const item = accessor(series?.[index])
      if (item.raw == null) continue

      const { numeric, text } = scalar(item.raw)
      rows.push({
        attr,
        device_id: deviceId,
        name_display: item.name,
        recorded_at: times[index],
        source,
        unit: item.unit,
        value: numeric,
        value_display: item.display == null ? null : String(item.display),
        value_text: text,
      })
    }
  }

  return rows
}

export const mapRecordPayload = (deviceId, payload) => mapColumnarPayload(deviceId, payload, 'record_list', (item) => fieldItem(item))

export const mapKeyHistoryPayload = (deviceId, payload) =>
  mapColumnarPayload(deviceId, payload, 'key_history', (item) => ({
    display: item == null ? null : String(item),
    name: null,
    raw: item,
    unit: null,
  }))

export const mapStatePayload = (deviceId, payload, source = 'latest_state') => {
  const recordedAt = payload?.time
  if (!recordedAt) return []

  return Object.entries(payload?.fields || {}).map(([attr, original]) => {
    const item = fieldItem(original)
    const { numeric, text } = scalar(item.raw, typeof item.raw === 'string')
    return {
      attr,
      device_id: deviceId,
      name_display: item.name,
      recorded_at: recordedAt,
      source,
      unit: item.unit,
      value: numeric,
      value_display: item.display == null ? null : String(item.display),
      value_text: text,
    }
  })
}

export const mapAlarms = (alarms, collectedAt) =>
  (alarms || [])
    .filter((alarm) => alarm?.id != null && alarm?.deviceId != null && alarm?.key && alarm?.createdAt)
    .map((alarm) => ({
      alarm_id: String(alarm.id),
      alarm_key: alarm.key,
      category: optionalNumber(alarm.category),
      cleared_at: alarm.disappearedAt || null,
      cleared_value: optionalText(alarm.disappearedValue),
      collected_at: collectedAt,
      description: alarm.description || alarm.alarmRuleDescription || null,
      device_id: String(alarm.deviceId),
      fired_at: alarm.createdAt,
      fired_value: optionalText(alarm.firedValue),
      is_processed: alarm.isProcessed ?? null,
      is_read: alarm.isRead ?? null,
      level: optionalNumber(alarm.level),
      name: alarm.name || alarm.nameI18n?.en || null,
      raw: alarm,
      station_id: optionalText(alarm.stationId),
      status: optionalNumber(alarm.status),
    }))

export const mapDeviceSnapshot = (device, observedAt) => ({
  daily_produced_quantity: optionalNumber(device?.dailyProducedQuantity),
  device_id: String(device.id),
  device_sort_key: device.deviceSortKey || null,
  device_type: device.deviceTypeNumber || device.deviceSortLocaleText || null,
  installed_at: device.installedAt || null,
  is_alarmed: device.isAlarmed ?? null,
  is_online: device.isOnline ?? null,
  is_upgrading: device.isUpgrading ?? null,
  last_data_at: device.lastDataAt || null,
  last_offline_at: device.lastOfflineAt || null,
  last_online_at: device.lastOnlineAt || null,
  manufacturer_name: device.deviceManufacturerName || null,
  model: device.model || null,
  name: device.name || null,
  observed_at: observedAt,
  producing_power: optionalNumber(device.producingPower),
  rated_power: optionalNumber(device.ratedPower),
  raw: device,
  serial_number: device.serialNumber || null,
  software_version: device.softwareVersion || null,
  state: optionalNumber(device.state),
  state_label: device.stateDict || null,
  station_id: optionalText(device.stationId),
  station_name: device.stationName || null,
  total_produced_quantity: optionalNumber(device.totalProducedQuantity),
})

const direction = (flow) => optionalNumber(flow?.flowDirection)
const flowValue = (flow) => optionalNumber(flow?.value?.value)
const stateValue = (payload, attr) => optionalNumber(payload?.deviceAttributeState?.fields?.[attr]?.value)

export const mapEnergyFlow = (deviceId, payload, collectedAt) => {
  const recordedAt = payload?.deviceAttributeState?.time
  if (!recordedAt) return null

  return {
    battery_direction: direction(payload.batteryFlow),
    battery_power: stateValue(payload, 'batteryPower'),
    battery_soc: stateValue(payload, 'batterySOC'),
    collected_at: collectedAt,
    device_id: deviceId,
    grid_direction: direction(payload.gridFlow),
    grid_power: flowValue(payload.gridFlow),
    load_direction: direction(payload.loadFlow),
    load_power: flowValue(payload.loadFlow),
    pv_direction: direction(payload.pvPanelFlow),
    pv_power: flowValue(payload.pvPanelFlow),
    raw: payload,
    recorded_at: recordedAt,
  }
}

export const mapConfigSnapshots = (deviceId, configs, observedAt) =>
  Object.entries(configs || {}).map(([configKey, config]) => {
    const { numeric, text } = scalar(config?.value, typeof config?.value === 'string')
    return {
      category: optionalNumber(config?.category),
      config_key: config?.key || configKey,
      device_id: deviceId,
      name_display: config?.nameDisplay || config?.name || null,
      observed_at: observedAt,
      raw: config,
      unit: config?.unit || null,
      value_display: optionalText(config?.valueDisplay),
      value_numeric: numeric,
      value_text: text,
      value_type: optionalNumber(config?.valueType),
      value_type_label: config?.valueTypeDict || null,
    }
  })

export const stationRecordedAt = (value) => {
  const time = String(value || '')
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(time)) return `${time.replace(' ', 'T')}+07:00`
  if (/^\d{4}-\d{2}-\d{2}$/.test(time)) return `${time}T00:00:00+07:00`
  if (/^\d{4}-\d{2}$/.test(time)) return `${time}-01T00:00:00+07:00`
  if (/^\d{4}$/.test(time)) return `${time}-01-01T00:00:00+07:00`
  return null
}

export const mapCategorySummary = (stationId, source, summary) => {
  const categoryKey = summary?.category?.key || 'unknown'
  const rows = []

  for (const group of summary?.properties || []) {
    const property = group?.property || {}
    if (!property.key) continue

    for (const point of group.timePoints || []) {
      if (point?.time == null) continue
      const { numeric, text } = scalar(point.value)
      rows.push({
        attr: property.key,
        category_key: categoryKey,
        is_real_value: point.isRealValue ?? null,
        name_display: property.name || property.nameI18n?.en || null,
        recorded_at: stationRecordedAt(point.time),
        source,
        station_id: stationId,
        time_key: String(point.time),
        unit: property.unit || property.unitI18n?.en || null,
        value: numeric,
        value_text: text,
      })
    }
  }

  return rows
}

export const mapGeneratedSummary = (stationId, source, points) =>
  (points || [])
    .filter((point) => point?.time != null)
    .map((point) => {
      const { numeric, text } = scalar(point.generatedEnergy ?? point.value)
      return {
        attr: 'generatedEnergy',
        category_key: 'generatedEnergy',
        is_real_value: point.isRealValue ?? null,
        name_display: 'Generated Energy',
        recorded_at: stationRecordedAt(point.time),
        source,
        station_id: stationId,
        time_key: String(point.time),
        unit: 'kWh',
        value: numeric,
        value_text: text,
      }
    })
