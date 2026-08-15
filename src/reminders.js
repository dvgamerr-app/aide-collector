import { sql } from 'kysely'

import { parseJson } from './json'

export const getReminder = async (db, name) => {
  const row = await db.selectFrom('reminder').select('note').where('name', '=', name).executeTakeFirst()
  return row ? parseJson(row.note) : null
}

export const setReminder = async (db, name, value) => {
  const note = sql`${JSON.stringify(value)}::jsonb`
  await db
    .insertInto('reminder')
    .values({ name, note })
    .onConflict((oc) => oc.column('name').doUpdateSet({ note }))
    .execute()
}
