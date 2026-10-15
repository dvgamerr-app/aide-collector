import { opentelemetry } from '@elysiajs/opentelemetry'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node'

import { version } from './config'

const SERVICE_NAME = Bun.env.OTEL_SERVICE_NAME || 'aide-collector'
const IGNORED_PATHS = ['/health', '/docs']

// Traceway ingests OTLP/HTTP at <instance>/api/otel; tracing stays off until a token is configured.
export const tracing = () => {
  const instance = Bun.env.TRACEWAY_URL?.replace(/\/+$/, '')
  const token = Bun.env.TRACEWAY_BACKEND_TOKEN
  if (!instance || !token) return null

  return opentelemetry({
    checkIfShouldTrace: ({ url }) => !IGNORED_PATHS.some((path) => new URL(url).pathname.startsWith(path)),
    resource: resourceFromAttributes({ 'service.name': SERVICE_NAME, 'service.version': version }),
    serviceName: SERVICE_NAME,
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ headers: { Authorization: `Bearer ${token}` }, url: `${instance}/api/otel/v1/traces` }),
      ),
    ],
  })
}
