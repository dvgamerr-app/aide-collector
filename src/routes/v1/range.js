import { ApiError } from './http'

export const TIMEZONE = 'Asia/Bangkok'
const DAY = 86400000
const MAX_DAYS = 5 * 366
const DATE = /^\d{4}-\d{2}-\d{2}$/

// Asia/Bangkok has no daylight saving time, so a fixed +07:00 offset is exact.
const bangkokDate = (date) => new Date(date.getTime() + 7 * 3600000).toISOString().slice(0, 10)
const bangkokMidnight = (day) => new Date(`${day}T00:00:00+07:00`)

const parseDay = (value, name) => {
  if (!DATE.test(value) || Number.isNaN(+bangkokMidnight(value)) || bangkokDate(bangkokMidnight(value)) !== value)
    throw new ApiError(400, 'Invalid date', `${name} must be a real date formatted YYYY-MM-DD`)
  return value
}

/** from/to are inclusive Bangkok calendar days; the default is the 365 days ending today. */
export const parseRange = ({ from, to } = {}, now = new Date()) => {
  const last = to ? parseDay(to, 'to') : bangkokDate(now)
  const first = from ? parseDay(from, 'from') : bangkokDate(new Date(+bangkokMidnight(last) - 364 * DAY))
  const days = Math.round((+bangkokMidnight(last) - +bangkokMidnight(first)) / DAY) + 1
  if (days < 1) throw new ApiError(400, 'Invalid range', 'from must not be after to')
  if (days > MAX_DAYS) throw new ApiError(400, 'Range too wide', 'The range can span at most 5 years')
  return { days, end: new Date(+bangkokMidnight(last) + DAY), from: first, start: bangkokMidnight(first), to: last }
}

/** Every YYYY-MM-DD between two Bangkok days, inclusive. */
export const eachDay = (from, to) => {
  const days = []
  for (let t = +bangkokMidnight(from); t <= +bangkokMidnight(to); t += DAY) days.push(bangkokDate(new Date(t)))
  return days
}
