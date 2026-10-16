import { isSpanContextValid, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'

// The owner's chosen spelling; callers must send exactly this name, not the standard `traceparent`.
export const TRACE_HEADER = 'x-trace-parrent'

const PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

// A valid `00-<traceId>-<spanId>-<flags>` value becomes a remote span context; anything else is ignored.
export const extractTraceContext = (value) => {
  const match = PATTERN.exec(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  )
  if (!match) return null
  const spanContext = { isRemote: true, spanId: match[2], traceFlags: Number.parseInt(match[3], 16), traceId: match[1] }
  return isSpanContextValid(spanContext) ? spanContext : null
}

// Lets the Elysia OpenTelemetry plugin continue the caller's trace from the x-trace-parrent header.
export const parrentPropagator = {
  extract(context, carrier, getter) {
    const raw = getter.get(carrier, TRACE_HEADER)
    const spanContext = extractTraceContext(Array.isArray(raw) ? raw[0] : raw)
    return spanContext ? trace.setSpanContext(context, spanContext) : context
  },
  fields: () => [TRACE_HEADER],
  inject() {},
}

// Runs background work inside a CONSUMER span; the span name is the Traceway Task grouping key.
export const runTask = (name, work) =>
  trace.getTracer('aide-collector').startActiveSpan(name, { kind: SpanKind.CONSUMER }, async (span) => {
    try {
      return await work()
    } catch (error) {
      span.recordException(error)
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error?.message ?? error) })
      throw error
    } finally {
      span.end()
    }
  })
