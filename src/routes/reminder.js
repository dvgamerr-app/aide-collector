import { Elysia, t } from 'elysia'
import { sql } from 'kysely'

const route = new Elysia({ prefix: '/reminder' })

route.post(
  '/gold',
  async ({ body, db }) => {
    await db
      .insertInto('reminder')
      .values({ name: 'gold', note: sql`${JSON.stringify(body)}::jsonb` })
      .onConflict((oc) => oc.column('name').doUpdateSet({ note: sql`${JSON.stringify(body)}::jsonb` }))
      .execute()

    return { success: true }
  },
  {
    body: t.Object({
      deposit: t.Number({ description: 'Total investment deposit', example: 100000, minimum: 0 }),
      gold96: t.Array(
        t.Object({
          cost: t.Number({ description: 'Total cost for 96% gold in local currency', example: 0, minimum: 0 }),
          kg: t.Number({ description: 'Number of kilograms purchased for 96% gold', example: 0, minimum: 0 }),
        }),
        { description: 'Array of 96% gold investment entries', example: [{ cost: 0, kg: 0 }], minItems: 0 },
      ),
      gold99: t.Array(
        t.Object({
          oz: t.Number({ description: 'Number of ounces purchased for 99% gold', example: 1, minimum: 0 }),
          usd: t.Number({ description: 'Cost per ounce in USD for 99% gold', example: 1, minimum: 0 }),
        }),
        { description: 'Array of 99% gold investment entries', example: [{ oz: 1, usd: 1 }], minItems: 0 },
      ),
      wallet: t.Number({ description: 'Current wallet balance', example: 10, minimum: 0 }),
    }),
    detail: { description: 'Update gold investment cost data.', summary: 'Update gold reminder', tags: ['Reminder'] },
  },
)

export default route
