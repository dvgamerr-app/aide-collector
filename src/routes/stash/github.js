import { sql } from 'kysely'

import { alreadyRunning, startExclusive } from '../../background-job'
import { mapPool } from '../../concurrency'
import { updateFromExcluded } from '../../upsert'
import { fetchLoc, fetchOwnerRepos, graphql } from './github-api'

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

const REPO_KEYS = ['full_name']
const REPO_BATCH = 100

const upsertRepos = async (db, repos) => {
  for (let i = 0; i < repos.length; i += REPO_BATCH) {
    const rows = repos
      .slice(i, i + REPO_BATCH)
      .map((repo) => ({ ...repo, languages: sql`${JSON.stringify(repo.languages)}::jsonb`, updated_at: sql`now()` }))
    await db
      .insertInto('stash.github_repo')
      .values(rows)
      .onConflict((oc) => oc.columns(REPO_KEYS).doUpdateSet(updateFromExcluded(Object.keys(rows[0]), REPO_KEYS)))
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

const viewerOf = async (token, owners, logger) => {
  try {
    return (await graphql(token, 'query { viewer { id login } }', {})).data.viewer
  } catch (error) {
    logger.warn({ error: error.message, owners: owners ?? 'self' }, 'GitHub token rejected')
    return null
  }
}

/** Lists every owner of every source (all GraphQL reads) and upserts what it finds; returns who answered. */
const collectRepos = async ({ db, emails, logger, sources }) => {
  const seen = new Set()
  const fetchedOwners = []
  // owner (lower case) -> the token and login that can read its statistics
  const access = new Map()
  for (const { owners, token } of sources) {
    const viewer = await viewerOf(token, owners, logger)
    if (!viewer) continue
    const grant = { login: viewer.login, token }

    for (const owner of owners ?? [viewer.login]) {
      const repos = await fetchOwnerRepos(token, owner, emails).catch((error) => {
        logger.warn({ error: error.message, owner }, 'GitHub owner skipped')
      })
      if (!repos) continue

      await upsertRepos(db, repos)
      for (const login of [...repos.map((repo) => repo.owner), owner]) access.set(login.toLowerCase(), grant)
      for (const repo of repos) seen.add(repo.full_name)
      fetchedOwners.push(owner)
    }
  }
  return { access, fetchedOwners, seen }
}

/** Stores the author's LOC for one repository; returns whether GitHub had the statistics ready. */
const storeLoc = async (db, { login, token }, fullName) => {
  const loc = await fetchLoc(token, fullName, login)
  if (loc === null) return false
  await db
    .updateTable('stash.github_repo')
    .set({ loc, stat_pushed_at: sql`pushed_at` })
    .where('full_name', '=', fullName)
    .execute()
  return true
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
  const stored = await mapPool(stale, LOC_CONCURRENCY, async ({ full_name, owner }) => {
    try {
      return await storeLoc(db, access.get(owner.toLowerCase()) ?? fallback, full_name)
    } catch (error) {
      logger.warn({ error: error.message, repo: full_name }, 'GitHub LOC failed')
      return false
    }
  })
  const computed = stored.filter(Boolean).length
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
