import { sql } from 'kysely'

import { getReminder, setReminder } from '../../reminders'

const ORIGIN = 'https://meaeservice.mea.or.th'
const BASE = `${ORIGIN}/api/v1`
// ponytail: base64-encoded JSON {"username","password"} so creds aren't sitting in env as plain text
const PAYLOAD = Bun.env.MEA_PAYLOAD

// ponytail: the F5 gateway occasionally resets the first connection (ECONNRESET); retry a couple of times
const api = async (path, token, init = {}) => {
  const opts = {
    ...init,
    headers: {
      Accept: 'application/json, text/plain, */*',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(init.body && { 'Content-Type': 'application/json' }),
    },
  }
  for (let i = 0; ; i++) {
    try {
      return await fetch(`${BASE}${path}`, opts)
    } catch (e) {
      if (i >= 2) throw e
    }
  }
}

const signin = async (db) => {
  const res = await api('/signin/member', null, { body: atob(PAYLOAD), method: 'POST' })
  if (!res.ok) throw new Error(`signin failed: HTTP ${res.status}`)
  const { expire, token } = await res.json()
  await setReminder(db, 'mea_token', { expire, token })
  return token
}

const upsertElectric = async (db, ca, consumeList) => {
  const values = consumeList.map((c) => ({
    amount_generate: parseFloat(c.amountGenerate) || 0,
    amount_used: parseFloat(c.amountUsed) || 0,
    amount_used_solar: parseFloat(c.amountUsedSolar) || 0,
    bill_date: c.billBookUsed?.slice(0, 10) || null, // keep the calendar date as-is, no timezone shift
    bill_no: c.billNo,
    bill_period: c.billPeriod,
    ca,
    income: parseFloat(c.income) || 0,
    kwh: parseFloat(c.kwh) || 0,
    kwh_off: parseFloat(c.kwhOff) || 0,
    kwh_on: parseFloat(c.kwhOn) || 0,
    month: c.month,
    paid: parseFloat(c.paid) || 0,
    unit_generate: parseFloat(c.unitGenerate) || 0,
    unit_used: parseFloat(c.unitUsed) || 0,
    unit_used_solar: parseFloat(c.unitUsedSolar) || 0,
  }))
  if (!values.length) return 0
  await db
    .insertInto('stash.mea_electric')
    .values(values)
    .onConflict((oc) =>
      oc.columns(['ca', 'month']).doUpdateSet((eb) =>
        Object.fromEntries(
          Object.keys(values[0])
            .filter((k) => k !== 'ca' && k !== 'month')
            .map((k) => [k, eb.ref(`excluded.${k}`)]),
        ),
      ),
    )
    .execute()
  return values.length
}

export const mea = async ({ db, logger }) => {
  if (!PAYLOAD) return Response.json({ error: 'MEA_PAYLOAD (base64 of {username,password}) is required', success: false }, { status: 500 })
  try {
    // reuse cached token (60s margin); sign in again only if it's gone/expired or the first call is rejected
    const cached = await getReminder(db, 'mea_token')
    let token = cached?.expire > Date.now() + 60_000 ? cached.token : await signin(db)

    let res = await api('/member/getlist/group', token)
    if (res.status === 401) {
      logger.info('mea token rejected, signing in again')
      token = await signin(db)
      res = await api('/member/getlist/group', token)
    }
    if (!res.ok) throw new Error(`getlist/group failed: HTTP ${res.status}`)

    // meters live per member identity (own member + any juristic legalEntities); switch token to each, then list its meters
    const { legalEntities, member } = await res.json()
    const identities = [member, ...(legalEntities || [])].filter((x) => x?.memberId)

    let meters = 0
    let bills = 0
    for (const idn of identities) {
      const sw = await api(`/authen/member/token/${idn.memberId}`, token, { body: '{}', method: 'PUT' })
      if (!sw.ok) throw new Error(`switch member ${idn.memberId} failed: HTTP ${sw.status}`)
      const mToken = (await sw.json()).token

      const mm = await api('/meter/member?page=0&size=100', mToken)
      if (!mm.ok) throw new Error(`meter/member failed: HTTP ${mm.status}`)
      const { list } = await mm.json()

      for (const m of list) {
        await db
          .insertInto('stash.mea_meter')
          .values({ alias: m.aliasMeter, ca: m.ca, ui: m.ui })
          .onConflict((oc) => oc.column('ca').doUpdateSet({ alias: m.aliasMeter, ui: m.ui, updated_at: sql`now()` }))
          .execute()

        const elec = await api('/history/electric', mToken, { body: JSON.stringify({ ca: m.ca, ui: m.ui }), method: 'POST' })
        if (!elec.ok) throw new Error(`history/electric ${m.ca} failed: HTTP ${elec.status}`)
        bills += await upsertElectric(db, m.ca, (await elec.json()).data?.consumeList || [])
      }
      meters += list.length
    }

    logger.info(`mea: ${meters} meters, ${bills} bills stored`)
    return Response.json({ bills, meters, success: true })
  } catch (error) {
    logger.error({ error: error.message }, 'Error collecting mea')
    return Response.json({ error: error.message, success: false }, { status: 500 })
  }
}
