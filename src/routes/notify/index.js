import { Elysia } from 'elysia'

import { notifyCinema } from './cinema'

const route = new Elysia({ prefix: '/notify' })

route.post('/cinema', notifyCinema, {
  detail: {
    description:
      "Push this week's now-showing movies as a LINE flex carousel to the popcorn bot chat. Call from cron on Monday (full week) and Thursday (only movies added since Monday, based on Bangkok server time).",
    summary: 'Notify cinema showing',
    tags: ['Notify'],
  },
})

export default route
