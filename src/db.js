import { Kysely, sql } from 'kysely'
import { PostgresJSDialect } from 'kysely-postgres-js'
import postgres from 'postgres'

import { logger, parseDatabaseUrl } from './config'

const connString = Bun.env.DATABASE_URL
if (!connString) throw new Error('DATABASE_URL environment variable is required')

const client = postgres(connString)

export const db = new Kysely({ dialect: new PostgresJSDialect({ postgres: client }) })

// kysely-postgres-js returns jsonb columns as raw strings; parse to objects on read.
export const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v)

export async function connect() {
  await sql`SELECT 1`.execute(db)
  const ddl = await Bun.file(new URL('./schema.sql', import.meta.url)).text()
  await client.unsafe(ddl)
  logger.info(` - database '${parseDatabaseUrl(connString).database}' connected`)
}

export async function destroy() {
  await db.destroy()
  logger.info('Database disconnected')
}
