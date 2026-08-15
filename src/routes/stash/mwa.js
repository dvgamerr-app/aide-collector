import { sql } from 'kysely'

import { getReminder, setReminder } from '../../reminders'

const ORIGIN = 'https://eservicesapp.mwa.co.th'
const LOGIN_URL = `${ORIGIN}/ESSecurity/v1/SecurityService/login`
const ACCOUNT_URL = `${ORIGIN}/ESUserAccount/v1/UserAccountInfoService/getUserAccountInfoReceipt`
const PAYLOAD = Bun.env.MWA_PAYLOAD
const ACCOUNT_CODES = (Bun.env.MWA_ACCOUNT_CODE || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

const request = async (url, init = {}) => {
  const options = {
    ...init,
    headers: {
      Accept: 'application/json',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/ES/`,
      ...(init.body && { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, options)
    } catch (error) {
      if (attempt >= 2) throw error
    }
  }
}

const setCookies = (headers) => {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const combined = headers.get('set-cookie')
  return combined ? [combined] : []
}

export const extractCookie = (headers, name) => {
  for (const cookie of setCookies(headers)) {
    const match = cookie.match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;]*)`, 'i'))
    if (match) return decodeURIComponent(match[1])
  }
  return null
}

export const jwtExpiry = (token) => {
  try {
    const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')
    const { exp } = JSON.parse(atob(padded))
    return Number.isFinite(Number(exp)) ? Number(exp) * 1000 : 0
  } catch {
    return 0
  }
}

export const parseMwaDate = (value) => {
  if (!value) return null
  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})$/)
  if (!match) return null

  const sourceYear = Number(match[1])
  const year = sourceYear >= 2400 ? sourceYear - 543 : sourceYear
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null

  return `${String(year).padStart(4, '0')}-${match[2]}-${match[3]}`
}

const gregorianYear = (value) => {
  const year = Number(value)
  if (!Number.isFinite(year)) return null
  return year >= 2400 ? year - 543 : year
}

const numeric = (value) => Number(value) || 0

export const mapMwaReceipts = (accountCode, receipts) =>
  (receipts || [])
    .filter((item) => item.billNumber && item.receiveCode != null && item.receiveSubCode != null)
    .map((item) => ({
      account_code: accountCode,
      balance_gross_amount: numeric(item.balanceGrossAmount),
      balance_meter_fee_amount: numeric(item.balanceMeterFeeAmount),
      balance_raw_amount: numeric(item.balanceRawAmount),
      balance_water_charge_amount: numeric(item.balanceWaterChargeAmount),
      bill_date: parseMwaDate(item.billDate),
      bill_due_date: parseMwaDate(item.billDueDate),
      bill_number: String(item.billNumber),
      collect_type: item.collectType || null,
      collect_type_description: item.collectTypeDesc || null,
      consumption: numeric(item.consumption),
      current_read_date: parseMwaDate(item.currReadDate),
      gross_amount: numeric(item.grossAmount),
      paid_amount: numeric(item.paidAmount),
      paid_date: parseMwaDate(item.paidDate),
      payment_flag: item.paymentFlag || null,
      period_month: Number(item.periodMonth) || null,
      period_year: gregorianYear(item.periodYear),
      receipt_number: item.receiptNumber || null,
      receive_code: String(item.receiveCode),
      receive_date: parseMwaDate(item.receiveDate),
      receive_description: item.receiveDesc || null,
      receive_ref_seq_number: Number(item.receiveRefSeqNumber) || null,
      receive_sub_code: Number(item.receiveSubCode),
      vat_amount: numeric(item.vatAmount),
      vat_rate: numeric(item.vatRate),
      vat_type: item.vatType || null,
    }))

const signin = async (db) => {
  let body
  try {
    body = JSON.parse(atob(PAYLOAD))
  } catch {
    throw new Error('MWA_PAYLOAD must be base64-encoded JSON')
  }
  if (!body?.userId || !body?.password) throw new Error('MWA_PAYLOAD must contain userId and password')

  const response = await request(LOGIN_URL, { body: JSON.stringify(body), method: 'POST' })
  if (!response.ok) throw new Error(`login failed: HTTP ${response.status}`)

  const token = extractCookie(response.headers, 'ACCTOKEN')
  if (!token) throw new Error('login failed: ACCTOKEN cookie was not returned')

  const expire = jwtExpiry(token)
  await setReminder(db, 'mwa_token', { expire, token })
  return token
}

