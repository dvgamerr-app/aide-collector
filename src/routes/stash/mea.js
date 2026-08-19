import { sql } from 'kysely'

import { getReminder, setReminder } from '../../reminders'

const ORIGIN = 'https://meaeservice.mea.or.th'
const BASE = `${ORIGIN}/api/v1`
const BILL_NO_LENGTH = 11
const PAYMENT_PAGE_SIZE = 100
// ponytail: base64-encoded JSON {"username","password"} so creds aren't sitting in env as plain text
const PAYLOAD = Bun.env.MEA_PAYLOAD

const nullableNumber = (value) => {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const dateOnly = (value) => {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/)
  return match?.[1] || null
}

export const normalizeMeaBillNo = (value) => {
  if (value == null) return null
  const billNo = String(value).trim()
  if (!billNo) return null
  return /^\d+$/.test(billNo) ? billNo.padStart(BILL_NO_LENGTH, '0') : billNo
}

export const getMeaPaymentPeriods = (consumeList) => {
  const periods = new Map()

  for (const bill of consumeList || []) {
    const match = String(bill.month || '').match(/^(\d{4})(0[1-9]|1[0-2])$/)
    if (!match) continue
    periods.set(`${match[1]}-${match[2]}`, { month: match[2], year: match[1] })
  }

  return [...periods.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, period]) => period)
}

export const mapMeaPayments = (paymentList) => {
  const payments = new Map()

  for (const payment of paymentList || []) {
    const billNo = payment.billNo == null ? null : String(payment.billNo).trim()
    const billNoNormalized = normalizeMeaBillNo(billNo)
    if (!billNoNormalized) continue

    const hasPaymentEvidence = Boolean(payment.paymentDate || payment.receiptNo)
    payments.set(billNoNormalized, {
      bill_no_normalized: billNoNormalized,
      paid_at: dateOnly(payment.paymentDate),
      payment_amount: nullableNumber(payment.amount),
      payment_bill_no: billNo,
      payment_channel: payment.channel || null,
      payment_channel_sap: payment.channelSap || null,
      payment_status: payment.paymentStatus == null ? (hasPaymentEvidence ? 'paid' : null) : String(payment.paymentStatus),
      receipt_no: payment.receiptNo == null ? null : String(payment.receiptNo),
    })
  }

  return [...payments.values()]
}

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

const fetchPaymentHistory = async (ca, ui, token, periods) => {
  const payments = []
  const filters = periods.length ? periods : [{ month: '', year: '' }]

  for (const filter of filters) {
    let received = 0
    for (let page = 0; ; page++) {
      const params = new URLSearchParams({
        ca,
        month: filter.month,
        page: String(page),
        size: String(PAYMENT_PAGE_SIZE),
        ui,
        year: filter.year,
      })
      const response = await api(`/payment/history?${params}`, token)
      if (!response.ok) {
        const period = filter.year ? ` ${filter.year}-${filter.month}` : ''
        throw new Error(`payment/history ${ca}${period} failed: HTTP ${response.status}`)
      }

      const result = await response.json()
      const list = Array.isArray(result.list) ? result.list : []
      payments.push(...list)
      received += list.length

      const total = Number(result.total)
      if (!list.length || !Number.isFinite(total) || received >= total) break
    }
  }

  return payments
}

const upsertElectric = async (db, ca, consumeList) => {
  const values = consumeList.map((c) => ({
    amount_generate: parseFloat(c.amountGenerate) || 0,
    amount_used: parseFloat(c.amountUsed) || 0,
    amount_used_solar: parseFloat(c.amountUsedSolar) || 0,
    bill_date: c.billBookUsed?.slice(0, 10) || null, // keep the calendar date as-is, no timezone shift
    bill_no: c.billNo == null ? null : String(c.billNo),
    bill_no_normalized: normalizeMeaBillNo(c.billNo),
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

const updatePayments = async (db, ca, paymentList) => {
  let updated = 0

  for (const payment of mapMeaPayments(paymentList)) {
    const result = await db
      .updateTable('stash.mea_electric')
      .set({
        paid_at: payment.paid_at,
        payment_amount: payment.payment_amount,
        payment_bill_no: payment.payment_bill_no,
        payment_channel: payment.payment_channel,
        payment_channel_sap: payment.payment_channel_sap,
        payment_status: payment.payment_status,
        payment_synced_at: sql`now()`,
        receipt_no: payment.receipt_no,
      })
      .where('ca', '=', ca)
      .where('bill_no_normalized', '=', payment.bill_no_normalized)
      .executeTakeFirst()

    updated += Number(result.numUpdatedRows || 0)
  }

  return updated
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
    let payments = 0
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
        const consumeList = (await elec.json()).data?.consumeList || []
        bills += await upsertElectric(db, m.ca, consumeList)

        // history/electric is a rolling window. Include periods already stored so older bills are
        // still backfilled after they disappear from the current MEA electric-history response.
        const storedPeriods = await db.selectFrom('stash.mea_electric').select('month').where('ca', '=', m.ca).execute()
        const periods = getMeaPaymentPeriods([...consumeList, ...storedPeriods])
        const paymentHistory = await fetchPaymentHistory(m.ca, m.ui, mToken, periods)
        payments += await updatePayments(db, m.ca, paymentHistory)
      }
      meters += list.length
    }

    logger.info(`mea: ${meters} meters, ${bills} bills and ${payments} payments stored`)
    return Response.json({ bills, meters, payments, success: true })
  } catch (error) {
    logger.error({ error: error.message }, 'Error collecting mea')
    return Response.json({ error: error.message, success: false }, { status: 500 })
  }
}
