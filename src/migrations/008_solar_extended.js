import { sql } from 'kysely'

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable('stash.solar_station_summary').execute()
  await db.schema.dropTable('stash.solar_config_snapshot').execute()
  await db.schema.dropTable('stash.solar_energy_flow').execute()
  await db.schema.dropTable('stash.solar_latest_state').execute()
  await db.schema.dropTable('stash.solar_device_snapshot').execute()
  await db.schema.dropTable('stash.solar_alarm').execute()

  await db.schema
    .alterTable('stash.solar_record')
    .dropColumn('updated_at')
    .dropColumn('source')
    .dropColumn('name_display')
    .dropColumn('unit')
    .dropColumn('value_display')
    .dropColumn('value_text')
    .execute()
}

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // The two history APIs return both numbers and strings. Preserve the existing numeric column for
  // analytical queries and add the source representation/metadata without rewriting existing rows.
  await db.schema
    .alterTable('stash.solar_record')
    .addColumn('value_text', 'text')
    .addColumn('value_display', 'text')
    .addColumn('unit', 'varchar(40)')
    .addColumn('name_display', 'varchar(160)')
    .addColumn('source', 'varchar(32)', (col) => col.notNull().defaultTo('record_list'))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createTable('stash.solar_alarm')
    .addColumn('alarm_id', 'varchar(32)', (col) => col.primaryKey())
    .addColumn('device_id', 'varchar(32)', (col) => col.notNull())
    .addColumn('station_id', 'varchar(32)')
    .addColumn('alarm_key', 'varchar(120)', (col) => col.notNull())
    .addColumn('category', 'integer')
    .addColumn('level', 'integer')
    .addColumn('status', 'integer')
    .addColumn('name', 'varchar(200)')
    .addColumn('description', 'text')
    .addColumn('fired_at', 'timestamptz', (col) => col.notNull())
    .addColumn('cleared_at', 'timestamptz')
    .addColumn('fired_value', 'text')
    .addColumn('cleared_value', 'text')
    .addColumn('is_read', 'boolean')
    .addColumn('is_processed', 'boolean')
    .addColumn('raw', 'jsonb', (col) => col.notNull())
    .addColumn('collected_at', 'timestamptz', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await sql`CREATE INDEX ix_solar_alarm_device_time ON stash.solar_alarm (device_id, fired_at DESC)`.execute(db)
  await sql`CREATE INDEX ix_solar_alarm_active ON stash.solar_alarm (device_id, alarm_key) WHERE cleared_at IS NULL`.execute(db)

  // Details has no history endpoint, so retain one immutable snapshot per collection time.
  await db.schema
    .createTable('stash.solar_device_snapshot')
    .addColumn('device_id', 'varchar(32)', (col) => col.notNull())
    .addColumn('observed_at', 'timestamptz', (col) => col.notNull())
    .addColumn('station_id', 'varchar(32)')
    .addColumn('serial_number', 'varchar(120)')
    .addColumn('name', 'varchar(240)')
    .addColumn('station_name', 'varchar(240)')
    .addColumn('manufacturer_name', 'varchar(240)')
    .addColumn('device_type', 'varchar(120)')
    .addColumn('device_sort_key', 'varchar(80)')
    .addColumn('model', 'varchar(120)')
    .addColumn('software_version', 'varchar(120)')
    .addColumn('state', 'integer')
    .addColumn('state_label', 'varchar(80)')
    .addColumn('rated_power', 'numeric')
    .addColumn('producing_power', 'numeric')
    .addColumn('total_produced_quantity', 'numeric')
    .addColumn('daily_produced_quantity', 'numeric')
    .addColumn('is_online', 'boolean')
    .addColumn('is_alarmed', 'boolean')
    .addColumn('is_upgrading', 'boolean')
    .addColumn('installed_at', 'timestamptz')
    .addColumn('last_online_at', 'timestamptz')
    .addColumn('last_offline_at', 'timestamptz')
    .addColumn('last_data_at', 'timestamptz')
    .addColumn('raw', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('pk_solar_device_snapshot', ['device_id', 'observed_at'])
    .execute()

  await db.schema
    .createTable('stash.solar_latest_state')
    .addColumn('device_id', 'varchar(32)', (col) => col.notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.notNull())
    .addColumn('raw', 'jsonb', (col) => col.notNull())
    .addColumn('collected_at', 'timestamptz', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('pk_solar_latest_state', ['device_id', 'recorded_at'])
    .execute()

  await db.schema
    .createTable('stash.solar_energy_flow')
    .addColumn('device_id', 'varchar(32)', (col) => col.notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.notNull())
    .addColumn('pv_power', 'numeric')
    .addColumn('grid_power', 'numeric')
    .addColumn('battery_power', 'numeric')
    .addColumn('battery_soc', 'numeric')
    .addColumn('load_power', 'numeric')
    .addColumn('pv_direction', 'smallint')
    .addColumn('grid_direction', 'smallint')
    .addColumn('battery_direction', 'smallint')
    .addColumn('load_direction', 'smallint')
    .addColumn('raw', 'jsonb', (col) => col.notNull())
    .addColumn('collected_at', 'timestamptz', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('pk_solar_energy_flow', ['device_id', 'recorded_at'])
    .execute()

  // Config values can change. Sampling them keeps future change history even though the upstream API
  // only exposes the current cache and cannot backfill older configurations.
  await db.schema
    .createTable('stash.solar_config_snapshot')
    .addColumn('device_id', 'varchar(32)', (col) => col.notNull())
    .addColumn('config_key', 'varchar(120)', (col) => col.notNull())
    .addColumn('observed_at', 'timestamptz', (col) => col.notNull())
    .addColumn('value_numeric', 'numeric')
    .addColumn('value_text', 'text')
    .addColumn('value_display', 'text')
    .addColumn('unit', 'varchar(40)')
    .addColumn('name_display', 'varchar(200)')
    .addColumn('value_type', 'integer')
    .addColumn('value_type_label', 'varchar(80)')
    .addColumn('category', 'integer')
    .addColumn('raw', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('pk_solar_config_snapshot', ['device_id', 'config_key', 'observed_at'])
    .execute()

  // time_key preserves the upstream bucket exactly (half-hour, day, month or year); recorded_at is
  // the normalized Bangkok bucket start for time-range queries.
  await db.schema
    .createTable('stash.solar_station_summary')
    .addColumn('station_id', 'varchar(32)', (col) => col.notNull())
    .addColumn('source', 'varchar(40)', (col) => col.notNull())
    .addColumn('category_key', 'varchar(120)', (col) => col.notNull())
    .addColumn('attr', 'varchar(120)', (col) => col.notNull())
    .addColumn('time_key', 'varchar(32)', (col) => col.notNull())
    .addColumn('recorded_at', 'timestamptz')
    .addColumn('value', 'numeric')
    .addColumn('value_text', 'text')
    .addColumn('is_real_value', 'boolean')
    .addColumn('name_display', 'varchar(200)')
    .addColumn('unit', 'varchar(40)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('pk_solar_station_summary', ['station_id', 'source', 'category_key', 'attr', 'time_key'])
    .execute()

  await sql`
    CREATE INDEX ix_solar_station_summary_time
    ON stash.solar_station_summary (station_id, recorded_at, attr)
    WHERE recorded_at IS NOT NULL
  `.execute(db)
}
