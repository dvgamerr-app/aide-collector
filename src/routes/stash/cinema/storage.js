import { sql } from 'kysely'

const CHUNK_SIZE = 500
const CONFLICT_COLUMNS = ['s_bind', 'n_week', 'n_year']
const NAME_COLUMNS = ['s_name_en', 's_name_th']
const TABLE = sql`"stash"."cinema_showing"`

/** Keep the stored value when a chain reports a blank cover/url/genre for a movie another chain described. */
const keepNonEmpty = (column) => sql`COALESCE(NULLIF(excluded.${sql.ref(column)}, ''), ${TABLE}.${sql.ref(column)})`

/** Rows written before 009_cinema could hold a JSON array; '||' would concatenate instead of merging. */
const asObject = (reference) => sql`CASE WHEN jsonb_typeof(${reference}) = 'object' THEN ${reference} ELSE '{}'::jsonb END`

export const upsertCinemaShowings = async (db, rows) => {
  if (!rows?.length) return 0

  for (let index = 0; index < rows.length; index += CHUNK_SIZE) {
    const values = rows.slice(index, index + CHUNK_SIZE).map((row) => ({ ...row, o_theater: sql`${row.o_theater}::jsonb` }))

    await db
      .insertInto('stash.cinema_showing')
      .values(values)
      .onConflict((conflict) =>
        conflict.columns(CONFLICT_COLUMNS).doUpdateSet((eb) => ({
          n_time: sql`GREATEST(excluded."n_time", ${TABLE}."n_time")`,
          o_theater: sql`${asObject(sql`${TABLE}."o_theater"`)} || excluded."o_theater"`,
          s_cover: keepNonEmpty('s_cover'),
          s_display: eb.ref('excluded.s_display'),
          s_genre: keepNonEmpty('s_genre'),
          s_name_en: eb.ref('excluded.s_name_en'),
          s_name_th: eb.ref('excluded.s_name_th'),
          s_section: eb.ref('excluded.s_section'),
          s_url: keepNonEmpty('s_url'),
          t_release: sql`COALESCE(excluded."t_release", ${TABLE}."t_release")`,
          t_updated: sql`now()`,
        })),
      )
      .execute()
  }

  return rows.length
}

/**
 * Collapse rows of the same movie that were bound under different slugs, merging their theater maps.
 * Scoped to the week buckets the current batch touched, and expressed as one statement per name column
 * instead of the previous full-table scan plus one DELETE round-trip per duplicate.
 */
const mergeDuplicatesBy = async (db, column, scopes) => {
  const buckets = sql.join(scopes.map((scope) => sql`(${scope.year}, ${scope.week})`))
  const name = sql.ref(column)

  const { rows } = await sql`
    WITH scoped AS (
      SELECT
        s_bind, n_week, n_year, ${asObject(sql`o_theater`)} AS o_theater,
        first_value(s_bind) OVER (PARTITION BY n_year, n_week, lower(${name}) ORDER BY s_bind) AS keep_bind
      FROM ${TABLE}
      WHERE (n_year, n_week) IN (${buckets}) AND COALESCE(${name}, '') <> ''
    ),
    duplicate AS (
      SELECT * FROM scoped WHERE s_bind <> keep_bind
    ),
    merged AS (
      SELECT d.keep_bind, d.n_week, d.n_year, jsonb_object_agg(entry.key, entry.value) AS o_theater
      FROM duplicate d, LATERAL jsonb_each(d.o_theater) entry
      GROUP BY d.keep_bind, d.n_week, d.n_year
    ),
    applied AS (
      UPDATE ${TABLE} c
      SET o_theater = m.o_theater || ${asObject(sql`c.o_theater`)}, t_updated = now()
      FROM merged m
      WHERE c.s_bind = m.keep_bind AND c.n_week = m.n_week AND c.n_year = m.n_year
      RETURNING 1
    )
    DELETE FROM ${TABLE} c
    USING duplicate d
    WHERE c.s_bind = d.s_bind AND c.n_week = d.n_week AND c.n_year = d.n_year
    RETURNING c.s_bind
  `.execute(db)

  return rows.length
}

export const weekScopes = (rows) => [
  ...new Map((rows || []).map((row) => [`${row.n_year}-${row.n_week}`, { week: row.n_week, year: row.n_year }])).values(),
]

export const mergeCinemaDuplicates = async (db, scopes) => {
  if (!scopes?.length) return 0

  let removed = 0
  for (const column of NAME_COLUMNS) removed += await mergeDuplicatesBy(db, column, scopes)
  return removed
}

export const storeCinemaShowings = async (db, rows) =>
  db.transaction().execute(async (transaction) => {
    const stored = await upsertCinemaShowings(transaction, rows)
    const removed = await mergeCinemaDuplicates(transaction, weekScopes(rows))
    return { removed, stored }
  })
