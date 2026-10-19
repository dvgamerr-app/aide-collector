import { sql } from 'kysely'

import { getReminder, setReminder } from '../../reminders'
import { updateFromExcluded } from '../../upsert'
import { getMeaPaymentPeriods, mapMeaElectric, mapMeaPayments } from './mea-map'

const ORIGIN = 'https://meaeservice.mea.or.th'
const BASE = `${ORIGIN}/api/v1`
const PAYMENT_PAGE_SIZE = 100
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

// Calls an endpoint that must succeed and returns its JSON body.
const apiJson = async (path, token, label, init) => {
  const res = await api(path, token, init)
  if (!res.ok) throw new Error(`${label} failed: HTTP ${res.status}`)
  return res.json()
}

const signin = async (db) => {
  const { expire, token } = await apiJson('/signin/member', null, 'signin', { body: atob(PAYLOAD), method: 'POST' })
  await setReminder(db, 'mea_token', { expire, token })
  return token
}

const fetchPaymentPeriod = async (ca, ui, token, { month, year }) => {
  const label = `payment/history ${ca}${year ? ` ${year}-${month}` : ''}`
  const payments = []

  for (let page = 0; ; page++) {
    const params = new URLSearchParams({ ca, month, page: String(page), size: String(PAYMENT_PAGE_SIZE), ui, year })
    const result = await apiJson(`/payment/history?${params}`, token, label)
    const list = Array.isArray(result.list) ? result.list : []
    payments.push(...list)

    const total = Number(result.total)
    if (!list.length || !Number.isFinite(total) || payments.length >= total) return payments
  }
}

const fetchPaymentHistory = async (ca, ui, token, periods) => {
  const payments = []
  for (const period of periods.length ? periods : [{ month: '', year: '' }]) {
    payments.push(...(await fetchPaymentPeriod(ca, ui, token, period)))
  }
  return payments
}

const upsertElectric = async (db, ca, consumeList) => {
  const values = mapMeaElectric(ca, consumeList)
  if (!values.length) return 0
  await db
    .insertInto('stash.mea_electric')
    .values(values)
    .onConflict((oc) => oc.columns(['ca', 'month']).doUpdateSet(updateFromExcluded(Object.keys(values[0]), ['ca', 'month'])))
    .execute()
  return values.length
}

const updatePayments = async (db, ca, paymentList) => {
  let updated = 0

  for (const { bill_no_normalized, ...payment } of mapMeaPayments(paymentList)) {
    const result = await db
      .updateTable('stash.mea_electric')
      .set({ ...payment, payment_synced_at: sql`now()` })
      .where('ca', '=', ca)
      .where('bill_no_normalized', '=', bill_no_normalized)
      .executeTakeFirst()

    updated += Number(result.numUpdatedRows || 0)
  }

  return updated
}

const collectMeter = async (db, token, m) => {
  await db
    .insertInto('stash.mea_meter')
    .values({ alias: m.aliasMeter, ca: m.ca, ui: m.ui })
    .onConflict((oc) => oc.column('ca').doUpdateSet({ alias: m.aliasMeter, ui: m.ui, updated_at: sql`now()` }))
    .execute()

  const electric = await apiJson('/history/electric', token, `history/electric ${m.ca}`, {
    body: JSON.stringify({ ca: m.ca, ui: m.ui }),
    method: 'POST',
  })
  const consumeList = electric.data?.consumeList || []
  const bills = await upsertElectric(db, m.ca, consumeList)

  // history/electric is a rolling window. Include periods already stored so older bills are
  // still backfilled after they disappear from the current MEA electric-history response.
  const storedPeriods = await db.selectFrom('stash.mea_electric').select('month').where('ca', '=', m.ca).execute()
  const periods = getMeaPaymentPeriods([...consumeList, ...storedPeriods])
  const payments = await updatePayments(db, m.ca, await fetchPaymentHistory(m.ca, m.ui, token, periods))
  return { bills, payments }
}

// Reuse the cached token (60s margin); sign in again only if it's gone/expired or the first call is rejected.
const fetchMemberGroup = async (db, logger) => {
  const cached = await getReminder(db, 'mea_token')
  let token = cached?.expire > Date.now() + 60_000 ? cached.token : await signin(db)

  let res = await api('/member/getlist/group', token)
  if (res.status === 401) {
    logger.info('mea token rejected, signing in again')
    token = await signin(db)
    res = await api('/member/getlist/group', token)
  }
  if (!res.ok) throw new Error(`getlist/group failed: HTTP ${res.status}`)
  return { group: await res.json(), token }
}

export const mea = async ({ db, logger }) => {
  if (!PAYLOAD) return Response.json({ error: 'MEA_PAYLOAD (base64 of {username,password}) is required', success: false }, { status: 500 })
  try {
    const { group, token } = await fetchMemberGroup(db, logger)

    // meters live per member identity (own member + any juristic legalEntities); switch token to each, then list its meters
    const identities = [group.member, ...(group.legalEntities || [])].filter((x) => x?.memberId)
    const total = { bills: 0, meters: 0, payments: 0 }

    for (const { memberId } of identities) {
      const { token: memberToken } = await apiJson(`/authen/member/token/${memberId}`, token, `switch member ${memberId}`, {
        body: '{}',
        method: 'PUT',
      })
      const { list } = await apiJson('/meter/member?page=0&size=100', memberToken, 'meter/member')

      for (const meter of list) {
        const { bills, payments } = await collectMeter(db, memberToken, meter)
        total.bills += bills
        total.payments += payments
      }
      total.meters += list.length
    }

    logger.info(`mea: ${total.meters} meters, ${total.bills} bills and ${total.payments} payments stored`)
    return Response.json({ ...total, success: true })
  } catch (error) {
    logger.error({ error: error.message }, 'Error collecting mea')
    return Response.json({ error: error.message, success: false }, { status: 500 })
  }
}
