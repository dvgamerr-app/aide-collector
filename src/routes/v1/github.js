import { parseJson } from '../../json'
import { WORK_OWNERS } from '../stash/github'
import { ApiError } from './http'

// The site shows skill badges only for these well-known languages (same list the old collector filtered with).
const POPULAR_LANGUAGES = new Set([
  'Astro',
  'C',
  'C#',
  'C++',
  'CSS',
  'Dart',
  'Dockerfile',
  'Go',
  'HTML',
  'Java',
  'JavaScript',
  'Kotlin',
  'Objective-C',
  'PHP',
  'PowerShell',
  'Python',
  'Ruby',
  'Rust',
  'SCSS',
  'Shell',
  'Svelte',
  'Swift',
  'TypeScript',
  'Vue',
])
const SORTS = {
  name: (db) => db.orderBy('full_name', 'asc'),
  pushed: (db) => db.orderBy('pushed_at', 'desc').orderBy('full_name', 'asc'),
  stars: (db) => db.orderBy('stars', 'desc').orderBy('full_name', 'asc'),
}

const parseLimit = (raw) => {
  if (raw === undefined) return 100
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new ApiError(400, 'Invalid limit', 'limit must be an integer from 1 to 500')
  return limit
}

const parseCursor = (raw) => {
  if (raw === undefined) return 0
  const offset = Number(raw)
  if (!Number.isInteger(offset) || offset < 0) throw new ApiError(400, 'Invalid cursor', 'cursor must come from a previous response')
  return offset
}

/** Public, non-fork repositories only; private repository names and work organisations never leave the database. */
export const repositories = async ({ db, query }) => {
  const sort = query.sort ?? 'stars'
  if (!SORTS[sort]) throw new ApiError(400, 'Invalid sort', `sort must be one of ${Object.keys(SORTS).join(', ')}`)
  const limit = parseLimit(query.limit)
  const offset = parseCursor(query.cursor)

  let select = db
    .selectFrom('stash.github_repo')
    .select(['description', 'full_name', 'owner', 'stars', 'url'])
    .where('is_private', '=', false)
    .where('owner', 'not in', WORK_OWNERS)
  if (query.fork !== 'true') select = select.where('is_fork', '=', false)
  if (query.owner)
    select = select.where(
      'owner',
      'in',
      String(query.owner)
        .split(',')
        .map((owner) => owner.trim())
        .filter(Boolean),
    )

  const rows = await SORTS[sort](select)
    .limit(limit + 1)
    .offset(offset)
    .execute()
  return {
    items: rows.slice(0, limit).map((row) => ({
      description: row.description,
      name: row.full_name.split('/')[1],
      owner: row.owner,
      stars: row.stars,
      url: row.url,
    })),
    nextCursor: rows.length > limit ? String(offset + limit) : null,
  }
}

/** Repository counts, commits, LOC, bytes per language and the top languages by commits, over every stored repository. */
export const githubSummary = async (db) => {
  const rows = await db.selectFrom('stash.github_repo').select(['commits', 'is_private', 'languages', 'loc']).execute()
  if (!rows.length) throw new ApiError(503, 'No GitHub data yet', 'The GitHub collector has not run yet')

  const bytes = {}
  // Each repository counts once, towards its main language (the one with the most bytes).
  const perLanguage = new Map()
  for (const row of rows) {
    const languages = Object.entries(parseJson(row.languages) ?? {})
    for (const [language, size] of languages) bytes[language] = (bytes[language] ?? 0) + size
    const main = languages.sort(([, a], [, b]) => b - a)[0]?.[0]
    if (!main) continue
    const entry = perLanguage.get(main) ?? { caption: main, commits: 0, loc: 0 }
    entry.commits += row.commits ?? 0
    entry.loc += Math.max(row.loc ?? 0, 0)
    perLanguage.set(main, entry)
  }
  const names = Object.keys(bytes).sort((a, b) => a.localeCompare(b))
  const priv = rows.filter((row) => row.is_private).length
  return {
    bytes,
    commits: rows.reduce((sum, row) => sum + (row.commits ?? 0), 0),
    languages: names,
    // A repository whose net LOC is negative (more lines deleted than added) is left out of the total.
    loc: rows.reduce((sum, row) => sum + Math.max(row.loc ?? 0, 0), 0),
    popular: names.filter((name) => POPULAR_LANGUAGES.has(name)),
    private: priv,
    public: rows.length - priv,
    top5: [...perLanguage.values()].sort((a, b) => b.commits - a.commits || b.loc - a.loc).slice(0, 5),
    total: rows.length,
  }
}