const getToken = async (db) => {
  const cached = await getReminder(db, 'mwa_token')
  return cached?.expire > Date.now() + 60_000 ? cached.token : signin(db)
}

const fetchAccount = async (accountCode, token) =>
  request(`${ACCOUNT_URL}/${encodeURIComponent(accountCode)}`, {
    headers: { Cookie: `ACCTOKEN=${token}` },
  })

const upsertAccount = (db, account) =>
  db
    .insertInto('stash.mwa_account')
    .values({
      account_code: account.accountCode,
      branch_code: account.branchCode || null,
      branch_name: account.branchName || null,
      class_code: account.accountClassCode || null,
      class_description: account.accountClassDesc || null,
      meter_size_code: account.accountMeterSizeCode || null,
      meter_size_description: account.accountMeterSizeDesc || null,
      status_code: account.accountStatusCode || null,
      status_description: account.accountStatusDesc || null,
      zone: account.zone || null,
    })
    .onConflict((conflict) =>
      conflict.column('account_code').doUpdateSet({
        branch_code: account.branchCode || null,
        branch_name: account.branchName || null,
        class_code: account.accountClassCode || null,
        class_description: account.accountClassDesc || null,
        meter_size_code: account.accountMeterSizeCode || null,
        meter_size_description: account.accountMeterSizeDesc || null,
        status_code: account.accountStatusCode || null,
        status_description: account.accountStatusDesc || null,
        updated_at: sql`now()`,
        zone: account.zone || null,
      }),
    )
    .execute()

const upsertReceipts = async (db, accountCode, receipts) => {
  const values = mapMwaReceipts(accountCode, receipts)
  if (!values.length) return 0

  await db
    .insertInto('stash.mwa_water')
    .values(values)
    .onConflict((conflict) =>
      conflict.columns(['account_code', 'bill_number', 'receive_code', 'receive_sub_code']).doUpdateSet((eb) =>
        Object.fromEntries(
          Object.keys(values[0])
            .filter((key) => !['account_code', 'bill_number', 'receive_code', 'receive_sub_code'].includes(key))
            .map((key) => [key, eb.ref(`excluded.${key}`)]),
        ),
      ),
    )
    .execute()

  return values.length
}

export const mwa = async ({ db, logger }) => {
  if (!PAYLOAD) {
    return Response.json({ error: 'MWA_PAYLOAD (base64 of {userId,password}) is required', success: false }, { status: 500 })
  }
  if (!ACCOUNT_CODES.length) {
    return Response.json({ error: 'MWA_ACCOUNT_CODE is required', success: false }, { status: 500 })
  }

  try {
    let token = await getToken(db)
    let bills = 0

    for (const requestedAccountCode of ACCOUNT_CODES) {
      let response = await fetchAccount(requestedAccountCode, token)
      if (response.status === 401 || response.status === 403) {
        logger.info('mwa token rejected, signing in again')
        token = await signin(db)
        response = await fetchAccount(requestedAccountCode, token)
      }
      if (!response.ok) throw new Error(`account receipt failed: HTTP ${response.status}`)

      const result = await response.json()
      if (result.status !== 'OK' || !result.resultData)
        throw new Error(`account receipt failed: ${result.message || result.status || 'invalid response'}`)

      const account = result.resultData
      const accountCode = account.accountCode || requestedAccountCode
      await upsertAccount(db, { ...account, accountCode })
      bills += await upsertReceipts(db, accountCode, account.debtAccountReceivable)
    }

    logger.info(`mwa: ${ACCOUNT_CODES.length} accounts, ${bills} bills stored`)
    return Response.json({ accounts: ACCOUNT_CODES.length, bills, success: true })
  } catch (error) {
    logger.error({ error: error.message }, 'Error collecting mwa')
    return Response.json({ error: error.message, success: false }, { status: 500 })
  }
}
