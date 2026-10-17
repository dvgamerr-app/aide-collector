import { describe, expect, test } from 'bun:test'

import { buildAiAssisted, buildDays, buildModels, buildMonthly, buildWorkType, categoryName, longestStreak, parseModel } from './telemetry'

const UA = (token) => `wakatime/v2.27.5 (windows-10.0.26300.9711-x86_64) go1.27.2 ${token} vscode/1.141.2 vscode-wakatime/30.2.1`

describe('categoryName', () => {
  test('merges case variants into one display name', () => {
    expect(categoryName('ai coding')).toBe('AI Coding')
    expect(categoryName('AI Coding')).toBe('AI Coding')
    expect(categoryName('writing docs')).toBe('Writing Docs')
    expect(categoryName('something new')).toBe('Something New')
    expect(categoryName(null)).toBe('Other')
  })
})

describe('parseModel', () => {
  test('reads Claude models from the plugin string', () => {
    expect(parseModel(UA('sonnet/5-5 claude-code/2.1.300'), 'claude')).toMatchObject({
      key: 'claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
    })
    expect(parseModel(UA('opus/4-8 claude-code/2.1.226'), 'claude')).toMatchObject({ key: 'claude-opus-4-8', name: 'Claude Opus 4.8' })
    expect(parseModel(UA('haiku/4-5-20251001'), null)).toMatchObject({ agent: 'claude', key: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' })
  })

  test('strips the GPT effort suffix', () => {
    expect(parseModel(UA('gpt/5.6-sol-xhigh codex-cli/0.145.0'), 'codex')).toMatchObject({ key: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' })
    expect(parseModel(UA('gpt/6-astra-medium'), null)).toMatchObject({ agent: 'codex', key: 'gpt-6-astra', name: 'GPT-6 Astra' })
    expect(parseModel(UA('gpt/5.4-xhigh'), 'codex')).toMatchObject({ key: 'gpt-5.4', name: 'GPT-5.4' })
  })

  test('falls back to the agent, then to unknown', () => {
    expect(parseModel(UA('codex-cli/0.145.0'), 'codex')).toEqual({ agent: 'codex', key: 'codex', name: 'Codex' })
    expect(parseModel(UA(''), null)).toEqual({ agent: null, key: 'unknown', name: 'Unknown' })
    expect(parseModel(null, null).key).toBe('unknown')
  })
})

describe('buildModels', () => {
  const pricing = [
    { input: 3, model_key: 'claude-sonnet-5', output: 15 },
    { input: 1, model_key: 'default', output: 2 },
  ]

  test('merges rows of one model and costs the tokens', () => {
    const rows = [
      { agent_string: UA('sonnet/5 claude-code/1'), ai_agent_key: 'claude', input: 1e6, output: 1e5, seconds: 1800 },
      { agent_string: UA('sonnet/5 claude-code/2'), ai_agent_key: 'claude', input: 1e6, output: 1e5, seconds: 1800 },
    ]
    const [model] = buildModels(rows, pricing)
    expect(model).toMatchObject({ estCostUSD: 9, hours: 1, key: 'claude-sonnet-5', priced: true, tokens: { input: 2e6, output: 2e5 } })
  })

  test('costs a model without a price row at the default price and flags it', () => {
    const [model] = buildModels([{ agent_string: UA('opus/5-5'), ai_agent_key: 'claude', input: 1e6, output: 1e6, seconds: 3600 }], pricing)
    expect(model).toMatchObject({ estCostUSD: 3, priced: false })
  })

  test('does not cost unattributed heartbeats', () => {
    const [model] = buildModels([{ agent_string: UA(''), ai_agent_key: null, input: 5e6, output: 5e6, seconds: 60 }], pricing)
    expect(model).toMatchObject({ estCostUSD: 0, key: 'unknown', priced: false })
  })
})

describe('longestStreak', () => {
  test('finds the longest run of consecutive days across a month end', () => {
    expect(longestStreak(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-05', '2026-03-06'])).toBe(3)
    expect(longestStreak([])).toBe(0)
    expect(longestStreak(['2026-01-01', '2026-01-01'])).toBe(1)
  })
})

describe('buildMonthly', () => {
  const row = (period, ai_added, human_added, ai_removed = 0, human_removed = 0) => ({
    ai_added,
    ai_removed,
    human_added,
    human_removed,
    period,
  })

  test('computes percentages from added lines and keeps removals separate', () => {
    const [month] = buildMonthly([row('2026-02', 25, 75, 10, 2_700_000)])
    expect(month).toMatchObject({
      aiLines: 25,
      humanLines: 75,
      lines: { ai: { added: 25, removed: 10 }, human: { added: 75, removed: 2_700_000 } },
      month: 'Feb',
      period: '2026-02',
    })
  })

  test('keeps the latest 12 months in order and tolerates an empty month', () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(`${2025 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, 1, 1))
    const months = buildMonthly([...rows].reverse())
    expect(months).toHaveLength(12)
    expect(months[0].period).toBe('2025-03')
    expect(months[11].period).toBe('2026-02')
    expect(buildMonthly([row('2026-01', 0, 0)])[0]).toMatchObject({ aiLines: 0, humanLines: 0 })
  })
})

describe('buildWorkType', () => {
  test('re-normalises the four headline categories and sorts them', () => {
    const rows = [
      { category: 'coding', seconds: 30 },
      { category: 'ai coding', seconds: 60 },
      { category: 'AI Coding', seconds: 0 },
      { category: 'writing docs', seconds: 10 },
      { category: 'debugging', seconds: 500 },
    ]
    const { categories, editorsCount, longestStreakDays } = buildWorkType(rows, 2, 7)
    expect(categories.map((c) => c.name)).toEqual(['AI Coding', 'Coding', 'Writing Docs', 'Writing Tests'])
    expect(categories.map((c) => c.percent)).toEqual([60, 30, 10, 0])
    expect([editorsCount, longestStreakDays]).toEqual([2, 7])
  })
})

describe('buildAiAssisted', () => {
  test('derives percent and lines per million tokens from the totals', () => {
    const result = buildAiAssisted({
      lineRows: [
        { ai_added: 300, ai_removed: 5, human_added: 100, human_removed: 9, period: '2026-09' },
        { ai_added: 100, ai_removed: 0, human_added: 0, human_removed: 1, period: '2026-10' },
      ],
      modelRows: [{ agent_string: UA('sonnet/5'), ai_agent_key: 'claude', input: 3e6, output: 1e6, seconds: 3600 }],
      pricingRows: [{ input: 1, model_key: 'claude-sonnet-5', output: 1 }],
      sessions: { count: 4, longest: 99 },
    })
    expect(result).toMatchObject({
      agentSessions: 4,
      aiLinePercent: 80,
      lines: { ai: { added: 400, removed: 5 }, human: { added: 100, removed: 10 } },
      linesPerMillionTokens: 100,
      longestTaskSeconds: 99,
      tokens: { estCostUSD: 4, inputTokens: 3e6, outputTokens: 1e6 },
    })
  })
})

describe('buildDays', () => {
  test('fills every day with the six standard categories and adds extras only when used', () => {
    const days = buildDays(
      ['2026-10-01', '2026-10-02'],
      [
        { category: 'coding', day: '2026-10-01', seconds: 100 },
        { category: 'ai coding', day: '2026-10-01', seconds: 50 },
        { category: 'code reviewing', day: '2026-10-01', seconds: 5 },
      ],
    )
    expect(days[0].total).toBe(155)
    expect(days[0].categories.map((c) => c.name)).toEqual([
      'Coding',
      'AI Coding',
      'Writing Docs',
      'Writing Tests',
      'Building',
      'Debugging',
      'Code Reviewing',
    ])
    expect(days[1]).toMatchObject({ date: '2026-10-02', total: 0 })
    expect(days[1].categories).toHaveLength(6)
  })
})
