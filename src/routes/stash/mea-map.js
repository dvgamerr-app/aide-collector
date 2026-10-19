const BILL_NO_LENGTH = 11

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

// MEA field -> stash.mea_electric column; every one is a number that defaults to 0.
const ELECTRIC_NUMBERS = {
  amountGenerate: 'amount_generate',
  amountUsed: 'amount_used',
  amountUsedSolar: 'amount_used_solar',
  income: 'income',
  kwh: 'kwh',
  kwhOff: 'kwh_off',
  kwhOn: 'kwh_on',
  paid: 'paid',
  unitGenerate: 'unit_generate',
  unitUsed: 'unit_used',
  unitUsedSolar: 'unit_used_solar',
}

export const mapMeaElectric = (ca, consumeList) =>
  consumeList.map((c) => ({
    ...Object.fromEntries(Object.entries(ELECTRIC_NUMBERS).map(([field, column]) => [column, parseFloat(c[field]) || 0])),
    bill_date: c.billBookUsed?.slice(0, 10) || null, // keep the calendar date as-is, no timezone shift
    bill_no: c.billNo == null ? null : String(c.billNo),
    bill_no_normalized: normalizeMeaBillNo(c.billNo),
    bill_period: c.billPeriod,
    ca,
    month: c.month,
  }))
