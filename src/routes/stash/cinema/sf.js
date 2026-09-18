import { collapse, parseMinutes, parseRelease, slugify } from './normalize'
import { fetchWithRetry, mapPool } from './request'

const DETAIL_CONCURRENCY = 6
const ORIGIN = 'https://www.sfcinema.com'

const LISTINGS = [
  { section: 'showing', url: `${ORIGIN}/movies/now-showing` },
  { section: 'coming', url: `${ORIGIN}/movies/coming-soon` },
]

// Cloudflare answers the interactive challenge with a 403 HTML page instead of the listing.
const CHALLENGE_MARKERS = ['just a moment', 'cf-browser-verification', '__cf_chl', 'challenges.cloudflare.com']

export class CinemaChallengeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CinemaChallengeError'
  }
}

export const isChallenge = (status, html) => {
  const text = String(html || '')
    .slice(0, 4000)
    .toLowerCase()
  return CHALLENGE_MARKERS.some((marker) => text.includes(marker)) || status === 403 || status === 503
}

const textSink = (assign) => {
  const state = { active: false, buffer: '' }
  return {
    element(element) {
      state.active = true
      state.buffer = ''
      element.onEndTag(() => {
        if (state.active) assign(collapse(state.buffer))
        state.active = false
        state.buffer = ''
      })
    },
    text(chunk) {
      if (state.active) state.buffer += chunk.text
    },
  }
}

export const parseSfListing = async (html) => {
  const movies = []
  let current = null

  await new HTMLRewriter()
    .on('.movie-card', {
      element(element) {
        current = { cover: '', display: '', path: '' }
        element.onEndTag(() => {
          if (current?.path) movies.push(current)
          current = null
        })
      },
    })
    .on('.movie-card a', {
      element(element) {
        if (!current || current.path) return
        current.display = collapse(element.getAttribute('title'))
        current.path = element.getAttribute('href') || ''
      },
    })
    .on('.movie-card .poster .image', {
      element(element) {
        if (!current) return
        const [, cover] = /url\(\s*['"]?(.*?)['"]?\s*\)/.exec(element.getAttribute('style') || '') || []
        if (cover) current.cover = cover
      },
    })
    .transform(new Response(html))
    .arrayBuffer()

  return movies
}

export const parseSfDetail = async (html) => {
  const detail = { genre: '', release: '', time: '', title: '' }
  const last = (key) => textSink((value) => value && (detail[key] = value))

  await new HTMLRewriter()
    .on('.movie-main-detail h1.title', last('title'))
    .on('.movie-main-detail .release span', last('release'))
    .on('.movie-main-detail .genre span', last('genre'))
    .on('.movie-main-detail .system span', last('time'))
    .transform(new Response(html))
    .arrayBuffer()

  return detail
}

const readListing = async ({ section, url }) => {
  const response = await fetchWithRetry(url)
  const html = await response.text()
  if (isChallenge(response.status, html)) throw new CinemaChallengeError(`sf listing blocked: HTTP ${response.status}`)
  if (!response.ok) throw new Error(`sf listing failed: HTTP ${response.status}`)

  return (await parseSfListing(html)).map((movie) => ({ ...movie, section }))
}

export const collectSf = async () => {
  const listings = (await Promise.all(LISTINGS.map(readListing))).flat()

  // Detail pages carry the release date, genre and running time; fetch them in a bounded pool.
  const entries = await mapPool(listings, DETAIL_CONCURRENCY, async (movie) => {
    const url = movie.path.startsWith('http') ? movie.path : `${ORIGIN}${movie.path.replace('/showtime', '')}`
    const bind = slugify(movie.display) || slugify(movie.path)
    if (!bind) return null

    const base = {
      bind,
      display: movie.display,
      genre: '',
      minutes: 0,
      nameEn: movie.display,
      nameTh: movie.display,
      release: null,
      section: movie.section,
      theater: { sf: { cover: movie.cover, url } },
    }

    try {
      const response = await fetchWithRetry(url)
      const html = await response.text()
      if (isChallenge(response.status, html) || !response.ok) return base

      const detail = await parseSfDetail(html)
      return {
        ...base,
        display: detail.title || base.display,
        genre: detail.genre,
        minutes: parseMinutes(detail.time),
        nameEn: detail.title || base.nameEn,
        release: parseRelease(detail.release),
      }
    } catch {
      return base
    }
  })

  return entries.filter(Boolean)
}
