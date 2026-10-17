import { swagger } from '@elysiajs/swagger'
import { Elysia } from 'elysia'

import { logger, PORT, version } from './config'
import { connect, db, destroy, migrate } from './db'
import setupGracefulShutdown from './graceful'
import { errorHandler, requestContext, responseLogger, swaggerConfig } from './middleware'
import { shutdownLogs } from './otel-logs'
import collector from './routes/collector'
import health from './routes/health'
import lottery from './routes/lottery'
import notify from './routes/notify'
import reminder from './routes/reminder'
import stash from './routes/stash'
import { closeOnt } from './routes/stash/ont'
import v1 from './routes/v1'
import { tracing } from './tracing'
import { closeWaka } from './waka-db'

logger.info(`aide-collector ${version} starting...`)

await connect()
await migrate()

const app = new Elysia()
  .use(tracing() ?? new Elysia())
  .use(swagger(swaggerConfig))
  .derive(requestContext)
  .decorate({ db, logger })
  .onError((context) => errorHandler(context, logger))
  .onAfterResponse((context) => responseLogger(context, logger))
  .use(health)
  .use(collector)
  .use(stash)
  .use(reminder)
  .use(lottery)
  .use(notify)
  .use(v1)

setupGracefulShutdown(async () => {
  await closeOnt()
  await closeWaka()
  await destroy()
  await shutdownLogs()
})

app.listen({ hostname: '0.0.0.0', port: PORT })
logger.info(`running on ${app.server?.hostname}:${app.server?.port}`)
