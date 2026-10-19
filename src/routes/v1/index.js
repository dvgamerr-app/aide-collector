import { Elysia, t } from 'elysia'

import { coding } from './coding'
import { exchangeRates } from './exchange'
import { repositories } from './github'
import { handle } from './http'
import { codingDays, telemetry } from './waka'

const rangeQuery = t.Object({
  from: t.Optional(t.String({ description: 'First day YYYY-MM-DD (Asia/Bangkok), default 364 days before to', examples: ['2025-10-17'] })),
  to: t.Optional(t.String({ description: 'Last day YYYY-MM-DD (Asia/Bangkok, inclusive), default today', examples: ['2026-10-17'] })),
})

const route = new Elysia({ prefix: '/v1' })

route.get('/coding', handle(coding), {
  detail: {
    description:
      'Portfolio coding summary: total/average/best coding time, hour-of-day and weekday distribution (WakaTime) and repositories, commits, LOC and languages (GitHub).',
    summary: 'Get coding summary',
    tags: ['v1'],
  },
})

route.get('/repositories', handle(repositories), {
  detail: {
    description: 'Public, non-fork GitHub repositories of the portfolio owners, most starred first.',
    summary: 'List repositories',
    tags: ['v1'],
  },
  query: t.Object({
    cursor: t.Optional(t.String({ description: 'nextCursor of the previous page' })),
    fork: t.Optional(t.String({ description: 'Set to true to include forks' })),
    limit: t.Optional(t.String({ description: 'Page size, 1-500, default 100', examples: ['100'] })),
    owner: t.Optional(t.String({ description: 'Comma separated owners', examples: ['dvgamerr-app,untirkx'] })),
    sort: t.Optional(t.String({ description: 'stars (default), pushed or name', examples: ['stars'] })),
  }),
})

route.get(
  '/telemetry',
  handle(({ query }) => telemetry(query)),
  {
    detail: {
      description: 'Work type and AI-assisted coding report (categories, AI/human lines, sessions, models, tokens) for the date window.',
      summary: 'Get telemetry',
      tags: ['v1'],
    },
    query: rangeQuery,
  },
)

route.get(
  '/coding/days',
  handle(({ query }) => codingDays(query)),
  {
    detail: {
      description: 'Seconds coded per day, split by category, for every day of the window (zero days included).',
      summary: 'Get coding time per day',
      tags: ['v1'],
    },
    query: rangeQuery,
  },
)

route.get('/exchange-rates', handle(exchangeRates), {
  detail: {
    description: 'Rate of each currency in ccy expressed in the quote currency (cross-converted from per-USD rates collected from Yahoo).',
    summary: 'Get exchange rates',
    tags: ['v1'],
  },
  query: t.Object({
    ccy: t.Optional(t.String({ description: 'Comma separated currencies to price, default USD', examples: ['USD,JPY'] })),
    quote: t.Optional(t.String({ description: 'Currency the rates are expressed in, default THB', examples: ['THB'] })),
  }),
})

export default route
