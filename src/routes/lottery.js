import { Elysia, t } from 'elysia'

const route = new Elysia({ prefix: '/lottery' })

route.get(
  '/',
  async ({ db, query }) => {
    return await db
      .selectFrom('stash.lottery')
      .select(['draw', 'first_prize', 'front_three', 'back_three', 'back_two'])
      .orderBy('draw desc')
      .limit(query.limit || 24)
      .execute()
  },
  {
    detail: {
      description: 'List lottery draw history (latest first).',
      summary: 'Get lottery history',
      tags: ['Lottery'],
    },
    query: t.Object({
      limit: t.Optional(t.Number({ default: 24, description: 'Max number of draws to return' })),
    }),
  },
)

export default route
