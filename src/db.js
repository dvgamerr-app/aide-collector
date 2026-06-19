import { Kysely, sql } from 'kysely'
import { PostgresJSDialect } from 'kysely-postgres-js'
import { FileMigrationProvider, Migrator } from 'kysely/migration'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
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
  logger.info(` - database '${parseDatabaseUrl(connString).database}' connected`)
}

export async function destroy() {
  await db.destroy()
  logger.info('Database disconnected')
}

export async function migrate() {
  const { error, results } = await getMigrator().migrateToLatest()
  logResults(results)
  if (error) throw error
  logger.info(` - database '${parseDatabaseUrl(connString).database}' migrated`)
}

export async function migrateDown() {
  const { error, results } = await getMigrator().migrateDown()
  logResults(results)
  if (error) throw error
  logger.info(` - database '${parseDatabaseUrl(connString).database}' rolled back`)
}

function getMigrator() {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      migrationFolder: path.join(import.meta.dirname, 'migrations'),
      path,
    }),
  })
}

function logResults(results) {
  for (const r of results ?? []) {
    if (r.status === 'Success') logger.info(` - migration '${r.migrationName}' applied`)
    if (r.status === 'Error') logger.error(` - migration '${r.migrationName}' failed`)
  }
}
