import { sql } from 'kysely'

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable('stash.lottery').execute()
  await db.schema.dropTable('stash.gold').execute()
  await db.schema.dropTable('stash.cinema_showing').execute()
  await sql`DROP SCHEMA IF EXISTS stash`.execute(db)
}

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`CREATE SCHEMA IF NOT EXISTS stash`.execute(db)

  await db.schema
    .createTable('stash.cinema_showing')
    .ifNotExists()
    .addColumn('s_bind', 'varchar(200)')
    .addColumn('s_display', 'text', (col) => col.notNull())
    .addColumn('s_name_en', 'text', (col) => col.notNull())
    .addColumn('s_name_th', 'text', (col) => col.notNull())
    .addColumn('s_url', 'text', (col) => col.notNull())
    .addColumn('n_time', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('n_week', 'integer', (col) => col.notNull())
    .addColumn('n_year', 'integer', (col) => col.notNull())
    .addColumn('o_theater', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'`))
    .addColumn('s_cover', 'text', (col) => col.notNull())
    .addColumn('s_genre', 'varchar(40)', (col) => col.notNull())
    .addColumn('t_release', 'timestamptz', (col) => col.notNull())
    .addUniqueConstraint('uq_cinema_name', ['s_bind', 'n_week', 'n_year'])
    .execute()

  await db.schema
    .createTable('stash.gold')
    .ifNotExists()
    .addColumn('tin', 'numeric', (col) => col.defaultTo(0))
    .addColumn('tin_ico', 'varchar(4)')
    .addColumn('tout', 'numeric', (col) => col.defaultTo(0))
    .addColumn('tout_ico', 'varchar(4)')
    .addColumn('usd_buy', 'numeric', (col) => col.defaultTo(0))
    .addColumn('usd_sale', 'numeric', (col) => col.defaultTo(0))
    .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .execute()

  await sql`CREATE INDEX IF NOT EXISTS uq_updated_at ON stash.gold (updated_at)`.execute(db)

  await db.schema
    .createTable('stash.lottery')
    .ifNotExists()
    .addColumn('draw', 'date', (col) => col.primaryKey())
    .addColumn('first_prize', 'varchar(6)', (col) => col.notNull())
    .addColumn('front_three', sql`varchar(3)[]`)
    .addColumn('back_three', sql`varchar(3)[]`)
    .addColumn('back_two', sql`varchar(2)[]`)
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .execute()
}
