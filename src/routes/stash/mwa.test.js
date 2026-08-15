import { describe, expect, it } from 'bun:test'

import { extractAccountCodes, extractCookie, jwtExpiry, mapMwaReceipts, parseMwaDate } from './mwa'

describe('MWA authentication helpers', () => {
  it('reads ACCTOKEN from response Set-Cookie headers', () => {
    const headers = {
      getSetCookie: () => ['JSESSIONID=session; Path=/; HttpOnly', 'ACCTOKEN=header.payload.signature; Path=/; Secure; HttpOnly'],
    }

    expect(extractCookie(headers, 'ACCTOKEN')).toBe('header.payload.signature')
  })

  it('reads the JWT expiry as epoch milliseconds', () => {
    const payload = btoa(JSON.stringify({ exp: 1_800_000_000 }))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')

    expect(jwtExpiry(`header.${payload}.signature`)).toBe(1_800_000_000_000)
  })

  it('extracts every distinct registered account code', () => {
    expect(extractAccountCodes([{ accountCode: ' account-1 ' }, { accountCode: 'account-2' }, { accountCode: 'account-1' }, {}])).toEqual([
      'account-1',
      'account-2',
    ])
  })
})

describe('MWA receipt mapping', () => {
  it('converts Buddhist calendar dates and rejects invalid dates', () => {
    expect(parseMwaDate(25690619)).toBe('2026-06-19')
    expect(parseMwaDate(20260619)).toBe('2026-06-19')
    expect(parseMwaDate(25690230)).toBeNull()
    expect(parseMwaDate(null)).toBeNull()
  })

  it('keeps distinct charge lines sharing one bill number', () => {
    const base = {
      billDate: 25690619,
      billDueDate: 25690629,
      billNumber: 'bill-1',
      grossAmount: 100,
      periodMonth: 6,
      periodYear: 2569,
      receiveRefSeqNumber: 1,
      receiveSubCode: 0,
    }

    expect(
      mapMwaReceipts('account-1', [
        { ...base, receiveCode: '21' },
        { ...base, grossAmount: 50, receiveCode: '41', receiveSubCode: 20 },
      ]),
    ).toMatchObject([
      {
        account_code: 'account-1',
        bill_date: '2026-06-19',
        bill_number: 'bill-1',
        gross_amount: 100,
        period_year: 2026,
        receive_code: '21',
        receive_sub_code: 0,
      },
      {
        account_code: 'account-1',
        bill_number: 'bill-1',
        gross_amount: 50,
        receive_code: '41',
        receive_sub_code: 20,
      },
    ])
  })
})
