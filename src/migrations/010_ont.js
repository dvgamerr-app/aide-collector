import { sql } from 'kysely'

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable('stash.ont_stats').execute()
  await db.schema.dropTable('stash.ont_addresses').execute()
  await db.schema.dropTable('stash.ont_devices').execute()
  await db.schema.dropTable('stash.ont_collections').execute()
}

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable('stash.ont_collections')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('source', 'text', (col) => col.notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.notNull())
    .addColumn('host_count', 'integer', (col) => col.notNull())
    .addColumn('adguard_status', 'text', (col) => col.notNull())
    .execute()
  await sql`CREATE INDEX ix_ont_collections_source_time ON stash.ont_collections (source, recorded_at DESC)`.execute(db)

  await db.schema
    .createTable('stash.ont_devices')
    .addColumn('source', 'text', (col) => col.notNull())
    .addColumn('mac', 'text', (col) => col.notNull())
    .addColumn('hostname', 'text')
    .addColumn('device_type', 'text')
    .addColumn('first_seen', 'timestamptz', (col) => col.notNull())
    .addColumn('last_seen', 'timestamptz', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_ont_devices', ['source', 'mac'])
    .execute()

  await db.schema
    .createTable('stash.ont_addresses')
    .addColumn('source', 'text', (col) => col.notNull())
    .addColumn('mac', 'text', (col) => col.notNull())
    .addColumn('ip', 'text', (col) => col.notNull())
    .addColumn('lease_remaining', 'bigint')
    .addColumn('address_source', 'text')
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_ont_addresses', ['source', 'mac', 'ip'])
    .addForeignKeyConstraint('fk_ont_addresses_device', ['source', 'mac'], 'stash.ont_devices', ['source', 'mac'])
    .execute()

  await db.schema
    .createTable('stash.ont_stats')
    .addColumn('collection_id', 'uuid', (col) => col.notNull().references('stash.ont_collections.id').onDelete('cascade'))
    .addColumn('source', 'text', (col) => col.notNull())
    .addColumn('mac', 'text', (col) => col.notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.notNull())
    .addColumn('ip', 'text')
    .addColumn('active', 'boolean', (col) => col.notNull())
    .addColumn('link_type', 'text')
    .addColumn('online_time', 'bigint')
    .addColumn('rssi', 'integer')
    .addColumn('tx_rate', 'bigint')
    .addColumn('rx_rate', 'bigint')
    .addColumn('dns_queries', 'bigint')
    .addPrimaryKeyConstraint('pk_ont_stats', ['collection_id', 'mac'])
    .addForeignKeyConstraint('fk_ont_stats_device', ['source', 'mac'], 'stash.ont_devices', ['source', 'mac'])
    .execute()
  await sql`CREATE INDEX ix_ont_stats_device_time ON stash.ont_stats (source, mac, recorded_at DESC)`.execute(db)
}
