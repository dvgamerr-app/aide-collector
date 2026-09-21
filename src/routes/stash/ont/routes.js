import { sourceId } from './client'

/** Latest complete snapshot; old addresses and disappeared hosts are not presented as current. */
export const ontLatest = async ({ db }) => {
  const source = sourceId()
  const collection = await db
    .selectFrom('stash.ont_collections')
    .selectAll()
    .where('source', '=', source)
    .orderBy('recorded_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  if (!collection) return { collection: null, devices: [], source, success: true }
  const devices = await db
    .selectFrom('stash.ont_stats as stats')
    .innerJoin('stash.ont_devices as devices', (join) =>
      join.onRef('devices.source', '=', 'stats.source').onRef('devices.mac', '=', 'stats.mac'),
    )
    .leftJoin('stash.ont_addresses as addresses', (join) =>
      join.onRef('addresses.source', '=', 'stats.source').onRef('addresses.mac', '=', 'stats.mac').onRef('addresses.ip', '=', 'stats.ip'),
    )
    .selectAll('stats')
    .select(['devices.hostname', 'devices.device_type', 'devices.first_seen', 'devices.last_seen'])
    .select(['addresses.lease_remaining', 'addresses.address_source'])
    .where('stats.collection_id', '=', collection.id)
    .orderBy('stats.mac')
    .execute()
  return { collection, devices, source, success: true }
}

export const ontHistory = async ({ db, params, query }) => {
  const to = query.to ? new Date(query.to) : new Date()
  const from = query.from ? new Date(query.from) : new Date(+to - 86400000)
  if (!Number.isFinite(+from) || !Number.isFinite(+to) || from > to || +to - +from > 31 * 86400000)
    return Response.json({ error: 'Use valid from/to timestamps with a range of at most 31 days', success: false }, { status: 400 })
  const limit = query.limit ?? 500
  const source = sourceId()
  const samples = await db
    .selectFrom('stash.ont_stats')
    .selectAll()
    .where('source', '=', source)
    .where('mac', '=', params.mac.toUpperCase())
    .where('recorded_at', '>=', from)
    .where('recorded_at', '<=', to)
    .orderBy('recorded_at', 'desc')
    .limit(limit + 1)
    .execute()
  return { from, has_more: samples.length > limit, samples: samples.slice(0, limit), source, success: true, to }
}
