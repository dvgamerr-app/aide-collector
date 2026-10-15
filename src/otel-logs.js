import { SeverityNumber } from '@opentelemetry/api-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'

import { name, version } from '../package.json'

const SERVICE_NAME = Bun.env.OTEL_SERVICE_NAME || 'aide-collector'
const SEVERITY = {
  debug: SeverityNumber.DEBUG,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
  info: SeverityNumber.INFO,
  trace: SeverityNumber.TRACE,
  warn: SeverityNumber.WARN,
}

const instance = Bun.env.TRACEWAY_URL?.replace(/\/+$/, '')
const token = Bun.env.TRACEWAY_TOKEN

// Logs stay local-only until Traceway is configured, mirroring the tracing plugin.
const provider =
  instance && token
    ? new LoggerProvider({
        processors: [
          new BatchLogRecordProcessor({
            exporter: new OTLPLogExporter({ headers: { Authorization: `Bearer ${token}` }, url: `${instance}/api/otel/v1/logs` }),
          }),
        ],
        resource: resourceFromAttributes({ 'service.name': SERVICE_NAME, 'service.version': version }),
      })
    : null
const otelLogger = provider?.getLogger(name)
let localOnly = false

const toAttribute = (value) => (['boolean', 'number', 'string'].includes(typeof value) ? value : JSON.stringify(value))

// pino accepts (msg), (obj, msg) or (obj); reduce each form to a body plus flat attributes.
const parseArgs = ([first, second]) => {
  if (typeof first === 'string') return { attributes: {}, body: first }
  const fields = first && typeof first === 'object' ? first : {}
  const body = typeof second === 'string' ? second : (fields.msg ?? fields.error ?? JSON.stringify(fields))
  const attributes = Object.fromEntries(
    Object.entries(fields)
      .filter(([key, value]) => key !== 'msg' && value !== undefined)
      .map(([key, value]) => [key, toAttribute(value)]),
  )
  return { attributes, body: String(body) }
}

// Emits within the active context so a line logged during a request carries that request's trace id.
export const emitLog = (level, args) => {
  if (!otelLogger || localOnly) return
  // Telemetry must never break the log call it rides on (e.g. JSON.stringify on a circular field).
  try {
    const { attributes, body } = parseArgs(args)
    otelLogger.emit({ attributes, body, severityNumber: SEVERITY[level], severityText: level.toUpperCase() })
  } catch {
    // dropped on purpose: the console line is still written by pino
  }
}

// Runs a synchronous log call that should reach the console only, e.g. lines the endpoint span already covers.
export const withoutOtelLog = (fn) => {
  localOnly = true
  try {
    return fn()
  } finally {
    localOnly = false
  }
}

export const shutdownLogs = async () => {
  await provider?.shutdown()
}
