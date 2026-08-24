import { Elysia, t } from 'elysia'

import { cinema } from './cinema'
import { gold } from './gold'
import { lottery, lotteryBulk } from './lottery'
import { mea } from './mea'
import { mwa } from './mwa'
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
    description: 'Fetch member meters, electric bill history and payment history, and store them.',
    summary: 'Stash MEA electric',
    tags: ['Stash'],
  },
})
route.patch('/mwa', mwa, {
  detail: {
    description: 'Fetch MWA account receipt history and upsert water bills.',
    summary: 'Stash MWA water bills',
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
    description:
      'Collect Solar history/latest state, alarms, device details, energy flow, config snapshots and station summaries (3-hour history by default).',
    summary: 'Stash all Solar data sources',
    tags: ['Stash'],
  },
  query: t.Object({ interval: t.Optional(t.String({ description: 'Trailing window such as 30m or 1h', examples: ['1h'] })) }),
})
route.patch('/solar/bulk', solarBulk, {
  detail: {
    description:
      'Backfill Solar record/key history and station daily/monthly/yearly summaries, then refresh all current-only data sources.',
    summary: 'Backfill Solar history',
    tags: ['Stash'],
  },
  query: t.Object({ date: t.String({ description: 'Target date YYYY-MM-DD to backfill to', examples: ['2025-01-01'] }) }),
})

export default route
