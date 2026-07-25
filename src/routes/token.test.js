import { afterEach, describe, expect, it } from 'bun:test'

import { validateApiKey } from './token'

const originalMasterKey = Bun.env.MASTER_KEY

afterEach(() => {
  if (originalMasterKey === undefined) {
    delete Bun.env.MASTER_KEY
  } else {
    Bun.env.MASTER_KEY = originalMasterKey
  }
})

describe('validateApiKey', () => {
  it('accepts the configured master key without querying the database', async () => {
    Bun.env.MASTER_KEY = 'master-key'

    const result = await validateApiKey({
      db: {
        selectFrom() {
          throw new Error('master key should bypass database lookup')
        },
      },
      headers: { 'x-api-key': 'master-key' },
    })

    expect(result).toBeUndefined()
  })

  it('revokes expired keys after lookup', async () => {
    const revokedKeys = []
    const db = {
      selectFrom() {
        return {
          executeTakeFirst() {
            return Promise.resolve({
              api_key: 'expired-key',
              expires_at: '2000-01-01T00:00:00.000Z',
              is_active: true,
            })
          },
          limit() {
            return this
          },
          selectAll() {
            return this
          },
          where() {
            return this
          },
        }
      },
      updateTable() {
        return {
          execute() {
            return Promise.resolve()
          },
          set() {
            return this
          },
          where(_column, _operator, key) {
            revokedKeys.push(key)
            return this
          },
        }
      },
    }

    const result = await validateApiKey({
      db,
      headers: { 'x-api-key': 'expired-key' },
    })

    expect(result).toBeInstanceOf(Response)
    expect(result?.status).toBe(401)
    expect(revokedKeys).toEqual(['expired-key'])
  })
})
