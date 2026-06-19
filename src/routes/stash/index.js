import { Elysia } from 'elysia'

import { cinema } from './cinema'
import { gold } from './gold'

const route = new Elysia({ prefix: '/stash' })

route.patch('/gold', gold, {
  detail: { description: 'Fetch current gold spot price and store it.', summary: 'Stash gold price', tags: ['Stash'] },
})
route.post('/cinema', cinema, {
  detail: { description: 'Upsert cinema showing data and de-duplicate entries.', summary: 'Stash cinema showing', tags: ['Stash'] },
})

export default route
