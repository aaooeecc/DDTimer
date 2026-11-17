import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Snapshot, Task } from '../shared/domain'
import type { Language } from '../shared/language'
import { localInput, MINUTE, planRestIndex } from '../shared/time'

let sampledNow = Date.now()
const listeners = new Set<() => void>()
let stopClock: (() => void) | undefined

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    const sample = () => {
      sampledNow = Date.now()
      for (const callback of listeners) callback()
    }
    sampledNow = Date.now()
    const timer = setInterval(sample, 1000)
    const off = window.tsTimer.onClockSync(sample)
    stopClock = () => { clearInterval(timer); off() }
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stopClock?.()
  }
}

const subscribeFixed = () => () => {}
const clockSnapshot = () => sampledNow

export function useClock(fixed: number | null) {
  return useSyncExternalStore(fixed === null ? subscribe : subscribeFixed,
    fixed === null ? clockSnapshot : () => fixed)
}

export function useTaskClock(fixed: number | null, tasks: Task[]) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (fixed !== null) return
    let timer: ReturnType<typeof setTimeout>
    function sample() {
      clearTimeout(timer)
      const next = Date.now()
      setNow(next)
      let delay = MINUTE
      for (const task of tasks) {
        if (task.status === 'done' || task.dueAtMs === null || task.dueAtMs <= next) continue
        const remaining = task.dueAtMs - next
        delay = Math.min(delay, remaining, remaining % MINUTE + 1)
      }
      timer = setTimeout(sample, delay)
    }
    sample()
    const off = window.tsTimer.onClockSync(sample)
    return () => { clearTimeout(timer); off() }
  }, [fixed, tasks])
  return fixed ?? now
}

export function useRestIndex(snapshot: Snapshot | null) {
  const plan = snapshot?.plan
  const ruleKey = JSON.stringify(plan?.deductRest ? snapshot!.restRules.map(({ startLocal, endLocal, enabled }) =>
    ({ startLocal, endLocal, enabled, label: '' })) : [])
  return useMemo(() => plan ? planRestIndex(plan, JSON.parse(ruleKey)) : null,
    [plan?.id, plan?.startedAtMs, plan?.deadlineAtMs, plan?.timeZone, ruleKey])
}

const monthNames = new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' })

export function fullDate(ms: number, zone: string, language: Language, now?: number) {
  const [date, clock] = localInput(ms, zone).split('T')
  const [year, month, day] = date.split('-')
  const includeYear = now === undefined || year !== localInput(now, zone).slice(0, 4)
  if (language === 'en') {
    const name = monthNames.format(Date.UTC(2000, Number(month) - 1))
    return `${name} ${Number(day)}${includeYear ? `, ${year}` : ''} ${clock}`
  }
  return `${includeYear ? `${year}/` : ''}${month}/${day} ${clock}`
}

export function shortDate(ms: number, zone: string, now: number, language: Language) {
  if (language === 'en') return fullDate(ms, zone, language, now)
  const [date, clock] = localInput(ms, zone).split('T')
  const [year, month, day] = date.split('-')
  const currentYear = localInput(now, zone).slice(0, 4)
  return `${year === currentYear ? '' : `${year}年`}${Number(month)}月${Number(day)}日 ${clock}`
}

