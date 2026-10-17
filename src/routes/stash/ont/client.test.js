import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { OntSession } from './client'

const originalTimeout = Bun.env.ONT_REQUEST_TIMEOUT

beforeEach(() => {
  Bun.env.ONT_REQUEST_TIMEOUT = '1'
})

afterEach(() => {
  if (originalTimeout === undefined) delete Bun.env.ONT_REQUEST_TIMEOUT
  else Bun.env.ONT_REQUEST_TIMEOUT = originalTimeout
})

describe('OntSession.close', () => {
  test('gives up on a browser that never closes and still clears the session', async () => {
    const session = new OntSession()
    session.browser = { close: () => new Promise(() => {}) }
    session.page = {}
    const started = performance.now()
    await session.close()
    expect(performance.now() - started).toBeLessThan(2500)
    expect(session.browser).toBeNull()
    expect(session.page).toBeNull()
  })

  test('does not throw when closing fails, so the original ONT error is kept', async () => {
    const session = new OntSession()
    session.browser = {
      close: async () => {
        throw new Error('browser already gone')
      },
    }
    await expect(session.close()).resolves.toBeUndefined()
    expect(session.browser).toBeNull()
  })

  test('is a no-op without a browser', async () => {
    await expect(new OntSession().close()).resolves.toBeUndefined()
  })
})
