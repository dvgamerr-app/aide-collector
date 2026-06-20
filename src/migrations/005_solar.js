import { sql } from 'kysely'

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable('stash.solar_record').execute()
}

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // ponytail: generic attribute timeseries. The endpoint returns a variable set of attribute keys per
  // device, so EAV (attr, value, recorded_at) avoids guessing/churning columns. No i18n names/units
  // stored — only the canonical attribute key. Wide table later if the attribute set proves fixed.
  await db.schema
    .createTable('stash.solar_record')
    .ifNotExists()
    .addColumn('device_id', 'varchar(20)', (col) => col.notNull())
    .addColumn('attr', 'varchar(60)', (col) => col.notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.notNull())
    .addColumn('value', 'numeric')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('pk_solar_record', ['device_id', 'attr', 'recorded_at'])
    .execute()

  // time-range scans across all attributes of a device
  await sql`CREATE INDEX IF NOT EXISTS ix_solar_record_time ON stash.solar_record (device_id, recorded_at)`.execute(db)
}
