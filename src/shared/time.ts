import { Temporal } from '@js-temporal/polyfill'
import type { Plan, RuleInput } from './domain'
import { DEFAULT_LANGUAGE, translator, type Language } from './language'

export const MINUTE = 60_000
export const HOUR = MINUTE * 60
const DAY = HOUR * 24
type Interval = { start: number; end: number }

export function inZone(ms: number, zone: string) {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone)
}

export function parseLocal(local: string, zone: string) {
  return Temporal.PlainDateTime.from(local)
    .toZonedDateTime(zone, { disambiguation: 'reject' }).epochMilliseconds
}

export function localInput(ms: number, zone: string) {
  return inZone(ms, zone).toPlainDateTime().toString({ smallestUnit: 'minute' })
}

export function validDeadline(start: number, end: number, zone: string) {
  return end > start && end <= inZone(start, zone).add({ years: 10 }).epochMilliseconds
}

export function mergeIntervals(intervals: Interval[]): Interval[] {
  const merged: Interval[] = []
  for (const item of intervals.filter(x => x.end > x.start).sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged.at(-1)
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end)
    else merged.push({ ...item })
  }
  return merged
}

export function restIndex(a: number, b: number, zone: string, rules: RuleInput[]) {
  const intervals: Interval[] = []
  const enabled = rules.filter(rule => rule.enabled).map(rule => ({
    start: Temporal.PlainTime.from(rule.startLocal),
    end: Temporal.PlainTime.from(rule.endLocal),
    overnight: rule.endLocal < rule.startLocal
  }))
  if (enabled.length && a < b) {
    const last = inZone(b, zone).toPlainDate()
    let date = inZone(a, zone).toPlainDate().subtract({ days: 1 })
    let next = date.add({ days: 1 })
    const firstStart = date.toZonedDateTime(zone)
    let nextStart = next.toZonedDateTime(zone)
    let transition = firstStart.getTimeZoneTransition('next')

    function clockOf(day: Temporal.PlainDate, start: Temporal.ZonedDateTime, end: Temporal.ZonedDateTime) {
      const startMs = start.epochMilliseconds
      const endMs = end.epochMilliseconds
      while (transition && transition.epochMilliseconds <= startMs) {
        transition = transition.getTimeZoneTransition('next')
      }
      // Stable-offset dates share one midnight conversion. Transition dates use Temporal for each endpoint.
      const ordinary = start.hour === 0 && start.minute === 0 && start.second === 0 && endMs - startMs === DAY
        && (!transition || transition.epochMilliseconds >= endMs)
      return ordinary
        ? (time: Temporal.PlainTime) => startMs + time.hour * HOUR + time.minute * MINUTE
        : (time: Temporal.PlainTime) => day.toPlainDateTime(time).toZonedDateTime(zone).epochMilliseconds
    }

    let clock = clockOf(date, firstStart, nextStart)
    while (Temporal.PlainDate.compare(date, last) <= 0) {
      const following = next.add({ days: 1 })
      const followingStart = following.toZonedDateTime(zone)
      const nextClock = clockOf(next, nextStart, followingStart)
      for (const rule of enabled) {
        const start = clock(rule.start)
        const end = (rule.overnight ? nextClock : clock)(rule.end)
        const clippedStart = Math.max(a, start)
        const clippedEnd = Math.min(b, end)
        if (clippedEnd > clippedStart) intervals.push({ start: clippedStart, end: clippedEnd })
      }
      date = next
      next = following
      nextStart = followingStart
      clock = nextClock
    }
  }
  const merged = mergeIntervals(intervals)
  const prefix = [0]
  for (const { start, end } of merged) prefix.push(prefix[prefix.length - 1] + end - start)

  function find(t: number) {
    let low = 0
    let high = merged.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (merged[middle].end <= t) low = middle + 1
      else high = middle
    }
    return low
  }

  function before(t: number) {
    const i = find(t)
    return prefix[i] + (i < merged.length ? Math.max(0, t - merged[i].start) : 0)
  }

  return {
    usable(from: number, to: number) {
      return to <= from ? 0 : to - from - (before(to) - before(from))
    },
    contains(at: number) {
      const interval = merged[find(at)]
      return !!interval && at >= interval.start
    }
  }
}

function workdayStart(date: Temporal.PlainDate, timeZone: string) {
  return date.toZonedDateTime({ timeZone, plainTime: '09:00' }).epochMilliseconds
}

export function planRestIndex(plan: Plan, rules: RuleInput[]) {
  const { startedAtMs, deadlineAtMs, timeZone } = plan
  const firstDay = inZone(startedAtMs, timeZone).toPlainDate()
  const start = Math.min(startedAtMs, workdayStart(firstDay, timeZone))
  return restIndex(start, deadlineAtMs, timeZone, rules)
}

export function metrics(plan: Plan, now: number, index: ReturnType<typeof restIndex>) {
  const { startedAtMs: start, deadlineAtMs: end, timeZone } = plan
  const clockBack = now < start
  const anchor = Math.max(start, now)
  const date = inZone(now, timeZone).toPlainDate()
  const midnight = date.add({ days: 1 }).toZonedDateTime(timeZone).epochMilliseconds
  const state = now >= end ? '已截止' as const : !clockBack && index.contains(now) ? '休息中' as const : '计时中' as const
  return {
    natural: Math.max(0, end - now),
    usable: index.usable(anchor, end),
    today: index.usable(anchor, Math.min(midnight, end)),
    elapsed: clockBack ? 0 : index.usable(workdayStart(date, timeZone), Math.min(now, end)),
    state,
    clockBack
  }
}

export function countdown(ms: number) {
  const seconds = Math.ceil(ms / 1000)
  const two = (n: number) => String(n).padStart(2, '0')
  return {
    days: two(Math.floor(seconds / (DAY / 1000))),
    hours: two(Math.floor(seconds / 3600) % 24),
    minutes: two(Math.floor(seconds / 60) % 60),
    seconds: two(seconds % 60)
  }
}

export function duration(ms: number, round: 'up' | 'down' = 'down', language: Language = DEFAULT_LANGUAGE) {
  const t = translator(language)
  if (ms > 0 && ms < MINUTE && round === 'down') return t('小于 1 分钟')
  const minutes = (round === 'up' ? Math.ceil : Math.floor)(ms / MINUTE)
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (!hours) return t('{minutes}分钟', { minutes: remainder })
  if (!remainder) return t('{hours}小时', { hours })
  return t('{hours}小时{minutes}分', {
    hours, minutes: language === 'en' ? remainder : String(remainder).padStart(2, '0')
  })
}
