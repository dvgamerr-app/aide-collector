const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const RETRIES = 2
const RETRY_DELAY_MS = 500
const TIMEOUT_MS = 30_000

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

/**
 * Cinema sites reject non-browser agents and drop connections under load,
 * so every request carries browser headers, a hard timeout and a couple of retries.
 */
export const fetchWithRetry = async (url, init = {}) => {
  const options = {
    ...init,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,th;q=0.8',
      'User-Agent': BROWSER_USER_AGENT,
      ...init.headers,
    },
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (error) {
      if (attempt >= RETRIES) throw error
      await pause(RETRY_DELAY_MS * (attempt + 1))
    }
  }
}

/** Run tasks with bounded concurrency so detail pages are not fetched one at a time. */
export const mapPool = async (items, limit, task) => {
  const results = new Array(items.length)
  let cursor = 0

  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await task(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
