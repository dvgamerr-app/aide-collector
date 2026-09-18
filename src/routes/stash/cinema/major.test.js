import { describe, expect, it } from 'bun:test'

import { parseMajorDocument, toMajorEntries } from './major'

const card = ({ badge, cover, display, duration, genres, path, release }) => `
  <div class="ml-box">
    <div class="mlb-cover adv_tic  " style="background:url(${cover})">
      <div class="mlbc-hover ">
        <div class="mlbc-name">${display}</div>
        ${genres === null ? '' : `<div class="mlbc-cate"><img class="mlbc-icon">\n          ${genres}\n        </div>`}
        ${duration === null ? '' : `<div class="mlbc-time"><img class="mlbc-icon">\n          ${duration}\n        </div>`}
      </div>
    </div>
    <div class="mlb-date">${release}</div>
    <div class="mlb-name"><a href="${path}">
        ${display}
      </a></div>
    <div class="mlb-genres">
      <span class="genres_span">

        ${badge}

      </span>
    </div>
  </div>`

const page = ({ badge, display, duration = '01 HR. 35 MINS', genres }) => `
<html><body>
  <div id="movie-page-showing" role="tabpanel">
    <div class="box-movies-list">
      ${card({ badge, cover: 'https://cdn/thumb.jpg?2026', display, duration, genres, path: '/movie/girls-like-girls', release: '03 Sep 2026' })}
    </div>
  </div>
  <div id="movie-page-coming" role="tabpanel">
    <div class="box-movies-list">
      ${card({
        badge: 'Action',
        cover: 'https://cdn/sardar.jpg',
        display: 'Sardar 2',
        duration: '02 HR. 30 MINS',
        genres: 'Action / Thriller',
        path: '/movie/sardar-2',
        release: '10 Sep 2026',
      })}
    </div>
  </div>
  <div id="movie-page-other">
    <div class="ml-box"><div class="mlb-name"><a href="/movie/ignored">Ignored</a></div></div>
  </div>
</body></html>`

const english = () => page({ badge: 'Drama', display: 'Girls Like Girls', genres: 'Drama / Romance' })
const thai = () => page({ badge: 'ชีวิต', display: 'เกิร์ลส์ ไลค์ เกิร์ลส์', duration: '01 ชม. 35 นาที', genres: 'ชีวิต / โรแมนติก' })

describe('Major Cineplex listing parser', () => {
  it('reads every card and tags it with the section it came from', async () => {
    const movies = await parseMajorDocument(english())

    expect(movies).toHaveLength(2)
    expect(movies[0]).toEqual({
      badgeGenre: 'Drama',
      cover: 'https://cdn/thumb.jpg?2026',
      display: 'Girls Like Girls',
      genre: 'Drama / Romance',
      path: '/movie/girls-like-girls',
      release: '03 Sep 2026',
      section: 'showing',
      timeText: '01 HR. 35 MINS',
    })
    expect(movies[1].section).toBe('coming')
  })

  it('ignores cards outside the showing and coming panels', async () => {
    const movies = await parseMajorDocument(english())
    expect(movies.map((movie) => movie.path)).not.toContain('/movie/ignored')
  })

  it('falls back to the genre badge when the hover card omits the genre list', async () => {
    const [movie] = await parseMajorDocument(page({ badge: 'Adventure', display: 'Forgotten Island', duration: null, genres: null }))
    const [entry] = toMajorEntries([movie], [])

    expect(entry).toMatchObject({ genre: 'Adventure', minutes: 0 })
  })

  it('pairs the Thai title with the English one through the movie path', async () => {
    const [englishMovies, thaiMovies] = await Promise.all([parseMajorDocument(english()), parseMajorDocument(thai())])
    const entries = toMajorEntries(englishMovies, thaiMovies)

    expect(entries[0]).toMatchObject({
      bind: 'girls-like-girls',
      genre: 'Drama / Romance',
      minutes: 95,
      nameEn: 'Girls Like Girls',
      nameTh: 'เกิร์ลส์ ไลค์ เกิร์ลส์',
      section: 'showing',
      theater: { major: { cover: 'https://cdn/thumb.jpg?2026', url: 'https://www.majorcineplex.com/movie/girls-like-girls' } },
    })
    expect(entries[0].release).toEqual(new Date('2026-09-02T17:00:00.000Z'))
  })
})
