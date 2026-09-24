import { sql } from 'kysely'

const TABLE = sql`"stash"."cinema_showing"`

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS "t_created"`.execute(db)
}

/**
 * @param {import('kysely').Kysely} db
 *
 * Never touched by the upsert's onConflict.doUpdateSet, so it records the moment a (s_bind, n_week, n_year)
 * row was first collected — the Thursday cinema notify uses it to tell newly added movies from ones already
 * sent out on Monday, without a separate "already notified" flag.
 */
export async function up(db) {
  await sql`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "t_created" timestamptz NOT NULL DEFAULT now()`.execute(db)
}
