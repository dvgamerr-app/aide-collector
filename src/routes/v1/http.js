const HEADERS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' }

export class ApiError extends Error {
  constructor(status, title, detail, extra = {}) {
    super(detail ?? title)
    this.extra = extra
    this.status = status
    this.title = title
  }
}

/** RFC 9457 problem details. */
export const problem = (status, title, detail, extra = {}) =>
  new Response(JSON.stringify({ detail, status, title, type: 'about:blank', ...extra }), {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/problem+json',
      ...(status === 503 ? { 'Retry-After': '300' } : {}),
      ...(status === 405 ? { Allow: 'GET' } : {}),
    },
    status,
  })

/**
 * Answer for a request that matched no /v1 route (unknown path, or a method other than GET). It is built by the
 * application error handler instead of a catch-all route, so every real route keeps its own endpoint in traces.
 */
export const unmatchedProblem = (method) =>
  method === 'GET' || method === 'HEAD'
    ? problem(404, 'Not found', 'Unknown /v1 resource')
    : problem(405, 'Method not allowed', 'The /v1 API is read-only')

export const isV1Path = (path) => path === '/v1' || path.startsWith('/v1/')

export const respond = (data) => Response.json(data, { headers: HEADERS })

/** Runs a v1 handler and turns thrown ApiErrors into problem responses. */
export const handle = (fn) => async (context) => {
  try {
    return respond(await fn(context))
  } catch (error) {
    if (error instanceof ApiError) return problem(error.status, error.title, error.message, error.extra)
    throw error
  }
}

const cache = new Map()

/** Small in-memory cache so repeated public requests do not hit the source database each time. */
export const memo = async (key, ttlMs, fn, now = Date.now()) => {
  const hit = cache.get(key)
  if (hit && now - hit.at < ttlMs) return hit.value
  const value = await fn()
  cache.set(key, { at: now, value })
  return value
}
