import { trace } from '@opentelemetry/api'
import { randomUUID } from 'crypto'

import { version } from './config'
import { withoutOtelLog } from './otel-logs'

export const requestContext = ({ headers, set }) => {
  const traceId = headers['x-trace-id'] || headers['trace-id'] || randomUUID()
  set.headers['x-trace-id'] = traceId
  return { requestStartedAt: performance.now(), traceId }
}

const ERROR_STATUS = { INVALID_COOKIE_SIGNATURE: 400, NOT_FOUND: 404, PARSE: 400, VALIDATION: 422 }

// Elysia reports a string code; an error thrown with a numeric `status` (or Elysia's status()) wins over it.
export const errorStatus = (code, error) => {
  const explicit = Number(error?.status ?? error?.code)
  if (Number.isInteger(explicit) && explicit >= 400 && explicit <= 599) return explicit
  return ERROR_STATUS[code] ?? 500
}

export const errorHandler = ({ code, error, path, set, traceId }, logger) => {
  const status = errorStatus(code, error)
  set.status = status
  // Traceway folds a 404 with a catch-all route into one UNMATCHED endpoint instead of one row per URL.
  trace
    .getActiveSpan()
    ?.setAttributes(status === 404 ? { 'http.response.status_code': status, 'http.route': '/*' } : { 'http.response.status_code': status })

  if (code === 'NOT_FOUND') return new Response(code, { status })

  logger.error({ code, error: error?.message, path, stack: error?.stack, status, traceId })

  return { error: String(error?.message ?? error), success: false }
}

export const elapsedMilliseconds = (startedAt, now = performance.now()) => Math.max(0, Math.round(now - startedAt))

export const responseLogger = ({ code, path, request, requestStartedAt, response, set, status, traceId }, logger) => {
  if (path === '/health') return

  const isError = Number(response?.status ?? set?.status ?? 200) > 299
  const errorMsg = isError ? ` |${status?.code || status?.message?.replace('Error: ', '') || 'Error'}| ` : ' '
  const duration = elapsedMilliseconds(requestStartedAt)

  // The endpoint span already records method, path, status and duration, so keep this line console-only.
  withoutOtelLog(() =>
    logger[isError ? 'warn' : 'info'](`[${traceId}] [${code || response?.status || request.method}] ${path}${errorMsg}${duration}ms`),
  )
}

export const swaggerConfig = {
  documentation: {
    info: {
      description: 'Data collector API (cinema, gold, lottery, reminder) and the public /v1 API',
      title: 'aide-collector API',
      version: version,
    },
  },
  path: '/docs',
  provider: 'scalar',
}
