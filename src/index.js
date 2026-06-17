import { swagger } from '@elysiajs/swagger'
import { Elysia } from 'elysia'

import { logger, PORT, userAgent, version } from './config'
import { connect, db, destroy } from './db'
import setupGracefulShutdown from './graceful'
import { errorHandler, responseLogger, swaggerConfig, traceIdMiddleware } from './middleware'
import collector from './routes/collector'
import health from './routes/health'
import lottery from './routes/lottery'
import reminder from './routes/reminder'
import stash from './routes/stash'
import token from './routes/token'

logger.info(`aide-collector ${version} starting...`)

await connect()

const app = new Elysia()
  .use(swagger(swaggerConfig))
  .state('traceId', '')
  .onBeforeHandle(traceIdMiddleware.beforeHandle)
  .decorate({ db, logger, userAgent })
  .onError((context) => errorHandler(context, logger))
  .onAfterResponse((context) => responseLogger(context, logger))
  .use(health)
  .use(collector)
  .use(stash)
  .use(reminder)
  .use(lottery)
  .use(token)

setupGracefulShutdown(destroy)

app.listen({ hostname: '0.0.0.0', port: PORT })
logger.info(`running on ${app.server?.hostname}:${app.server?.port}`)
