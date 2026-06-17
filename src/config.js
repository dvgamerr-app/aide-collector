import pino from 'pino'

import { name, version as packageVersion } from '../package.json'

export const PORT = Bun.env.PORT || 3000
export const version = packageVersion
export const userAgent = `aide-${name}/${version}`

export const logger = pino({
  level: Bun.env.LOG_LEVEL || 'info',
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
