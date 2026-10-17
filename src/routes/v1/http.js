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
