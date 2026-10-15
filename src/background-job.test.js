import { describe, expect, it } from 'bun:test'

import { alreadyRunning, startExclusive } from './background-job'

describe('startExclusive', () => {
  it('refuses a second job with the same name until the first finishes', async () => {
    let release
    const gate = new Promise((resolve) => (release = resolve))

    expect(startExclusive('job-a', () => gate)).toBe(true)
    expect(startExclusive('job-a', () => {})).toBe(false)
    expect(startExclusive('job-b', () => {})).toBe(true)

    release()
    await gate
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(startExclusive('job-a', () => {})).toBe(true)
  })

  it('reports a crashed job and frees the name', async () => {
    const errors = []
    startExclusive(
      'job-crash',
      () => Promise.reject(new Error('boom')),
      (error) => errors.push(error.message),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(errors).toEqual(['boom'])
    expect(startExclusive('job-crash', () => {})).toBe(true)
  })

  it('answers 409 when a job is already running', async () => {
    const res = alreadyRunning('solar bulk')
    expect(res.status).toBe(409)
    expect((await res.json()).success).toBe(false)
  })
})
