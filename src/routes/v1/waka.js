import { wakaDb } from '../../waka-db'
import { ApiError, memo } from './http'
import { eachDay, parseRange, TIMEZONE } from './range'
import { buildAiAssisted, buildDays, buildWorkType, longestStreak } from './telemetry'

// Duration of a heartbeat is the gap to the next one, capped. A 5 minute cap matches WakaTime's own
// per-day totals (insights.json) to within ~5%, while the profile's 15 minute timeout overshoots by ~40%.
export const GAP_SECONDS = 300
const CACHE_MS = 10 * 60 * 1000

const source = () => {
  const db = wakaDb()
  if (!db) throw new ApiError(503, 'WakaTime not configured', 'DATABASE_WAKATIME_URL is not set')
  return db
}

const heartbeats = (db, { end, start }) => db`
  select h.time, h.category, h.ai_session, h.ai_line_changes, h.human_line_changes, h.ai_input_tokens, h.ai_output_tokens,
    coalesce(h.plugin, ua.user_agent) as agent_string, ua.ai_agent_key,
    least(extract(epoch from lead(h.time) over (order by h.time) - h.time), ${GAP_SECONDS})::float8 as gap
  from heartbeats h
  left join source_user_agents ua on ua.id = h.source_user_agent_id
  where h.time >= ${start} and h.time < ${end}`

const dailyCategories = (db, range) => db`
  with g as (${heartbeats(db, range)})
  select (time at time zone ${TIMEZONE})::date::text as day, lower(category) as category, sum(coalesce(gap, 0))::float8 as seconds
  from g group by 1, 2`

export const codingDays = (query) => {
  const range = parseRange(query)
  return memo(`days:${range.from}:${range.to}`, CACHE_MS, async () => {
    const rows = await dailyCategories(source(), range)
    return { days: buildDays(eachDay(range.from, range.to), rows), gapSeconds: GAP_SECONDS, range: { from: range.from, to: range.to } }
  })
}

/** Inputs of the coding.json time figures: the last 365 days, the hour-of-day split and the all-time total. */
export const codingTimeSource = () =>
  memo('coding-time', CACHE_MS, async () => {
    const db = source()
    const range = parseRange({})
    const [{ days }, hourlyRows, [all]] = await Promise.all([
      codingDays({}),
      db`
        with g as (${heartbeats(db, range)})
        select extract(hour from time at time zone ${TIMEZONE})::int as hour, sum(coalesce(gap, 0))::float8 as seconds from g group by 1`,
      db`
        with g as (${heartbeats(db, { end: new Date(Date.now() + 86400000), start: new Date(0) })})
        select coalesce(sum(coalesce(gap, 0)), 0)::float8 as total, max(time) as last from g`,
    ])
    return { days, hourlyRows, last: all.last, totalSeconds: all.total }
  })

export const telemetry = (query) => {
  const range = parseRange(query)
  return memo(`telemetry:${range.from}:${range.to}`, CACHE_MS, async () => {
    const db = source()
    const g = heartbeats(db, range)
    const [days, lineRows, sessions, modelRows, editors, pricingRows] = await Promise.all([
      dailyCategories(db, range),
      db`
        with g as (${g})
        select to_char(time at time zone ${TIMEZONE}, 'YYYY-MM') as period,
          coalesce(sum(greatest(ai_line_changes, 0)), 0)::float8 as ai_added,
          coalesce(sum(greatest(-ai_line_changes, 0)), 0)::float8 as ai_removed,
          coalesce(sum(greatest(human_line_changes, 0)), 0)::float8 as human_added,
          coalesce(sum(greatest(-human_line_changes, 0)), 0)::float8 as human_removed
        from g group by 1 order by 1`,
      // A session id can be resumed over several days, so a task is one unbroken run inside a session: it ends where
      // the next heartbeat of that session is more than GAP_SECONDS away.
      db`
        with g as (${g}), s as (
          select ai_session, time, extract(epoch from lead(time) over w - time) as raw
          from g where ai_session is not null
          window w as (partition by ai_session order by time)
        ), m as (
          select ai_session, raw, case when coalesce(lag(raw) over (partition by ai_session order by time), 0) > ${GAP_SECONDS} then 1 else 0 end as brk, time
          from s
        ), i as (
          select ai_session, raw, sum(brk) over (partition by ai_session order by time) as island from m
        )
        select (select count(distinct ai_session) from i)::int as count, coalesce(max(seconds), 0)::float8 as longest
        from (select sum(least(coalesce(raw, 0), ${GAP_SECONDS})) as seconds from i group by ai_session, island) t`,
      db`
        with g as (${g})
        select agent_string, ai_agent_key, sum(coalesce(gap, 0))::float8 as seconds,
          coalesce(sum(ai_input_tokens), 0)::float8 as input, coalesce(sum(ai_output_tokens), 0)::float8 as output
        from g where ai_session is not null group by 1, 2`,
      db`
        with g as (${g})
        select count(distinct substring(agent_string from ' ([A-Za-z0-9._-]+)-wakatime/'))::int as editors from g`,
      db`
        select model_key, input_cost_per_mtok::float8 as input, output_cost_per_mtok::float8 as output from ai_model_pricing`,
    ])
    const active = days.filter((row) => row.seconds > 0).map((row) => row.day)
    return {
      aiAssisted: buildAiAssisted({ lineRows, modelRows, pricingRows, sessions: sessions[0] }),
      generatedAt: new Date().toISOString(),
      rangeEnd: range.to,
      rangeStart: range.from,
      timezone: TIMEZONE,
      workType: buildWorkType(days, editors[0].editors, longestStreak(active)),
    }
  })
}
