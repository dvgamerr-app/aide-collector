import { sql } from 'kysely'

const TABLE = sql`"stash"."cinema_showing"`

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`DROP INDEX IF EXISTS stash.idx_cinema_showing_name_th`.execute(db)
  await sql`DROP INDEX IF EXISTS stash.idx_cinema_showing_name_en`.execute(db)
  await sql`DROP INDEX IF EXISTS stash.idx_cinema_showing_week`.execute(db)
  await sql`ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS "t_updated"`.execute(db)
  await sql`ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS "s_section"`.execute(db)
  await sql`ALTER TABLE ${TABLE} ALTER COLUMN "o_theater" SET DEFAULT '[]'::jsonb`.execute(db)
  await sql`ALTER TABLE ${TABLE} ALTER COLUMN "s_genre" TYPE varchar(40)`.execute(db)
}

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // Coming-soon titles are published without a release date; storing them must not fail.
  await sql`ALTER TABLE ${TABLE} ALTER COLUMN "t_release" DROP NOT NULL`.execute(db)

  // Full genre lists such as 'Action / Animation / Drama' overflow the original varchar(40).
  await sql`ALTER TABLE ${TABLE} ALTER COLUMN "s_genre" TYPE varchar(120)`.execute(db)

  // o_theater maps a theater chain to its cover/url, but the column defaulted to a JSON array.
  // An array breaks jsonb_each() and turns the '||' merge into array concatenation.
  await sql`UPDATE ${TABLE} SET "o_theater" = '{}'::jsonb WHERE jsonb_typeof("o_theater") <> 'object'`.execute(db)
  await sql`ALTER TABLE ${TABLE} ALTER COLUMN "o_theater" SET DEFAULT '{}'::jsonb`.execute(db)

  await sql`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "s_section" varchar(20) NOT NULL DEFAULT 'showing'`.execute(db)
  await sql`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "t_updated" timestamptz NOT NULL DEFAULT now()`.execute(db)

  // De-duplication and the /collector/cinema week filter both read by (year, week).
  await sql`CREATE INDEX IF NOT EXISTS idx_cinema_showing_week ON ${TABLE} (n_year, n_week)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_cinema_showing_name_en ON ${TABLE} (n_year, n_week, lower(s_name_en))`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_cinema_showing_name_th ON ${TABLE} (n_year, n_week, lower(s_name_th))`.execute(db)
}
