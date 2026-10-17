import { sql } from 'kysely'

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable('stash.exchange_rate').execute()
  await db.schema.dropTable('stash.github_repo').execute()
}

/**
 * @param {import('kysely').Kysely} db
 *
 * Backing tables of the public /v1 API. `languages` is {language: bytes}; `commits`/`loc` stay NULL until the
 * GitHub collector has computed them for the revision recorded in `stat_pushed_at`. `per_usd` is how many units
 * of the currency one US dollar buys, so any pair can be cross-converted on read.
 */
export async function up(db) {
  await db.schema
    .createTable('stash.github_repo')
    .addColumn('full_name', 'text', (col) => col.primaryKey())
    .addColumn('owner', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('stars', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('url', 'text', (col) => col.notNull())
    .addColumn('is_private', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('is_fork', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('pushed_at', 'timestamptz')
    .addColumn('languages', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('commits', 'integer')
    .addColumn('loc', 'integer')
    .addColumn('stat_pushed_at', 'timestamptz')
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
  await sql`CREATE INDEX ix_github_repo_owner_stars ON stash.github_repo (owner, stars DESC)`.execute(db)

  await db.schema
    .createTable('stash.exchange_rate')
    .addColumn('ccy', 'text', (col) => col.primaryKey())
    .addColumn('per_usd', 'numeric(20, 8)', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
}
