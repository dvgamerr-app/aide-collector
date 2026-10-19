import { describe, expect, it } from 'bun:test'
import { Elysia, t } from 'elysia'

import { elapsedMilliseconds, errorHandler, errorStatus, requestContext } from './middleware'

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

describe('errorHandler', () => {
  const logger = { error: () => {} }
  const build = () =>
    new Elysia()
      .onError((context) => errorHandler(context, logger))
      .get('/boom', () => {
        throw new Error('db down')
      })
      .get('/bad', () => {
        throw Object.assign(new Error('Invalid release_date'), { status: 400 })
      })
      .get('/num', ({ query }) => query.n, { query: t.Object({ n: t.Numeric() }) })

  it('answers an unhandled error with HTTP 500 and a failure body', async () => {
    const res = await build().handle(new Request('http://localhost/boom'))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'db down', success: false })
  })

  it('honours a numeric status thrown with the error', async () => {
    const res = await build().handle(new Request('http://localhost/bad'))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid release_date')
  })

  it('maps validation failures to 422 and unknown routes to 404', async () => {
    const app = build()

    expect((await app.handle(new Request('http://localhost/num?n=abc'))).status).toBe(422)
    expect((await app.handle(new Request('http://localhost/missing'))).status).toBe(404)
  })
})

describe('errorHandler for /v1', () => {
  const app = new Elysia().onError((context) => errorHandler(context, { error: () => {} })).get('/v1/known', () => ({ ok: true }))

  it('answers an unknown /v1 path with a 404 problem', async () => {
    const res = await app.handle(new Request('http://localhost/v1/nope'))

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    expect((await res.json()).title).toBe('Not found')
  })

  it('answers any method other than GET with a 405 problem that allows GET', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await app.handle(new Request('http://localhost/v1/known', { method }))

      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('GET')
      expect((await res.json()).title).toBe('Method not allowed')
    }
  })

  it('leaves unknown routes outside /v1 as the plain 404', async () => {
    const res = await app.handle(new Request('http://localhost/v10/x'))

    expect(res.status).toBe(404)
    expect(await res.text()).toBe('NOT_FOUND')
  })
})

describe('errorStatus', () => {
  it('prefers an explicit numeric status and falls back to 500', () => {
    expect(errorStatus('UNKNOWN', { status: 502 })).toBe(502)
    expect(errorStatus('UNKNOWN', { code: 'ECONNRESET' })).toBe(500)
    expect(errorStatus('PARSE', new Error('x'))).toBe(400)
  })
})

describe('elapsedMilliseconds', () => {
  it('measures elapsed request time and never returns a negative duration', () => {
    expect(elapsedMilliseconds(100, 105.6)).toBe(6)
    expect(elapsedMilliseconds(105, 100)).toBe(0)
  })
})
