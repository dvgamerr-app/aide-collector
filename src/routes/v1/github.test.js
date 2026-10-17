import { describe, expect, test } from 'bun:test'

import { authorEmails, authorLoc, parseRepoNode, resolveSources, WORK_OWNERS } from '../stash/github'
import { buildTime, formatHours } from './coding'
import { githubSummary, repositories } from './github'
import { ApiError } from './http'

/** Chainable stand-in for a Kysely select that records limit/offset and resolves to fixed rows. */
const fakeDb = (rows) => {
  const calls = {}
  const chain = new Proxy(
    {},
    {
      get: (_, name) => {
        if (name === 'execute') return async () => rows.slice(calls.offset ?? 0, (calls.offset ?? 0) + (calls.limit ?? rows.length))
        return (...args) => {
          calls[name] = args.length === 1 ? args[0] : args
          return chain
        }
      },
    },
  )
  return { calls, selectFrom: () => chain }
}

const repo = (name, extra = {}) => ({
  description: null,
  full_name: `dvgamerr-app/${name}`,
  owner: 'dvgamerr-app',
  stars: 1,
  url: `https://github.com/dvgamerr-app/${name}`,
  ...extra,
})

describe('parseRepoNode', () => {
  test('flattens a GraphQL repository node', () => {
    const row = parseRepoNode({
      defaultBranchRef: { target: { history: { totalCount: 42 } } },
      description: 'demo',
      isFork: false,
      isPrivate: true,
      languages: {
        edges: [
          { node: { name: 'Rust' }, size: 100 },
          { node: { name: 'Go' }, size: 5 },
        ],
      },
      nameWithOwner: 'dvgamerr-app/demo',
      owner: { login: 'dvgamerr-app' },
      pushedAt: '2026-10-01T00:00:00Z',
      stargazerCount: 7,
      url: 'https://github.com/dvgamerr-app/demo',
    })
    expect(row).toMatchObject({
      commits: 42,
      full_name: 'dvgamerr-app/demo',
      is_private: true,
      languages: { Go: 5, Rust: 100 },
      owner: 'dvgamerr-app',
      stars: 7,
    })
    expect(row.pushed_at.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })

  test('copes with an empty repository', () => {
    const row = parseRepoNode({
      defaultBranchRef: null,
      languages: { edges: [] },
      nameWithOwner: 'a/b',
      owner: { login: 'a' },
      pushedAt: null,
      url: 'u',
    })
    expect(row).toMatchObject({ commits: 0, description: null, languages: {}, pushed_at: null, stars: 0 })
  })
})

describe('authorLoc', () => {
  test('sums additions minus deletions of the requested login only, ignoring case', () => {
    const contributors = [
      {
        author: { login: 'DvGamerr' },
        weeks: [
          { a: 100, d: 30 },
          { a: 10, d: 0 },
        ],
      },
      { author: { login: 'someone' }, weeks: [{ a: 999, d: 0 }] },
      { author: null, weeks: [{ a: 5, d: 5 }] },
    ]
    expect(authorLoc(contributors, 'dvgamerr')).toBe(80)
    expect(authorLoc([], 'dvgamerr')).toBe(0)
  })
})

describe('githubSummary', () => {
  test('sums repositories, commits, LOC (negative net LOC left out) and language bytes, reading JSONB strings too', async () => {
    const db = fakeDb([
      { commits: 10, is_private: false, languages: { Go: 100, JavaScript: 300 }, loc: 50 },
      { commits: 5, is_private: true, languages: '{"JavaScript":200,"Rust":900}', loc: null },
      { commits: 1, is_private: false, languages: { EJS: 7, Perl: 3 }, loc: -351285 },
    ])
    const summary = await githubSummary(db)
    expect(summary).toMatchObject({ commits: 16, loc: 50, private: 1, public: 2, total: 3 })
    expect(summary.bytes).toEqual({ EJS: 7, Go: 100, JavaScript: 500, Perl: 3, Rust: 900 })
    expect(summary.languages).toEqual(['EJS', 'Go', 'JavaScript', 'Perl', 'Rust'])
    // only the fixed list of well-known languages, alphabetical (EJS and Perl are not on it)
    expect(summary.popular).toEqual(['Go', 'JavaScript', 'Rust'])
    // each repository counts once, for its main language; negative net LOC adds nothing
    expect(summary.top5).toEqual([
      { caption: 'JavaScript', commits: 10, loc: 50 },
      { caption: 'Rust', commits: 5, loc: 0 },
      { caption: 'EJS', commits: 1, loc: 0 },
    ])
  })

  test('top5 keeps five languages ordered by commits, then LOC', async () => {
    const lang = (name, commits, loc) => ({ commits, is_private: false, languages: { [name]: 100 }, loc })
    const db = fakeDb([
      lang('A', 1, 10),
      lang('B', 9, 5),
      lang('C', 5, 100),
      lang('C', 4, 100),
      lang('D', 9, 50),
      lang('E', 2, 0),
      lang('F', 3, 0),
      { commits: 99, is_private: false, languages: {}, loc: 1 },
    ])
    const { top5 } = await githubSummary(db)
    expect(top5.map((entry) => entry.caption)).toEqual(['C', 'D', 'B', 'F', 'E'])
    expect(top5[0]).toEqual({ caption: 'C', commits: 9, loc: 200 })
  })

  test('answers 503 until the collector has run', async () => {
    const error = await githubSummary(fakeDb([])).catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(503)
  })
})

describe('repositories', () => {
  const rows = [repo('a'), repo('b'), repo('c')]

  test('returns a page with a cursor for the next one', async () => {
    const db = fakeDb(rows)
    const page = await repositories({ db, query: { limit: '2' } })
    expect(page.items.map((item) => item.name)).toEqual(['a', 'b'])
    expect(page.nextCursor).toBe('2')
    expect(db.calls.limit).toBe(3)
    const next = await repositories({ db: fakeDb(rows), query: { cursor: '2', limit: '2' } })
    expect(next.items.map((item) => item.name)).toEqual(['c'])
    expect(next.nextCursor).toBeNull()
  })

  test.each([{ limit: '0' }, { limit: '501' }, { limit: 'x' }, { cursor: '-1' }, { sort: 'random' }])('rejects %o', async (query) => {
    expect((await repositories({ db: fakeDb(rows), query }).catch((e) => e)).status).toBe(400)
  })
})

describe('coding time', () => {
  test('formats total hours like coding.json', () => {
    expect(formatHours(40201800)).toBe('11,167 hrs 10 mins')
    expect(formatHours(59)).toBe('0 hrs 0 mins')
  })

  test('derives average, weekly, best and the weekday/hour distribution', () => {
    // 2026-10-12 is a Monday.
    const days = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-10-${String(5 + i).padStart(2, '0')}`,
      total: i < 7 ? 0 : 100 * (i - 6),
    }))
    const time = buildTime({ days, hourlyRows: [{ hour: 13, seconds: 7 }], last: '2026-10-18T03:00:00Z', totalSeconds: 3600 })
    expect(time.best_seconds).toBe(700)
    expect(time.weekly_seconds).toBe(400)
    expect(time.average_seconds).toBe(200)
    expect(time.weektime).toEqual([100, 200, 300, 400, 500, 600, 700])
    expect(time.daytime).toHaveLength(24)
    expect(time.daytime[13]).toBe(7)
    expect(time.updated).toBe('2026-10-18T03:00:00.000Z')
  })

  test('survives an empty window', () => {
    expect(buildTime({ days: [], hourlyRows: [], last: null, totalSeconds: 0 })).toMatchObject({
      average_seconds: 0,
      best_seconds: 0,
      updated: null,
      weekly_seconds: 0,
    })
  })
})

describe('resolveSources', () => {
  test('gives each group of owners its own token', () => {
    const sources = resolveSources({ GH_APP_TOKEN: 'o', GH_OURKK_TOKEN: 'k', GH_USER_TOKEN: 'u', GH_WORK_TOKEN: 'w' })
    expect(sources.map((s) => s.token)).toEqual(['u', 'o', 'k', 'w'])
    expect(sources[0].owners).toBeNull()
    expect(sources[1].owners).toEqual(['dvgamerr-app', 'dl-fansub', 'untirkx'])
    expect(sources[2].owners).toEqual(['ourkk'])
    expect(sources[3].owners).toEqual(WORK_OWNERS)
  })

  test('falls back to the legacy token for the user and the organisations, and skips an unset work token', () => {
    const sources = resolveSources({ GH_TOKEN: 'legacy' })
    expect(sources.map((s) => s.token)).toEqual(['legacy', 'legacy'])
    expect(resolveSources({})).toEqual([])
  })
})

describe('authorEmails', () => {
  test('defaults to the four portfolio identities and accepts a comma separated override', () => {
    expect(authorEmails({})).toEqual(['kananekt@scg.com', 'kem@ns.co.th', 'thkananek@central.co.th', 'info.dvgamer@gmail.com'])
    expect(authorEmails({ GH_AUTHOR_EMAIL: 'a@x.com, b@x.com,' })).toEqual(['a@x.com', 'b@x.com'])
  })
})
