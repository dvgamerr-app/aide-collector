import { userAgent } from '../../config'

const API = 'https://api.github.com'
const PAGE_SIZE = 50

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
export const graphql = async (token, query, variables) => {
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
export const fetchOwnerRepos = async (token, login, emails) => {
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

// GitHub answers 202 while it builds the statistics: ask again a few times, then leave the repository for the next run.
const LOC_ATTEMPTS = 4
export const fetchLoc = async (token, fullName, login) => {
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
