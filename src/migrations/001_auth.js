import { sql } from 'kysely'

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable('api_keys').execute()
}

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable('api_keys')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.generatedByDefaultAsIdentity().primaryKey())
    .addColumn('description', 'varchar(255)')
    .addColumn('api_key', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('expires_at', 'timestamptz')
    .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
}
