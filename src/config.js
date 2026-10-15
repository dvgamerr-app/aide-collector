import pino from 'pino'

import { name, version as packageVersion } from '../package.json'
import { emitLog } from './otel-logs'

export const PORT = Bun.env.PORT || 3000
export const version = packageVersion
export const userAgent = `aide-${name}/${version}`

export const logger = pino({
  hooks: {
    logMethod(args, method, level) {
      emitLog(this.levels.labels[level], args)
      return method.apply(this, args)
    },
  },
  level: Bun.env.LOG_LEVEL || 'info',
  transport: {
    options: { errorLikeObjectKeys: [], singleLine: true },
    target: 'pino-pretty',
  },
})

export const parseDatabaseUrl = (url) => {
  const uri = new URL(url)
  return {
    database: uri.pathname.split('/')[1],
    host: uri.hostname,
    password: uri.password,
    port: uri.port,
    ssl: false,
    user: uri.username,
  }
}
