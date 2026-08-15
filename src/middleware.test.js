import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'

import { elapsedMilliseconds, requestContext } from './middleware'

describe('requestContext', () => {
  it('keeps a caller trace ID in request-local context and the response header', () => {
    const set = { headers: {} }

    const context = requestContext({ headers: { 'x-trace-id': 'trace-123' }, set })

    expect(context.traceId).toBe('trace-123')
    expect(context.requestStartedAt).toBeNumber()
    expect(set.headers['x-trace-id']).toBe('trace-123')
  })

  it('creates a trace ID when the request has none', () => {
    const set = { headers: {} }

    const context = requestContext({ headers: {}, set })

    expect(context.traceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(set.headers['x-trace-id']).toBe(context.traceId)
  })

  it('keeps concurrent Elysia request contexts isolated', async () => {
    const app = new Elysia().derive(requestContext).get('/trace', ({ traceId }) => traceId)

    const [first, second] = await Promise.all([
      app.handle(new Request('http://localhost/trace', { headers: { 'x-trace-id': 'first' } })),
      app.handle(new Request('http://localhost/trace', { headers: { 'x-trace-id': 'second' } })),
    ])

    expect(await first.text()).toBe('first')
    expect(await second.text()).toBe('second')
  })
})

describe('elapsedMilliseconds', () => {
  it('measures elapsed request time and never returns a negative duration', () => {
    expect(elapsedMilliseconds(100, 105.6)).toBe(6)
    expect(elapsedMilliseconds(105, 100)).toBe(0)
  })
})
