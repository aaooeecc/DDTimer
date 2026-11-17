import { z } from 'zod'
import { MAX_ESTIMATE, MAX_GROUP_TITLE_LENGTH, type Operations } from './domain'
import { validDeadline } from './time'

const id = z.uuid()
const ms = z.int().min(-62_135_596_800_000).max(253_402_300_799_999)
const revisionNumber = z.int().positive()
const planTitle = z.string().trim().min(1).max(80)
const taskTitle = z.string().trim().min(1).max(120)
const groupTitle = z.string().trim().min(1).max(MAX_GROUP_TITLE_LENGTH)
const notes = z.string().max(2000)
const estimate = z.int().min(0).max(MAX_ESTIMATE).nullable()
const status = z.enum(['todo', 'doing', 'done'])
const localDate = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/)
const localTime = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/)
const zone = z.string().min(1).max(100).refine(value => {
  if (/^[+-]/.test(value)) return false
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: value })
    return true
  } catch {
    return false
  }
})
const ruleFields = {
  label: z.string().trim().min(1).max(80),
  startLocal: localTime,
  endLocal: localTime,
  enabled: z.boolean()
}
const distinctTimes = (rule: { startLocal: string; endLocal: string }) => rule.startLocal !== rule.endLocal
const ruleInput = z.strictObject(ruleFields).refine(distinctTimes)
const planInput = { title: planTitle, deadlineLocal: localDate }
const taskInput = {
  title: taskTitle, notes, dueLocal: localDate.nullable(), groupId: id.nullable().optional()
}
const rev = { planId: id, expectedRevision: revisionNumber }
const taskRef = { ...rev, taskId: id }
const groupRef = { ...rev, groupId: id }

export const inputSchemas = {
  'plan:get': z.undefined(),
  'plan:create': z.strictObject(planInput),
  'plan:update': z.strictObject(rev).extend(z.object(planInput).partial().shape)
    .refine(value => value.title !== undefined || value.deadlineLocal !== undefined),
  'plan:archive': z.strictObject(rev),
  'plan:undoArchive': z.strictObject(rev),
  'task:create': z.strictObject({ ...rev, ...taskInput }),
  'task:update': z.strictObject({ ...taskRef, ...taskInput }),
  'task:status': z.strictObject({ ...taskRef, status }),
  'task:delete': z.strictObject(taskRef),
  'task:restore': z.strictObject(taskRef),
  'group:create': z.strictObject({ ...rev, title: groupTitle }),
  'group:update': z.strictObject({ ...groupRef, title: groupTitle }),
  'group:delete': z.strictObject(groupRef),
  'rest:replace': z.strictObject({ ...rev, deductRest: z.boolean(), rules: z.array(ruleInput).max(20) }),
  'history:list': z.strictObject({ offset: z.int().min(0) }),
  'history:get': z.strictObject({ planId: id }),
  'backup:export': z.undefined(),
  'backup:import': z.undefined(),
  'window:getState': z.undefined(),
  'window:setPin': z.strictObject({ enabled: z.boolean() }),
  'window:setCompact': z.strictObject({ enabled: z.boolean() }),
  'window:setMini': z.strictObject({ enabled: z.boolean() }),
  'settings:setTaskGrouping': z.strictObject({ enabled: z.boolean() }),
  'settings:setLanguage': z.strictObject({ language: z.enum(['zh-CN', 'en']) }),
  'mini:getCountdown': z.undefined(),
  'app:demoClock': z.undefined()
} satisfies { [K in keyof Operations]: z.ZodType<Operations[K][0]> }

export const windowBounds = z.strictObject({
  x: z.int(), y: z.int(), width: z.int().min(1), height: z.int().min(1)
})

export const DATA_VERSION = 2
export const backupSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(DATA_VERSION)]),
  exportedAtMs: ms,
  plans: z.array(z.strictObject({
    id, title: planTitle, startedAtMs: ms, deadlineAtMs: ms, timeZone: zone,
    state: z.enum(['active', 'archived']), deductRest: z.boolean(), archivedAtMs: ms.nullable(),
    revision: revisionNumber, updatedAtMs: ms
  }).refine(plan => {
    try {
      return (plan.state === 'active') === (plan.archivedAtMs === null)
        && validDeadline(plan.startedAtMs, plan.deadlineAtMs, plan.timeZone)
    } catch {
      return false
    }
  })),
  groups: z.array(z.strictObject({ id, planId: id, title: groupTitle, createdAtMs: ms })).default([]),
  tasks: z.array(z.strictObject({
    id, planId: id, title: taskTitle, notes, status, dueAtMs: ms.nullable(),
    remainingEstimateMinutes: estimate, completedAtMs: ms.nullable(), deletedAtMs: ms.nullable(),
    createdAtMs: ms, updatedAtMs: ms, groupId: id.nullable().default(null)
  }).refine(task => (task.status === 'done') === (task.completedAtMs !== null))),
  restRules: z.array(z.strictObject({
    ...ruleFields, id, planId: id, sortOrder: z.int().min(0).max(19)
  }).refine(distinctTimes)),
  settings: z.strictObject({
    pinned: z.boolean(),
    windowBounds: windowBounds.optional(),
    compact: z.boolean().optional(),
    compactBounds: windowBounds.optional(),
    showTaskGroups: z.boolean().optional()
  })
}).superRefine((backup, ctx) => {
  const plans = new Set(backup.plans.map(plan => plan.id))
  const taskIds = new Set(backup.tasks.map(task => task.id))
  const groupPlans = new Map(backup.groups.map(group => [group.id, group.planId]))
  const ruleIds = new Set(backup.restRules.map(rule => rule.id))
  const rulePositions = new Set(backup.restRules.map(rule => `${rule.planId}:${rule.sortOrder}`))
  if (plans.size !== backup.plans.length || taskIds.size !== backup.tasks.length
    || groupPlans.size !== backup.groups.length
    || ruleIds.size !== backup.restRules.length || rulePositions.size !== backup.restRules.length
    || backup.plans.filter(plan => plan.state === 'active').length > 1
    || backup.groups.some(group => !plans.has(group.planId))
    || backup.tasks.some(task => !plans.has(task.planId)
      || (task.groupId !== null && groupPlans.get(task.groupId) !== task.planId))
    || backup.restRules.some(rule => !plans.has(rule.planId))) {
    ctx.addIssue({ code: 'custom', message: '备份包含重复记录或无效的计划关联。' })
  }
})
export type Backup = z.infer<typeof backupSchema>
