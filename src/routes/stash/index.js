import { Elysia, t } from 'elysia'

import { cinema } from './cinema'
import { gold } from './gold'
import { lottery, lotteryBulk } from './lottery'
import { mea } from './mea'
import { solar, solarBulk } from './solar'

const route = new Elysia({ prefix: '/stash' })

route.patch('/gold', gold, {
  detail: { description: 'Fetch current gold spot price and store it.', summary: 'Stash gold price', tags: ['Stash'] },
})
route.post('/cinema', cinema, {
  detail: { description: 'Upsert cinema showing data and de-duplicate entries.', summary: 'Stash cinema showing', tags: ['Stash'] },
})
route.patch('/lottery', lottery, {
  detail: { description: 'Fetch latest lottery draw from Thairath and upsert.', summary: 'Stash lottery', tags: ['Stash'] },
})
route.patch('/mea', mea, {
  detail: {
    description: 'fetch member meters and electric bill history, and store them.',
    summary: 'Stash MEA electric',
    tags: ['Stash'],
  },
})
route.patch('/lottery/bulk', lotteryBulk, {
  detail: {
    description: 'Fetch all lottery draws from today back to the given date (sequential, 1 req/s).',
    summary: 'Stash lottery bulk',
    tags: ['Stash'],
  },
  query: t.Object({ date: t.String({ description: 'Target date YYYY-MM-DD to backfill to', examples: ['2025-01-01'] }) }),
})
route.patch('/solar', solar, {
  detail: {
    description: 'Fetch solar device attribute timeseries (yesterday + today) and upsert.',
    summary: 'Stash solar production',
    tags: ['Stash'],
  },
})
route.patch('/solar/bulk', solarBulk, {
  detail: {
    description: 'Backfill solar attribute timeseries from today back to the given date (sequential, 1 req/s/day).',
    summary: 'Stash solar bulk',
    tags: ['Stash'],
  },
  query: t.Object({ date: t.String({ description: 'Target date YYYY-MM-DD to backfill to', examples: ['2025-01-01'] }) }),
})

export default route
