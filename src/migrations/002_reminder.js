import { sql } from 'kysely'

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable('reminder').execute()
}

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable('reminder')
    .ifNotExists()
    .addColumn('name', 'varchar(20)', (col) => col.primaryKey())
    .addColumn('note', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'`))
    .execute()
}
