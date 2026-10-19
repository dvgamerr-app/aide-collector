import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { chromium } from 'playwright-core'

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

describe('OntSession.open', () => {
  test('launches Chromium without the crash reporter or Breakpad helper', async () => {
    const originalPass = Bun.env.ONT_PASS
    Bun.env.ONT_PASS = 'test'
    // Stop right after launch; only the launch options matter here.
    const launch = spyOn(chromium, 'launch').mockRejectedValue(new Error('launch stubbed'))
    try {
      await expect(new OntSession().open()).rejects.toThrow('launch stubbed')
      expect(launch).toHaveBeenCalledTimes(1)
      expect(launch.mock.calls[0][0].args).toEqual(expect.arrayContaining(['--disable-crash-reporter', '--disable-breakpad']))
    } finally {
      launch.mockRestore()
      if (originalPass === undefined) delete Bun.env.ONT_PASS
      else Bun.env.ONT_PASS = originalPass
    }
  })
})
