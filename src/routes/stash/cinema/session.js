import { fetchWithRetry } from './request'

export const MAJOR_ORIGIN = 'https://www.majorcineplex.com'

const SESSION_COOKIE = 'connect.sid'
const SESSION_URL = (lang) => `${MAJOR_ORIGIN}/home/set_session/${lang}`

const readSessionCookie = (headers) => {
  const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean)
  for (const cookie of cookies) {
    const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))
    if (match) return `${SESSION_COOKIE}=${match[1]}`
  }
  return ''
}

/**
 * Major stores the display language in the session, so every language needs its own cookie jar.
 * Without the cookie the site serves Thai, which would be read as the English title.
 */
export const majorSession = async (lang) => {
  const response = await fetchWithRetry(SESSION_URL(lang))
  const cookie = readSessionCookie(response.headers)
  await response.arrayBuffer()

  if (!cookie && lang === 'en') throw new Error(`major did not issue an ${lang} session cookie`)
  return cookie
}

export const majorHeaders = (cookie, extra = {}) => ({
  ...(cookie && { Cookie: cookie }),
  Referer: `${MAJOR_ORIGIN}/`,
  'X-Requested-With': 'XMLHttpRequest',
  ...extra,
})
