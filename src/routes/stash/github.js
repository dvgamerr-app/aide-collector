import { sql } from 'kysely'

import { alreadyRunning, startExclusive } from '../../background-job'
import { userAgent } from '../../config'

const API = 'https://api.github.com'
const ORGS = ['dvgamerr-app', 'dl-fansub', 'untirkx']
const OURKK_OWNERS = ['ourkk']
// Employer organisations count towards the totals, but their repositories are never listed publicly.
export const WORK_OWNERS = ['scg-wedo']

const firstSet = (env, names) => names.map((name) => env[name]).find(Boolean)

/**
 * One token per group of owners: GH_USER_TOKEN (falls back to GH_TOKEN/GITHUB_TOKEN) for the account itself,
 * GH_APP_TOKEN (formerly GH_ORGS_TOKEN) for the organisations (falls back to the user token) and GH_OURKK_TOKEN for the ourkk organisation and GH_WORK_TOKEN for the work organisation.
 * `owners: null` means "the token's own account".
 */
export const resolveSources = (env) => {
  const user = firstSet(env, ['GH_USER_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'])
  const orgs = firstSet(env, ['GH_APP_TOKEN', 'GH_ORGS_TOKEN']) || user
  const ourkk = env.GH_OURKK_TOKEN
  const work = env.GH_WORK_TOKEN
  return [
    user && { owners: null, token: user },
    orgs && { owners: ORGS, token: orgs },
    ourkk && { owners: OURKK_OWNERS, token: ourkk },
    work && { owners: WORK_OWNERS, token: work },
  ].filter(Boolean)
}
const PAGE_SIZE = 50
const LOC_PER_RUN = 50
const LOC_CONCURRENCY = 4

// Only repositories this identity has committed to are collected; GH_AUTHOR_EMAIL overrides it (comma separated).
const DEFAULT_AUTHOR_EMAILS = ['kananekt@scg.com', 'kem@ns.co.th', 'thkananek@central.co.th', 'info.dvgamer@gmail.com']
export const authorEmails = (env) =>
  env.GH_AUTHOR_EMAIL
    ? env.GH_AUTHOR_EMAIL.split(',')
        .map((email) => email.trim())
        .filter(Boolean)
    : DEFAULT_AUTHOR_EMAILS

const REPO_FIELDS = `
  nameWithOwner description stargazerCount url isPrivate isFork pushedAt owner { login }
  languages(first: 100, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } }
  defaultBranchRef { target { ... on Commit { history(author: { emails: $emails }) { totalCount } } } }`

// Step 1 only counts commits per repository (cheap even for an organisation with thousands of them) ...
const FILTER_QUERY = `query($login: String!, $emails: [String!]!, $after: String) {
  repositoryOwner(login: $login) {
    repositories(first: ${PAGE_SIZE}, after: $after, orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { id defaultBranchRef { target { ... on Commit { history(author: { emails: $emails }) { totalCount } } } } }
    }
  }
}`

// ... and step 2 loads languages and the rest only for the repositories that passed.
const DETAIL_QUERY = `query($ids: [ID!]!, $emails: [String!]!) {
  nodes(ids: $ids) { ... on Repository { ${REPO_FIELDS} } }
}`
const DETAIL_BATCH = 50

export const parseRepoNode = (node) => ({
  commits: commitCount(node),
  description: node.description ?? null,
  full_name: node.nameWithOwner,
  is_fork: Boolean(node.isFork),
  is_private: Boolean(node.isPrivate),
  languages: Object.fromEntries((node.languages?.edges ?? []).map((edge) => [edge.node.name, edge.size])),
  owner: node.owner.login,
  pushed_at: node.pushedAt ? new Date(node.pushedAt) : null,
  stars: node.stargazerCount ?? 0,
  url: node.url,
})

