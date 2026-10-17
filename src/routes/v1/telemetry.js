const CATEGORY_NAMES = {
  'ai coding': 'AI Coding',
  building: 'Building',
  'code reviewing': 'Code Reviewing',
  coding: 'Coding',
  debugging: 'Debugging',
  'writing docs': 'Writing Docs',
  'writing tests': 'Writing Tests',
}

// insights.json always lists these six per day, even at zero.
export const DAY_CATEGORIES = ['Coding', 'AI Coding', 'Writing Docs', 'Writing Tests', 'Building', 'Debugging']
const WORK_TYPES = ['AI Coding', 'Coding', 'Writing Docs', 'Writing Tests']

const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1)
const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits
const percent = (part, total) => (total > 0 ? (part / total) * 100 : 0)

export const categoryName = (raw) => {
  const key = String(raw ?? '')
    .trim()
    .toLowerCase()
  return CATEGORY_NAMES[key] ?? (key ? key.split(' ').map(capitalize).join(' ') : 'Other')
}

const MODEL_TOKEN = /(?:^|\s)(sonnet|opus|haiku|fable|gpt|gemini)\/(\S+)/
const EFFORT = /-(minimal|low|medium|high|xhigh)$/
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' }

/**
 * The WakaTime plugin string carries the model as a token (`sonnet/5-5`, `gpt/5.6-sol-xhigh`); rows without one fall back
 * to the agent that wrote them.
 */
export const parseModel = (agentString, agentKey) => {
  const match = MODEL_TOKEN.exec(agentString ?? '')
  if (match) {
    const [, family, rest] = match
    const version = rest.replace(EFFORT, '').replace(/-\d{8}$/, '')
    if (family === 'gpt' || family === 'gemini') {
      const [number, ...tail] = version.split('-')
      const label = family === 'gpt' ? 'GPT' : 'Gemini'
      return {
        agent: agentKey ?? (family === 'gpt' ? 'codex' : family),
        key: `${family}-${version}`,
        name: `${label}-${number}${tail.map((word) => ` ${capitalize(word)}`).join('')}`,
      }
    }
    return {
      agent: agentKey ?? 'claude',
      key: `claude-${family}-${version.replaceAll('.', '-')}`,
      name: `Claude ${capitalize(family)} ${version.replaceAll('-', '.')}`,
    }
  }
  if (agentKey && AGENT_NAMES[agentKey]) return { agent: agentKey, key: agentKey, name: AGENT_NAMES[agentKey] }
  return { agent: agentKey ?? null, key: 'unknown', name: 'Unknown' }
}

/**
 * Costs tokens with the model's row of ai_model_pricing, or the `default` row (priced: false) when it has none.
 * Heartbeats that carry neither a model nor an agent stay visible as `unknown` but are not costed at all.
 */
export const buildModels = (rows, pricingRows) => {
  const pricing = new Map(pricingRows.map((row) => [row.model_key.toLowerCase(), row]))
  const merged = new Map()
  for (const row of rows) {
    const model = parseModel(row.agent_string, row.ai_agent_key)
    const entry = merged.get(model.key) ?? { ...model, input: 0, output: 0, seconds: 0 }
    entry.input += row.input
    entry.output += row.output
    entry.seconds += row.seconds
    merged.set(model.key, entry)
  }
  return [...merged.values()]
    .map((entry) => {
      const exact = pricing.get(entry.key.toLowerCase())
      const price = exact ?? (entry.key === 'unknown' ? undefined : pricing.get('default'))
      const cost = price ? (entry.input / 1e6) * price.input + (entry.output / 1e6) * price.output : 0
      return {
        agent: entry.agent,
        estCostUSD: round(cost),
        hours: entry.seconds / 3600,
        key: entry.key,
        name: entry.name,
        priced: Boolean(exact),
        tokens: { input: entry.input, output: entry.output },
      }
    })
    .sort((a, b) => b.hours - a.hours)
}

