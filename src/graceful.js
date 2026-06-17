import { logger } from './config'

const SHUTDOWN_TIMEOUT = 10000
let isShuttingDown = false
let shutdownTimer

const shutdown = async (signal, handler) => {
  if (isShuttingDown) process.exit(1)
  isShuttingDown = true
  logger.info(`Received ${signal}...`)

  if (shutdownTimer) return
  shutdownTimer = setTimeout(() => {
    logger.error('Forced shutdown due to timeout')
    process.exit(1)
  }, SHUTDOWN_TIMEOUT)

  try {
    await handler()
    logger.info('Graceful shutdown completed')
    process.exit(0)
  } catch (error) {
    logger.error('Error during graceful shutdown', { error: error.message })
    process.exit(1)
  } finally {
    clearTimeout(shutdownTimer)
  }
}

export const setupGracefulShutdown = (handler) => {
  const signals = ['SIGTERM', 'SIGINT']
  if (process.platform === 'win32') signals.push('SIGBREAK')

  signals.forEach((signal) => process.once(signal, () => shutdown(signal, handler)))

  process.once('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack })
    shutdown('uncaughtException', handler)
  })

  process.once('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection', { promise, reason })
    shutdown('unhandledRejection', handler)
  })
}

export default setupGracefulShutdown
