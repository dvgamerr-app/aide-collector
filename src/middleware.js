import { randomUUID } from 'crypto'

import { version } from './config'

export const traceIdMiddleware = {
  beforeHandle({ headers, set, store }) {
    const traceId = headers['x-trace-id'] || headers['trace-id'] || randomUUID()
    set.headers['x-trace-id'] = traceId
    store.traceId = traceId
  },
}

export const errorHandler = ({ code, error, path, store }, logger) => {
  if (code === 'NOT_FOUND') return new Response(code, { status: 404 })

  logger.error({ code, error: error.message, path, stack: error.stack, traceId: store?.traceId })

  return {
    error: error.toString().replace('Error: ', ''),
    status: code,
  }
}

export const responseLogger = ({ code, path, request, response, status, store }, logger) => {
  if (path === '/health') return

  const traceId = store?.traceId
  const isError = code > 299
  const errorMsg = isError ? ` |${status?.code || status?.message?.replace('Error: ', '') || 'Error'}| ` : ' '
  const duration = Math.round(performance.now() / 1000)

  logger[isError ? 'warn' : 'info'](`[${traceId}] [${code || response?.status || request.method}] ${path}${errorMsg}${duration}ms`)
}

export class BadRequestError extends Error {
  constructor(status, message) {
    super(message)
    this.code = 'BAD_REQUEST'
    this.status = status
  }
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
}