export const longestStreak = (days) => {
  const sorted = [...new Set(days)].sort()
  let best = 0
  let run = 0
  let previous
  for (const day of sorted) {
    run = previous && Math.round((Date.parse(day) - Date.parse(previous)) / 86400000) === 1 ? run + 1 : 1
    best = Math.max(best, run)
    previous = day
  }
  return best
}

const monthLabel = (period) => new Date(`${period}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })

const lines = (added, removed) => ({ added, removed })

/** aiLines/humanLines are percentages of added lines (like telemetry.json); removed lines stay in `lines`. */
export const buildMonthly = (rows) =>
  [...rows]
    .sort((a, b) => a.period.localeCompare(b.period))
    .slice(-12)
    .map((row) => ({
      aiLines: percent(row.ai_added, row.ai_added + row.human_added),
      humanLines: row.ai_added + row.human_added > 0 ? percent(row.human_added, row.ai_added + row.human_added) : 0,
      lines: { ai: lines(row.ai_added, row.ai_removed), human: lines(row.human_added, row.human_removed) },
      month: monthLabel(row.period),
      period: row.period,
    }))

const sumLines = (rows) =>
  rows.reduce(
    (total, row) => ({
      ai: lines(total.ai.added + row.ai_added, total.ai.removed + row.ai_removed),
      human: lines(total.human.added + row.human_added, total.human.removed + row.human_removed),
    }),
    { ai: lines(0, 0), human: lines(0, 0) },
  )

/** Four headline categories, re-normalised to 100% like telemetry.json shows them. */
export const buildWorkType = (categoryRows, editors, streakDays) => {
  const seconds = new Map()
  for (const row of categoryRows) seconds.set(categoryName(row.category), (seconds.get(categoryName(row.category)) ?? 0) + row.seconds)
  const total = WORK_TYPES.reduce((sum, name) => sum + (seconds.get(name) ?? 0), 0)
  return {
    categories: WORK_TYPES.map((name) => ({ name, percent: percent(seconds.get(name) ?? 0, total), seconds: seconds.get(name) ?? 0 })).sort(
      (a, b) => b.percent - a.percent,
    ),
    editorsCount: editors,
    longestStreakDays: streakDays,
  }
}

export const buildAiAssisted = ({ lineRows, modelRows, pricingRows, sessions }) => {
  const total = sumLines(lineRows)
  const models = buildModels(modelRows, pricingRows)
  const input = models.reduce((sum, model) => sum + model.tokens.input, 0)
  const output = models.reduce((sum, model) => sum + model.tokens.output, 0)
  const tokens = (input + output) / 1e6
  return {
    agentSessions: sessions.count,
    aiLinePercent: percent(total.ai.added, total.ai.added + total.human.added),
    lines: total,
    linesPerMillionTokens: tokens > 0 ? total.ai.added / tokens : 0,
    longestTaskSeconds: sessions.longest,
    models,
    monthly: buildMonthly(lineRows),
    tokens: { estCostUSD: round(models.reduce((sum, model) => sum + model.estCostUSD, 0)), inputTokens: input, outputTokens: output },
  }
}

/** Per-day records in the shape of insights.json: the six standard categories at zero plus any other with time. */
export const buildDays = (dayList, rows) => {
  const byDay = new Map()
  for (const row of rows) {
    const categories = byDay.get(row.day) ?? new Map()
    categories.set(categoryName(row.category), (categories.get(categoryName(row.category)) ?? 0) + row.seconds)
    byDay.set(row.day, categories)
  }
  return dayList.map((date) => {
    const categories = byDay.get(date) ?? new Map()
    const names = [
      ...DAY_CATEGORIES,
      ...[...categories.keys()].filter((name) => !DAY_CATEGORIES.includes(name) && categories.get(name) > 0),
    ]
    return {
      categories: names.map((name) => ({ name, total: categories.get(name) ?? 0 })),
      date,
      total: [...categories.values()].reduce((sum, seconds) => sum + seconds, 0),
    }
  })
}
