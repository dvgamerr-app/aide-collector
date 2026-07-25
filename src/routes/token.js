import { randomUUID } from 'crypto'
import { Elysia, t } from 'elysia'

const getMasterKey = () => Bun.env.MASTER_KEY || process.env.MASTER_KEY
const unauthorizedResponse = () => new Response(null, { status: 401 })

export async function validateApiKey({ db, headers }) {
  const key = headers['x-api-key']?.trim()
  if (!key) return unauthorizedResponse()

  const masterKey = getMasterKey()
  if (masterKey && key === masterKey) return

  const record = await db.selectFrom('api_keys').selectAll().where('api_key', '=', key).limit(1).executeTakeFirst()
  if (!record) return unauthorizedResponse()
  if (!record.is_active) return new Response(null, { status: 401 })
  if (record.expires_at && Date.now() > +new Date(record.expires_at)) {
    await db.updateTable('api_keys').set({ is_active: false }).where('api_key', '=', key).execute()
    return unauthorizedResponse()
  }
}

const route = new Elysia({ prefix: '/v1' })

route.get(
  '/token',
  async ({ db }) => {
    const tokens = await db
      .selectFrom('api_keys')
      .select(['api_key', 'created_at', 'description', 'updated_at'])
      .where('is_active', '=', true)
      .execute()

    return tokens
  },
  {
    beforeHandle: validateApiKey,
    detail: { description: 'List active API tokens.', summary: 'List tokens', tags: ['Token'] },
  },
)

route.post(
  '/token',
  async ({ body, db }) => {
    const apiKey = `ak_${randomUUID().replace(/-/g, '')}`
    return await db
      .insertInto('api_keys')
      .values({ api_key: apiKey, description: body.description, expires_at: body.expiresAt ? new Date(body.expiresAt) : null })
      .returning(['api_key', 'created_at', 'description', 'expires_at'])
      .executeTakeFirst()
  },
  {
    beforeHandle: validateApiKey,
    body: t.Object({
      description: t.String({ description: 'description for the API token' }),
      expiresAt: t.Optional(t.String({ description: 'Optional expiration date in ISO format', format: 'date-time' })),
    }),
    detail: { description: 'Create a new API token.', summary: 'Create API token', tags: ['Token'] },
  },
)

route.delete(
  '/revoke',
  async ({ db, headers }) => {
    await db.updateTable('api_keys').set({ is_active: false }).where('api_key', '=', headers['x-api-key']).execute()
  },
  {
    beforeHandle: validateApiKey,
    detail: { description: "Revoke the caller's own API token (sets it inactive).", summary: 'Revoke token', tags: ['Token'] },
  },
)

export default route
