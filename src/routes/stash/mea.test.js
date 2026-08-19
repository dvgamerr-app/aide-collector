import { describe, expect, it } from 'bun:test'

import { getMeaPaymentPeriods, mapMeaPayments, normalizeMeaBillNo } from './mea'

describe('MEA payment periods', () => {
  it('builds every distinct valid year and month from electric bill history', () => {
    expect(
      getMeaPaymentPeriods([{ month: '202607' }, { month: '202506' }, { month: '202607' }, { month: '202613' }, { month: null }]),
    ).toEqual([
      { month: '06', year: '2025' },
      { month: '07', year: '2026' },
    ])
  })
})

describe('MEA bill number normalization', () => {
  it('matches the same 11-digit bill number when one API omits leading zeroes', () => {
    expect(normalizeMeaBillNo('00702722382')).toBe('00702722382')
    expect(normalizeMeaBillNo('702722382')).toBe('00702722382')
  })

  it('keeps non-numeric identifiers unchanged', () => {
    expect(normalizeMeaBillNo(' BILL-001 ')).toBe('BILL-001')
    expect(normalizeMeaBillNo(null)).toBeNull()
  })
})

describe('MEA payment mapping', () => {
  it('keeps the payment bill number and infers paid from receipt evidence', () => {
    expect(
      mapMeaPayments([
        {
          amount: 3952.86,
          billNo: '00702722382',
          channel: 'ธ.กรุงเทพ',
          channelSap: 'AA',
          paymentDate: '2026-06-11T00:00:00',
          paymentStatus: null,
          receiptNo: 'O0601062933',
        },
      ]),
    ).toEqual([
      {
        bill_no_normalized: '00702722382',
        paid_at: '2026-06-11',
        payment_amount: 3952.86,
        payment_bill_no: '00702722382',
        payment_channel: 'ธ.กรุงเทพ',
        payment_channel_sap: 'AA',
        payment_status: 'paid',
        receipt_no: 'O0601062933',
      },
    ])
  })

  it('does not infer paid without a payment date or receipt number', () => {
    expect(mapMeaPayments([{ amount: null, billNo: '702722382', paymentStatus: null }])[0]).toMatchObject({
      bill_no_normalized: '00702722382',
      payment_amount: null,
      payment_bill_no: '702722382',
      payment_status: null,
    })
  })
})
