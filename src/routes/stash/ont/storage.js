const integer = (value) => {
  if (value == null || value === '' || !['number', 'string'].includes(typeof value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const upsert = async (db, table, rows, keys, fields) => {
  if (!rows.length) return
  await db
    .insertInto(table)
    .values(rows)
    .onConflict((conflict) =>
      conflict.columns(keys).doUpdateSet((eb) => Object.fromEntries(fields.map((field) => [field, eb.ref(`excluded.${field}`)]))),
    )
    .execute()
}

/** Caller owns the transaction, including the per-ONT advisory lock. */
export const storeSnapshot = async (db, hosts, ag, collection) => {
  const { id, recorded_at, source } = collection
  const devices = []
  const addresses = []
  const stats = []
  for (const host of hosts) {
    const mac = host.MACAddress.toUpperCase()
    let hostname = host.HostName || host.DevName || ''
    if (!hostname || hostname.toLowerCase() === 'unknown') hostname = ag.names.get(host.IPAddress) || hostname
    devices.push({
      device_type: host.DeviceType || null,
      first_seen: recorded_at,
      hostname: hostname || null,
      last_seen: recorded_at,
      mac,
      source,
    })
    if (host.IPAddress)
      addresses.push({
        address_source: host.AddressSource || null,
        ip: host.IPAddress,
        lease_remaining: integer(host.LeaseTimeRemaining),
        mac,
        source,
        updated_at: recorded_at,
      })
    stats.push({
      active: Number(host.Active) === 1,
      collection_id: id,
      dns_queries: integer(ag.q.get(host.IPAddress)),
      ip: host.IPAddress || null,
      link_type: host.LinkType || host.ExInterface || host.Layer2Interface || null,
      mac,
      online_time: integer(host.OnlineTime),
      recorded_at,
      rssi: integer(host.rssi),
      rx_rate: integer(host.rx_rate),
      source,
      tx_rate: integer(host.tx_rate),
    })
  }
  await db.insertInto('stash.ont_collections').values(collection).execute()
  await upsert(db, 'stash.ont_devices', devices, ['source', 'mac'], ['device_type', 'hostname', 'last_seen'])
  await upsert(db, 'stash.ont_addresses', addresses, ['source', 'mac', 'ip'], ['address_source', 'lease_remaining', 'updated_at'])
  if (stats.length) await db.insertInto('stash.ont_stats').values(stats).execute()
}