/** Additions minus deletions of one author out of GitHub's `stats/contributors` payload. */
export const authorLoc = (contributors, login) => {
  const mine = contributors.filter((entry) => entry.author?.login?.toLowerCase() === login.toLowerCase())
  return mine.reduce((total, entry) => total + entry.weeks.reduce((sum, week) => sum + week.a - week.d, 0), 0)
}

const headers = (token) => ({
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'user-agent': userAgent,
  'x-github-api-version': '2022-11-28',
})

const GRAPHQL_ATTEMPTS = 3

// GitHub answers 502/503/504 when a page is too heavy for a moment; those are retried before giving up.
const graphql = async (token, query, variables) => {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${API}/graphql`, {
      body: JSON.stringify({ query, variables }),
      headers: { ...headers(token), 'content-type': 'application/json' },
      method: 'POST',
    })
    if (response.status >= 502 && response.status <= 504 && attempt < GRAPHQL_ATTEMPTS) {
      await Bun.sleep(attempt * 3000)
      continue
    }
    if (!response.ok) throw new Error(`GitHub GraphQL HTTP ${response.status}`)
    const payload = await response.json()
    if (!payload.data) throw new Error(payload.errors?.map((error) => error.message).join('; ') || 'GitHub GraphQL returned no data')
    return payload
  }
}

const commitCount = (node) => node.defaultBranchRef?.target?.history?.totalCount ?? 0

/** Repositories of one owner that the given author emails have committed to (default branch). */
const fetchOwnerRepos = async (token, login, emails) => {
  const ids = []
  let after = null
  for (;;) {
    const { data, errors } = await graphql(token, FILTER_QUERY, { after, emails, login })
    // e.g. an organization that forbids fine-grained tokens answers FORBIDDEN with a null owner.
    if (!data.repositoryOwner) throw new Error(errors?.[0]?.message ?? `owner '${login}' not found`)
    const { nodes, pageInfo } = data.repositoryOwner.repositories
    ids.push(...nodes.filter((node) => node && commitCount(node) > 0).map((node) => node.id))
    if (!pageInfo.hasNextPage) break
    after = pageInfo.endCursor
  }

  const repos = []
  for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
    const { data } = await graphql(token, DETAIL_QUERY, { emails, ids: ids.slice(i, i + DETAIL_BATCH) })
    repos.push(...data.nodes.filter(Boolean).map(parseRepoNode))
  }
  return repos.filter((repo) => repo.commits > 0)
}

const upsertRepos = async (db, repos) => {
  for (let i = 0; i < repos.length; i += 100) {
    const rows = repos
      .slice(i, i + 100)
      .map((repo) => ({ ...repo, languages: sql`${JSON.stringify(repo.languages)}::jsonb`, updated_at: sql`now()` }))
    await db
      .insertInto('stash.github_repo')
      .values(rows)
      .onConflict((oc) =>
        oc.column('full_name').doUpdateSet((eb) => ({
          commits: eb.ref('excluded.commits'),
          description: eb.ref('excluded.description'),
          is_fork: eb.ref('excluded.is_fork'),
          is_private: eb.ref('excluded.is_private'),
          languages: eb.ref('excluded.languages'),
          owner: eb.ref('excluded.owner'),
          pushed_at: eb.ref('excluded.pushed_at'),
          stars: eb.ref('excluded.stars'),
          updated_at: eb.ref('excluded.updated_at'),
          url: eb.ref('excluded.url'),
        })),
      )
      .execute()
  }
}

/** Repositories whose LOC was never computed or was computed for an older push. Forks are skipped. */
const staleRepos = (db, limit) => {
  let query = db
    .selectFrom('stash.github_repo')
    .select(['full_name', 'owner'])
    .where('is_fork', '=', false)
    .where(sql`stat_pushed_at IS DISTINCT FROM pushed_at`)
    .orderBy('pushed_at', 'desc')
  if (limit) query = query.limit(limit)
  return query.execute()
}

// GitHub answers 202 while it builds the statistics: ask again a few times, then leave the repository for the next run.
const LOC_ATTEMPTS = 4
const fetchLoc = async (token, fullName, login) => {
  for (let attempt = 1; attempt <= LOC_ATTEMPTS; attempt++) {
    const response = await fetch(`${API}/repos/${fullName}/stats/contributors`, { headers: headers(token) })
    if (response.status === 204) return 0
    if (response.status === 202) {
      await Bun.sleep(attempt * 2000)
      continue
    }
    if (response.status !== 200) return null
    const contributors = await response.json()
    return Array.isArray(contributors) ? authorLoc(contributors, login) : null
  }
  return null
}

const mapLimit = async (items, limit, fn) => {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) await fn(item)
    }),
  )
}

/** Lists every owner of every source (all GraphQL reads) and upserts what it finds; returns who answered. */
const collectRepos = async ({ db, emails, logger, sources }) => {
  const seen = new Set()
  const fetchedOwners = []
  // owner (lower case) -> the token and login that can read its statistics
  const access = new Map()
  for (const { owners, token } of sources) {
    let viewer
    try {
      viewer = (await graphql(token, 'query { viewer { id login } }', {})).data.viewer
    } catch (error) {
      logger.warn({ error: error.message, owners: owners ?? 'self' }, 'GitHub token rejected')
      continue
    }
    for (const owner of owners ?? [viewer.login]) {
      let repos
      try {
        repos = await fetchOwnerRepos(token, owner, emails)
      } catch (error) {
        logger.warn({ error: error.message, owner }, 'GitHub owner skipped')
        continue
      }
      await upsertRepos(db, repos)
      for (const repo of repos) {
        seen.add(repo.full_name)
        access.set(repo.owner.toLowerCase(), { login: viewer.login, token })
      }
      access.set(owner.toLowerCase(), { login: viewer.login, token })
      fetchedOwners.push(owner)
    }
  }
  return { access, fetchedOwners, seen }
}

export const collectGithub = async ({ db, emails, full, logger, sources }) => {
  const { access, fetchedOwners, seen } = await collectRepos({ db, emails, logger, sources })
  const fallback = [...access.values()][0]

  // Only owners that were listed completely may lose repositories, so a failed page never wipes data.
  if (fetchedOwners.length && seen.size)
    await db
      .deleteFrom('stash.github_repo')
      .where('owner', 'in', fetchedOwners)
      .where('full_name', 'not in', [...seen])
      .execute()

  const stale = fallback ? await staleRepos(db, full ? 0 : LOC_PER_RUN) : []
  let computed = 0
  await mapLimit(stale, LOC_CONCURRENCY, async ({ full_name, owner }) => {
    try {
      const { login, token } = access.get(owner.toLowerCase()) ?? fallback
      const loc = await fetchLoc(token, full_name, login)
      if (loc === null) return
      await db
        .updateTable('stash.github_repo')
        .set({ loc, stat_pushed_at: sql`pushed_at` })
        .where('full_name', '=', full_name)
        .execute()
      computed++
    } catch (error) {
      logger.warn({ error: error.message, repo: full_name }, 'GitHub LOC failed')
    }
  })
  const result = { locComputed: computed, locPending: stale.length - computed, repositories: seen.size }
  logger.info(result, 'GitHub collected')
  return result
}

export const github = ({ db, logger, query }) => {
  const sources = resolveSources(Bun.env)
  if (!sources.length) return Response.json({ error: 'GH_USER_TOKEN is not set', success: false }, { status: 503 })
  const started = startExclusive(
    'github',
    () => collectGithub({ db, emails: authorEmails(Bun.env), full: query?.full === 'true', logger, sources }),
    (error) => logger.error({ error: error.message }, 'GitHub collection failed'),
  )
  return started ? Response.json({ started: true, success: true }, { status: 202 }) : alreadyRunning('github')
}
