import postgres from 'postgres'

let client

/** Read-only connection to the WakaTime database; null while DATABASE_WAKATIME_URL is unset. */
export const wakaDb = () => {
  const url = Bun.env.DATABASE_WAKATIME_URL
  if (!url) return null
  client ??= postgres(url, { idle_timeout: 30, max: 3 })
  return client
}

export const closeWaka = async () => {
  await client?.end()
  client = undefined
}
