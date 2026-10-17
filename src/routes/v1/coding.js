import { githubSummary } from './github'
import { codingTimeSource } from './waka'

export const formatHours = (seconds) => {
  const minutes = Math.floor(seconds / 60)
  return `${Math.floor(minutes / 60).toLocaleString('en-US')} hrs ${minutes % 60} mins`
}

const sum = (values) => values.reduce((total, value) => total + value, 0)

/**
 * Mirrors how coding.json defines the figures: the average is over every day of the window (idle days count as zero),
 * "weekly" is the mean of the last seven days and "best" the single largest day.
 */
export const buildTime = ({ days, hourlyRows, last, totalSeconds }) => {
  const totals = days.map((day) => day.total)
  // Monday first; a day string is a calendar date, so reading it as UTC gives its weekday.
  const weekdays = Array.from({ length: 7 }, () => 0)
  for (const day of days) weekdays[(new Date(`${day.date}T00:00:00Z`).getUTCDay() + 6) % 7] += day.total
  const hourly = Array.from({ length: 24 }, () => 0)
  for (const row of hourlyRows) hourly[row.hour] = row.seconds
  return {
    average_seconds: totals.length ? sum(totals) / totals.length : 0,
    best_seconds: Math.max(0, ...totals),
    daytime: hourly,
    text: formatHours(totalSeconds),
    totalSeconds,
    updated: last ? new Date(last).toISOString() : null,
    weekly_seconds: sum(totals.slice(-7)) / Math.min(7, Math.max(1, totals.length)),
    weektime: weekdays,
  }
}

/** coding.json plus `bytes` (language -> bytes), `popular` and `top5` (commits and LOC per main language); WakaTime figures from the wakatime database, GitHub from stash. */
export const coding = async ({ db }) => {
  const [repos, time] = await Promise.all([githubSummary(db), codingTimeSource().then(buildTime)])
  return {
    average_seconds: time.average_seconds,
    best_seconds: time.best_seconds,
    bytes: repos.bytes,
    commits: repos.commits,
    daytime: time.daytime,
    languages: repos.languages,
    loc: repos.loc,
    popular: repos.popular,
    private: repos.private,
    public: repos.public,
    top5: repos.top5,
    total: repos.total,
    totalSeconds: time.totalSeconds,
    updated: time.updated,
    wakatime: time.text,
    weekly_seconds: time.weekly_seconds,
    weektime: time.weektime,
  }
}
