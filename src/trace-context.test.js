import { describe, expect, it } from 'bun:test'

import { extractTraceContext, parrentPropagator, TRACE_HEADER } from './trace-context'

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

describe('extractTraceContext', () => {
  it('uses the owner-chosen header name', () => {
    expect(TRACE_HEADER).toBe('x-trace-parrent')
  })

  it('turns a valid value into a remote parent with the same ids and flags', () => {
    expect(extractTraceContext(VALID)).toEqual({
      isRemote: true,
      spanId: '00f067aa0ba902b7',
      traceFlags: 1,
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    })
  })

  it('ignores garbage, short and all-zero values', () => {
    expect(extractTraceContext('garbage')).toBeNull()
    expect(extractTraceContext('00-abc-def-01')).toBeNull()
    expect(extractTraceContext(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`)).toBeNull()
    expect(extractTraceContext(`00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`)).toBeNull()
    expect(extractTraceContext(undefined)).toBeNull()
  })
})

describe('parrentPropagator', () => {
  it('only reads x-trace-parrent, not the standard traceparent', async () => {
    const { ROOT_CONTEXT, trace } = await import('@opentelemetry/api')
    const getter = { get: (carrier, key) => carrier[key], keys: (carrier) => Object.keys(carrier) }

    const parent = trace.getSpanContext(parrentPropagator.extract(ROOT_CONTEXT, { [TRACE_HEADER]: VALID }, getter))
    const ignored = parrentPropagator.extract(ROOT_CONTEXT, { traceparent: VALID }, getter)

    expect(parent?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(trace.getSpanContext(ignored)).toBeUndefined()
  })
})
