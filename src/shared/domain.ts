import type { Language, Message } from './language'

export type TaskStatus = 'todo' | 'doing' | 'done'

export interface Plan {
  id: string
  title: string
  startedAtMs: number
  deadlineAtMs: number
  timeZone: string
  state: 'active' | 'archived'
  deductRest: boolean
  archivedAtMs: number | null
  revision: number
  updatedAtMs: number
}

export interface Task {
  id: string
  planId: string
  groupId: string | null
  title: string
  notes: string
  status: TaskStatus
  dueAtMs: number | null
  remainingEstimateMinutes: number | null
  completedAtMs: number | null
  deletedAtMs: number | null
  createdAtMs: number
  updatedAtMs: number
}

export interface TaskGroup {
  id: string
  planId: string
  title: string
  createdAtMs: number
}

export interface RuleInput {
  label: string
  startLocal: string
  endLocal: string
  enabled: boolean
}

export interface RestRule extends RuleInput {
  id: string
  planId: string
  sortOrder: number
}

export interface Snapshot {
  plan: Plan
  tasks: Task[]
  groups: TaskGroup[]
  restRules: RestRule[]
}

export interface HistoryPage {
  plans: Plan[]
  total: number
}

export interface PlanInput {
  title: string
  deadlineLocal: string
}

export interface TaskInput {
  title: string
  notes: string
  dueLocal: string | null
  groupId?: string | null
}

export interface Revision {
  planId: string
  expectedRevision: number
}

export interface TaskRef extends Revision {
  taskId: string
}

export interface GroupRef extends Revision {
  groupId: string
}

export interface AppError {
  code: string
  message: string
  retryable: boolean
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }

export interface BackupSummary {
  plans: number
  tasks: number
}

export interface WindowState {
  pinned: boolean
  compact: boolean
  mini: boolean
  showTaskGroups: boolean
  language: Language
}

export interface MiniCountdown {
  deadlineAtMs: number
  fixedNow: number | null
  language: Language
}

export interface Operations {
  'plan:get': [undefined, Snapshot | null]
  'plan:create': [PlanInput, Snapshot]
  'plan:update': [Revision & Partial<PlanInput>, Snapshot]
  'plan:archive': [Revision, { undoUntil: number; ref: Revision }]
  'plan:undoArchive': [Revision, Snapshot]
  'task:create': [Revision & TaskInput, Snapshot]
  'task:update': [TaskRef & TaskInput, Snapshot]
  'task:status': [TaskRef & { status: TaskStatus }, Snapshot]
  'task:delete': [TaskRef, { snapshot: Snapshot; undoUntil: number }]
  'task:restore': [TaskRef, Snapshot]
  'group:create': [Revision & { title: string }, Snapshot]
  'group:update': [GroupRef & { title: string }, Snapshot]
  'group:delete': [GroupRef, Snapshot]
  'rest:replace': [Revision & { deductRest: boolean; rules: RuleInput[] }, Snapshot]
  'history:list': [{ offset: number }, HistoryPage]
  'history:get': [{ planId: string }, Snapshot]
  'backup:export': [undefined, BackupSummary | null]
  'backup:import': [undefined, { counts: BackupSummary; snapshot: Snapshot | null; window: WindowState } | null]
  'window:getState': [undefined, WindowState]
  'window:setPin': [{ enabled: boolean }, boolean]
  'window:setCompact': [{ enabled: boolean }, WindowState]
  'window:setMini': [{ enabled: boolean }, WindowState]
  'settings:setTaskGrouping': [{ enabled: boolean }, WindowState]
  'settings:setLanguage': [{ language: Language }, Language]
  'mini:getCountdown': [undefined, MiniCountdown | null]
  'app:demoClock': [undefined, number | null]
}

export type TimerApi = {
  [K in keyof Operations]: (payload: Operations[K][0]) => Promise<Result<Operations[K][1]>>
} & {
  onClockSync: (listener: () => void) => () => void
  onMiniCountdown: (listener: (countdown: MiniCountdown) => void) => () => void
  onMiniClosed: (listener: () => void) => () => void
}

export const DEFAULT_REST = [
  { label: '午间休息', startLocal: '12:00', endLocal: '13:30', enabled: true },
  { label: '晚间休息', startLocal: '22:00', endLocal: '09:00', enabled: true }
] satisfies (RuleInput & { label: Message })[]

export const HISTORY_PAGE_SIZE = 25
export const UNDO_MS = 10_000
export const MAX_ESTIMATE = Math.floor(Number.MAX_SAFE_INTEGER / 60_000)
export const MAX_GROUP_TITLE_LENGTH = 60

export function orderTasks(tasks: Task[]) {
  const open: Task[] = []
  const done: Task[] = []
  for (const task of tasks) {
    if (task.deletedAtMs !== null) continue
    if (task.status === 'done') done.push(task)
    else open.push(task)
  }
  const byCreation = (a: Task, b: Task) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)
  open.sort((a, b) => (a.dueAtMs ?? Infinity) - (b.dueAtMs ?? Infinity) || byCreation(a, b))
  done.sort((a, b) => (b.completedAtMs ?? 0) - (a.completedAtMs ?? 0) || byCreation(a, b))
  return { open, done }
}

export function taskTotals(tasks: Task[]) {
  let total = 0
  let completed = 0
  for (const task of tasks) {
    if (task.deletedAtMs !== null) continue
    total++
    if (task.status === 'done') completed++
  }
  return { total, completed }
}
export const PRODUCT_NAME = 'DD Timer'

