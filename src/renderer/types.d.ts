import type { TimerApi } from '../shared/domain'

declare global {
  interface Window { tsTimer: TimerApi }
}
