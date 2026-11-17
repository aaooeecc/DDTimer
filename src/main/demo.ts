import { randomUUID } from 'node:crypto'
import { DEFAULT_REST, type Plan, type Task } from '../shared/domain'
import { DATA_VERSION, type Backup } from '../shared/schemas'
import { parseLocal } from '../shared/time'

const timeZone = 'Asia/Shanghai'
const at = (day: number, time: string) => parseLocal(`2026-11-${day}T${time}`, timeZone)
export const demoNow = at(16, '15:30')

export function demoData(): Backup {
  const id = randomUUID()
  const startedAtMs = at(16, '09:00')
  const plan: Plan = {
    id, title: '本周产品上线', startedAtMs, deadlineAtMs: at(20, '18:00'), timeZone,
    state: 'active', deductRest: true, archivedAtMs: null, revision: 1, updatedAtMs: demoNow
  }
  const sample = [
    ['核心功能开发', 17, '18:00', 12, 'doing'],
    ['支付与账号联调', 18, '18:00', 8, 'todo'],
    ['端到端测试', 19, '18:00', 8, 'todo'],
    ['修复问题与验收', 20, '15:00', 6, 'todo'],
    ['上线与发布检查', 20, '18:00', 3, 'todo'],
    ['需求与范围确认', 16, '10:00', null, 'done'],
    ['关键页面设计', 16, '12:00', null, 'done'],
    ['开发环境准备', 16, '15:00', null, 'done']
  ] as const
  const groups = ['开发与联调', '测试与发布', '项目准备'].map((title, index) =>
    ({ id: randomUUID(), planId: id, title, createdAtMs: startedAtMs + index }))
  const tasks: Task[] = sample.map(([title, day, clock, hours, status], index) => ({
    id: randomUUID(), planId: id, groupId: groups[index < 2 ? 0 : index < 5 ? 1 : 2].id,
    title, status, notes: '', dueAtMs: at(day, clock),
    remainingEstimateMinutes: hours === null ? null : hours * 60,
    createdAtMs: startedAtMs, updatedAtMs: demoNow, deletedAtMs: null,
    completedAtMs: status === 'done' ? at(day, clock) : null
  }))
  const restRules = DEFAULT_REST.map((rule, sortOrder) => ({ ...rule, id: randomUUID(), planId: id, sortOrder }))
  return { schemaVersion: DATA_VERSION, exportedAtMs: demoNow, plans: [plan], groups, tasks, restRules,
    settings: { pinned: false, showTaskGroups: true } }
}
