import { collapse, parseMinutes, parseRelease, slugify } from './normalize'
import { fetchWithRetry } from './request'
import { MAJOR_ORIGIN, majorHeaders, majorSession } from './session'

const MOVIE_URL = `${MAJOR_ORIGIN}/movie/`

const SECTIONS = {
  'div#movie-page-coming': 'coming',
  'div#movie-page-showing': 'showing',
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

/**
 * Streaming parse of the server-rendered movie listing.
 * HTMLRewriter keeps this at a few milliseconds and removes the need for a headless browser.
 */
export const parseMajorDocument = async (html) => {
  const movies = []
  let current = null
  let section = null

  const rewriter = new HTMLRewriter()

  for (const [selector, name] of Object.entries(SECTIONS)) {
    rewriter.on(selector, {
      element(element) {
        section = name
        element.onEndTag(() => {
          section = null
        })
      },
    })
  }

  rewriter
    .on('div.ml-box', {
      element(element) {
        if (!section) return
        current = { badgeGenre: '', cover: '', display: '', genre: '', path: '', release: '', section, timeText: '' }
        element.onEndTag(() => {
          if (current?.path) movies.push(current)
          current = null
        })
      },
    })
    .on('div.ml-box div.mlb-cover', {
      element(element) {
        if (!current) return
        const [, cover] = /url\(\s*['"]?(.*?)['"]?\s*\)/.exec(element.getAttribute('style') || '') || []
        if (cover) current.cover = cover
      },
    })
    .on(
      'div.ml-box div.mlb-date',
      textSink((value) => {
        if (current) current.release = value
      }),
    )
    .on('div.ml-box div.mlb-name a', {
      element(element) {
        if (current) current.path = element.getAttribute('href') || ''
      },
    })
    .on(
      'div.ml-box div.mlb-name a',
      textSink((value) => {
        if (current) current.display = value
      }),
    )
    // The hover card carries the full genre list and the running time; the badges only carry the first genre.
    .on(
      'div.ml-box div.mlbc-cate',
      textSink((value) => {
        if (current) current.genre = value
      }),
    )
    .on(
      'div.ml-box div.mlbc-time',
      textSink((value) => {
        if (current) current.timeText = value
      }),
    )
    .on(
      'div.ml-box span.genres_span',
      textSink((value) => {
        if (current && !current.badgeGenre && !/^\d/.test(value)) current.badgeGenre = value
      }),
    )

  await rewriter.transform(new Response(html)).arrayBuffer()
  return movies
}

export const toMajorEntries = (englishMovies, thaiMovies) => {
  const thaiByPath = new Map((thaiMovies || []).map((movie) => [movie.path, movie]))

  return (englishMovies || [])
    .map((movie) => {
      const bind = slugify(movie.path.replace(/^\/movie\//, '')) || slugify(movie.display)
      if (!bind) return null

      const thai = thaiByPath.get(movie.path)
      return {
        bind,
        display: movie.display,
        genre: movie.genre || movie.badgeGenre || thai?.genre || '',
        minutes: parseMinutes(movie.timeText || thai?.timeText),
        nameEn: movie.display,
        nameTh: thai?.display || movie.display,
        release: parseRelease(movie.release || thai?.release),
        section: movie.section,
        theater: { major: { cover: movie.cover || thai?.cover || '', url: `${MAJOR_ORIGIN}${movie.path}` } },
      }
    })
    .filter(Boolean)
}

/** Language is stored per session, so each language needs its own cookie jar to be fetched concurrently. */
const fetchLanguage = async (lang) => {
  const cookie = await majorSession(lang)
  const response = await fetchWithRetry(MOVIE_URL, { headers: majorHeaders(cookie) })
  if (!response.ok) throw new Error(`major ${lang} listing failed: HTTP ${response.status}`)

  return parseMajorDocument(await response.text())
}

export const collectMajor = async () => {
  const [english, thai] = await Promise.all([fetchLanguage('en'), fetchLanguage('th')])
  if (!english.length) throw new Error('major listing returned no movies')

  return toMajorEntries(english, thai)
}
