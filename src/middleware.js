import { randomUUID } from 'crypto'

import { version } from './config'

export const requestContext = ({ headers, set }) => {
  const traceId = headers['x-trace-id'] || headers['trace-id'] || randomUUID()
  set.headers['x-trace-id'] = traceId
  return { requestStartedAt: performance.now(), traceId }
}

export const errorHandler = ({ code, error, path, traceId }, logger) => {
  if (code === 'NOT_FOUND') return new Response(code, { status: 404 })

  logger.error({ code, error: error.message, path, stack: error.stack, traceId })

  return {
    error: error.toString().replace('Error: ', ''),
    status: code,
  }
}

export const elapsedMilliseconds = (startedAt, now = performance.now()) => Math.max(0, Math.round(now - startedAt))

export const responseLogger = ({ code, path, request, requestStartedAt, response, status, traceId }, logger) => {
  if (path === '/health') return

  const isError = code > 299
  const errorMsg = isError ? ` |${status?.code || status?.message?.replace('Error: ', '') || 'Error'}| ` : ' '
  const duration = elapsedMilliseconds(requestStartedAt)

  logger[isError ? 'warn' : 'info'](`[${traceId}] [${code || response?.status || request.method}] ${path}${errorMsg}${duration}ms`)
}

export const swaggerConfig = {
  documentation: {
    components: {
      securitySchemes: {
        apiKey: {
          description: 'API key authentication using X-API-Key header',
          in: 'header',
          name: 'X-API-Key',
          type: 'apiKey',
        },
      },
    },
    info: {
      description: 'Data collector API (cinema, gold, lottery, reminder, tokens)',
      title: 'aide-collector API',
      version: version,
    },
  },
  path: '/docs',
  provider: 'scalar',
}
