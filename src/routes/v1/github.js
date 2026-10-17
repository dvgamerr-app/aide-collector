import { parseJson } from '../../json'
import { WORK_OWNERS } from '../stash/github'
import { ApiError } from './http'

const POPULAR = 24
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

/** Repository counts, commits, LOC and bytes per language, summed over every stored repository. */
export const githubSummary = async (db) => {
  const rows = await db.selectFrom('stash.github_repo').select(['commits', 'is_private', 'languages', 'loc']).execute()
  if (!rows.length) throw new ApiError(503, 'No GitHub data yet', 'The GitHub collector has not run yet')

  const bytes = {}
  for (const row of rows)
    for (const [language, size] of Object.entries(parseJson(row.languages) ?? {})) bytes[language] = (bytes[language] ?? 0) + size
  const names = Object.keys(bytes).sort((a, b) => a.localeCompare(b))
  const priv = rows.filter((row) => row.is_private).length
  return {
    bytes,
    commits: rows.reduce((sum, row) => sum + (row.commits ?? 0), 0),
    languages: names,
    // A repository whose net LOC is negative (more lines deleted than added) is left out of the total.
    loc: rows.reduce((sum, row) => sum + Math.max(row.loc ?? 0, 0), 0),
    popular: [...names].sort((a, b) => bytes[b] - bytes[a]).slice(0, POPULAR),
    private: priv,
    public: rows.length - priv,
    total: rows.length,
  }
}
