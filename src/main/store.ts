import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEFAULT_REST, HISTORY_PAGE_SIZE, UNDO_MS,
  type GroupRef, type Plan, type PlanInput, type Revision, type RuleInput, type Snapshot,
  type Task, type TaskGroup, type TaskInput, type TaskRef, type TaskStatus, type RestRule
} from '../shared/domain'
import { DATA_VERSION, windowBounds, type Backup } from '../shared/schemas'
import { DEFAULT_LANGUAGE, translator, type Language } from '../shared/language'
import { parseLocal, validDeadline } from '../shared/time'
import { OperationError } from './errors'
import { migrations } from './migrations'

const planColumns = `
  id, title, started_at_ms AS startedAtMs, deadline_at_ms AS deadlineAtMs, time_zone AS timeZone,
  state, deduct_rest AS deductRest, archived_at_ms AS archivedAtMs, revision, updated_at_ms AS updatedAtMs`
const taskColumns = `
  id, plan_id AS planId, group_id AS groupId, title, notes, status, due_at_ms AS dueAtMs,
  remaining_estimate_minutes AS remainingEstimateMinutes, completed_at_ms AS completedAtMs,
  deleted_at_ms AS deletedAtMs, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs`
const ruleColumns = `
  id, plan_id AS planId, label, start_local AS startLocal, end_local AS endLocal, enabled, sort_order AS sortOrder`
const groupColumns = 'id, plan_id AS planId, title, created_at_ms AS createdAtMs'
const notFound = () => new OperationError('NOT_FOUND', '找不到此记录，可能已被移除。')
const conflict = () => new OperationError('REVISION_CONFLICT', '计划已有新版本。请核对当前数据后重新编辑。')

function toPlan(row: unknown): Plan {
  const plan = row as Plan
  return { ...plan, deductRest: Boolean(plan.deductRest) }
}

function dateInput(value: string, zone: string) {
  try {
    return parseLocal(value, zone)
  } catch {
    throw new OperationError('VALIDATION_ERROR', '此日期时间无效或在计划时区中存在歧义，请选择其他时刻。')
  }
}

function deadline(value: string, start: number, zone: string) {
  const end = dateInput(value, zone)
  if (!validDeadline(start, end, zone)) {
    throw new OperationError('VALIDATION_ERROR', '最终截止须晚于计划起点，且跨度最多 10 年。')
  }
  return end
}

export class Store {
  private archiveUndo: { id: string; until: number } | null = null
  private dailyBackup: Promise<void> | null = null

  private constructor(private db: Database.Database, private backupDir: string) {}

  static async open(file: string) {
    await mkdir(dirname(file), { recursive: true })
    const hasData = existsSync(file) && statSync(file).size > 0
    const db = new Database(file)
    const store = new Store(db, join(dirname(file), 'backups'))
    try {
      const version = db.pragma('user_version', { simple: true }) as number
      if (version > DATA_VERSION) {
        throw new OperationError('DB_VERSION', '此数据库来自更新版本，请使用相应版本的 DD Timer 打开。')
      }
      if (version < DATA_VERSION && hasData) await store.safetyBackup(`before-migration-v${version}`)
      db.pragma('foreign_keys = ON')
      db.pragma('journal_mode = WAL')
      db.transaction(() => {
        for (let index = version; index < migrations.length; index++) {
          db.exec(migrations[index])
          db.pragma(`user_version = ${index + 1}`)
        }
      }).immediate()
      return store
    } catch (error) {
      db.close()
      throw error
    }
  }

  close() {
    this.db.close()
  }

  private plan(id: string) {
    const row = this.db.prepare(`SELECT ${planColumns} FROM plans WHERE id = ?`).get(id)
    if (!row) throw notFound()
    return toPlan(row)
  }

  getActivePlan(): Plan | null {
    const row = this.db.prepare(`SELECT ${planColumns} FROM plans WHERE state = 'active'`).get()
    return row ? toPlan(row) : null
  }

  getActive(): Snapshot | null {
    const plan = this.getActivePlan()
    return plan ? this.snapshot(plan) : null
  }

  private snapshot(plan: Plan): Snapshot {
    const tasks = this.db.prepare(`SELECT ${taskColumns} FROM tasks WHERE plan_id = ? AND deleted_at_ms IS NULL`)
      .all(plan.id) as Task[]
    return { plan, tasks, groups: this.groups(plan.id), restRules: this.rules(plan.id) }
  }

  private groups(planId?: string): TaskGroup[] {
    const sql = `SELECT ${groupColumns} FROM task_groups ${planId ? 'WHERE plan_id = ?' : ''} ORDER BY created_at_ms, id`
    const query = this.db.prepare(sql)
    return (planId ? query.all(planId) : query.all()) as TaskGroup[]
  }

  private rules(planId?: string): RestRule[] {
    const sql = `SELECT ${ruleColumns} FROM rest_rules ${planId ? 'WHERE plan_id = ?' : ''} ORDER BY sort_order`
    const rows = (planId ? this.db.prepare(sql).all(planId) : this.db.prepare(sql).all()) as RestRule[]
    return rows.map(row => ({ ...row, enabled: Boolean(row.enabled) }))
  }

  history(offset: number) {
    const plans = this.db.prepare(`SELECT ${planColumns} FROM plans WHERE state = 'archived'
      ORDER BY archived_at_ms DESC, id LIMIT ? OFFSET ?`).all(HISTORY_PAGE_SIZE, offset).map(toPlan)
    const { total } = this.db.prepare("SELECT COUNT(*) AS total FROM plans WHERE state = 'archived'").get() as { total: number }
    return { plans, total }
  }

  archived(id: string) {
    const plan = this.plan(id)
    if (plan.state !== 'archived') throw notFound()
    return this.snapshot(plan)
  }

  create(input: PlanInput) {
    const result = this.db.transaction(() => {
      if (this.getActive()) throw new OperationError('VALIDATION_ERROR', '请先归档当前计划。')
      const now = Date.now()
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const plan: Plan = {
        id: randomUUID(), title: input.title, startedAtMs: now, deadlineAtMs: deadline(input.deadlineLocal, now, timeZone),
        timeZone, state: 'active', deductRest: true, archivedAtMs: null, revision: 1, updatedAtMs: now
      }
      this.insertPlan(plan)
      const t = translator(this.language)
      this.insertRules(plan.id, DEFAULT_REST.map(rule => ({ ...rule, label: t(rule.label) })))
      return this.snapshot(plan)
    }).immediate()
    this.archiveUndo = null
    return result
  }

  private insertPlan(plan: Plan) {
    this.db.prepare(`INSERT INTO plans (id, title, started_at_ms, deadline_at_ms, time_zone, state,
      deduct_rest, archived_at_ms, revision, updated_at_ms)
      VALUES (@id, @title, @startedAtMs, @deadlineAtMs, @timeZone, @state, @deductRest, @archivedAtMs, @revision, @updatedAtMs)`)
      .run({ ...plan, deductRest: Number(plan.deductRest) })
  }

  private insertTask(task: Task) {
    this.db.prepare(`INSERT INTO tasks (id, plan_id, group_id, title, notes, status, due_at_ms,
      remaining_estimate_minutes, completed_at_ms, deleted_at_ms, created_at_ms, updated_at_ms)
      VALUES (@id, @planId, @groupId, @title, @notes, @status, @dueAtMs, @remainingEstimateMinutes,
        @completedAtMs, @deletedAtMs, @createdAtMs, @updatedAtMs)`).run(task)
  }

  private insertGroup(group: TaskGroup) {
    this.db.prepare(`INSERT INTO task_groups (id, plan_id, title, created_at_ms)
      VALUES (@id, @planId, @title, @createdAtMs)`).run(group)
  }

  private insertRule(rule: RestRule) {
    this.db.prepare(`INSERT INTO rest_rules (id, plan_id, label, start_local, end_local, enabled, sort_order)
      VALUES (@id, @planId, @label, @startLocal, @endLocal, @enabled, @sortOrder)`)
      .run({ ...rule, enabled: Number(rule.enabled) })
  }

  private insertRules(planId: string, rules: RuleInput[]) {
    rules.forEach((rule, sortOrder) => this.insertRule({ ...rule, id: randomUUID(), planId, sortOrder }))
  }

  private mutate<T>(ref: Revision, change: (plan: Plan, now: number) => T, state: Plan['state'] = 'active') {
    return this.db.transaction(() => {
      const plan = this.plan(ref.planId)
      if (plan.state !== state) throw new OperationError('PLAN_ARCHIVED', '此计划的归档状态已变化，请刷新。')
      if (plan.revision !== ref.expectedRevision) throw conflict()
      const now = Date.now()
      const result = change(plan, now)
      this.db.prepare('UPDATE plans SET revision = revision + 1, updated_at_ms = ? WHERE id = ?').run(now, plan.id)
      return { snapshot: this.snapshot(this.plan(plan.id)), result }
    }).immediate()
  }

  update(input: Revision & Partial<PlanInput>) {
    return this.mutate(input, plan => {
      const until = input.deadlineLocal === undefined
        ? plan.deadlineAtMs : deadline(input.deadlineLocal, plan.startedAtMs, plan.timeZone)
      this.db.prepare('UPDATE plans SET title = ?, deadline_at_ms = ? WHERE id = ?')
        .run(input.title ?? plan.title, until, plan.id)
    }).snapshot
  }

  private task(ref: TaskRef, deleted = false) {
    const task = this.db.prepare(`SELECT ${taskColumns} FROM tasks WHERE id = ? AND plan_id = ?`)
      .get(ref.taskId, ref.planId) as Task | undefined
    if (!task || (task.deletedAtMs !== null) !== deleted) throw notFound()
    return task
  }

  createTask(input: Revision & TaskInput) {
    return this.mutate(input, (plan, now) => {
      const groupId = input.groupId ?? null
      this.checkGroup(plan.id, groupId)
      this.insertTask({
        id: randomUUID(), planId: plan.id, groupId, title: input.title, notes: input.notes, status: 'todo',
        dueAtMs: input.dueLocal === null ? null : dateInput(input.dueLocal, plan.timeZone),
        remainingEstimateMinutes: null, completedAtMs: null, deletedAtMs: null,
        createdAtMs: now, updatedAtMs: now
      })
    }).snapshot
  }

  updateTask(input: TaskRef & TaskInput) {
    return this.mutate(input, (plan, now) => {
      const task = this.task(input)
      const due = input.dueLocal === null ? null : dateInput(input.dueLocal, plan.timeZone)
      const groupId = input.groupId === undefined ? task.groupId : input.groupId
      this.checkGroup(plan.id, groupId)
      this.db.prepare(`UPDATE tasks SET title = ?, notes = ?, due_at_ms = ?, group_id = ?,
        updated_at_ms = ? WHERE id = ?`).run(input.title, input.notes, due, groupId, now, task.id)
    }).snapshot
  }

  private checkGroup(planId: string, groupId: string | null) {
    if (groupId === null) return
    const group = this.db.prepare('SELECT id FROM task_groups WHERE id = ? AND plan_id = ?').get(groupId, planId)
    if (!group) throw new OperationError('GROUP_NOT_FOUND', '此分组已删除或不属于当前计划。')
  }

  createGroup(input: Revision & { title: string }) {
    return this.mutate(input, (plan, now) => {
      this.insertGroup({ id: randomUUID(), planId: plan.id, title: input.title, createdAtMs: now })
    }).snapshot
  }

  updateGroup(input: GroupRef & { title: string }) {
    return this.mutate(input, plan => {
      this.checkGroup(plan.id, input.groupId)
      this.db.prepare('UPDATE task_groups SET title = ? WHERE id = ?').run(input.title, input.groupId)
    }).snapshot
  }

  deleteGroup(input: GroupRef) {
    return this.mutate(input, plan => {
      this.checkGroup(plan.id, input.groupId)
      this.db.prepare('DELETE FROM task_groups WHERE id = ?').run(input.groupId)
    }).snapshot
  }

  setStatus(input: TaskRef & { status: TaskStatus }) {
    return this.mutate(input, (_, now) => {
      const task = this.task(input)
      const completed = input.status === 'done' ? task.completedAtMs ?? now : null
      this.db.prepare('UPDATE tasks SET status = ?, completed_at_ms = ?, updated_at_ms = ? WHERE id = ?')
        .run(input.status, completed, now, task.id)
    }).snapshot
  }

  deleteTask(input: TaskRef) {
    const { snapshot, result } = this.mutate(input, (_, now) => {
      const task = this.task(input)
      this.db.prepare('UPDATE tasks SET deleted_at_ms = ?, updated_at_ms = ? WHERE id = ?').run(now, now, task.id)
      return now + UNDO_MS
    })
    return { snapshot, undoUntil: result }
  }

  restoreTask(input: TaskRef) {
    return this.mutate(input, (_, now) => {
      const task = this.task(input, true)
      if (now < task.deletedAtMs! || now >= task.deletedAtMs! + UNDO_MS) {
        throw new OperationError('UNDO_EXPIRED', '撤销时间已结束。')
      }
      this.db.prepare('UPDATE tasks SET deleted_at_ms = NULL, updated_at_ms = ? WHERE id = ?').run(now, task.id)
    }).snapshot
  }

  replaceRest(input: Revision & { deductRest: boolean; rules: RuleInput[] }) {
    return this.mutate(input, plan => {
      this.db.prepare('UPDATE plans SET deduct_rest = ? WHERE id = ?').run(Number(input.deductRest), plan.id)
      this.db.prepare('DELETE FROM rest_rules WHERE plan_id = ?').run(plan.id)
      this.insertRules(plan.id, input.rules)
    }).snapshot
  }

  archive(input: Revision) {
    const { snapshot, result } = this.mutate(input, (plan, now) => {
      this.db.prepare("UPDATE plans SET state = 'archived', archived_at_ms = ? WHERE id = ?").run(now, plan.id)
      return now + UNDO_MS
    })
    this.archiveUndo = { id: input.planId, until: result }
    return { undoUntil: result, ref: { planId: input.planId, expectedRevision: snapshot.plan.revision } }
  }

  undoArchive(input: Revision) {
    if (this.archiveUndo?.id !== input.planId || Date.now() >= this.archiveUndo.until || this.getActive()) {
      throw new OperationError('UNDO_EXPIRED', '此计划已无法撤销归档。')
    }
    const { snapshot } = this.mutate(input, plan => {
      this.db.prepare("UPDATE plans SET state = 'active', archived_at_ms = NULL WHERE id = ?").run(plan.id)
    }, 'archived')
    this.archiveUndo = null
    return snapshot
  }

  get language(): Language {
    return this.getSetting('language') === 'en' ? 'en' : DEFAULT_LANGUAGE
  }

  getSetting(key: string): unknown {
    const row = this.db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as { value_json: string } | undefined
    return row ? JSON.parse(row.value_json) : undefined
  }

  setSetting(key: string, value: unknown) {
    this.db.prepare(`INSERT INTO app_settings (key, value_json) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(key, JSON.stringify(value))
  }

  setCompact(enabled: boolean) {
    this.db.transaction(() => {
      this.setSetting('compact', enabled)
      if (enabled) this.setSetting('pinned', true)
    }).immediate()
  }

  exportData(): Backup {
    return this.db.transaction((): Backup => ({
      schemaVersion: DATA_VERSION,
      exportedAtMs: Date.now(),
      plans: this.db.prepare(`SELECT ${planColumns} FROM plans ORDER BY started_at_ms, id`).all().map(toPlan),
      groups: this.groups(),
      tasks: this.db.prepare(`SELECT ${taskColumns} FROM tasks ORDER BY created_at_ms, id`).all() as Task[],
      restRules: this.rules(),
      settings: {
        pinned: this.getSetting('pinned') === true,
        windowBounds: windowBounds.safeParse(this.getSetting('windowBounds')).data,
        compact: this.getSetting('compact') === true,
        compactBounds: windowBounds.safeParse(this.getSetting('compactBounds')).data,
        showTaskGroups: this.getSetting('showTaskGroups') === true
      }
    }))()
  }

  replaceData(data: Backup) {
    const snapshot = this.db.transaction(() => {
      this.db.exec(`DELETE FROM rest_rules; DELETE FROM tasks; DELETE FROM task_groups; DELETE FROM plans;
        DELETE FROM app_settings WHERE key <> 'language';`)
      for (const plan of data.plans) this.insertPlan(plan)
      for (const group of data.groups) this.insertGroup(group)
      for (const task of data.tasks) this.insertTask(task)
      for (const rule of data.restRules) this.insertRule(rule)
      this.setSetting('pinned', data.settings.pinned)
      if (data.settings.windowBounds) this.setSetting('windowBounds', data.settings.windowBounds)
      if (data.settings.compact !== undefined) this.setSetting('compact', data.settings.compact)
      if (data.settings.compactBounds) this.setSetting('compactBounds', data.settings.compactBounds)
      if (data.settings.showTaskGroups !== undefined) this.setSetting('showTaskGroups', data.settings.showTaskGroups)
      return this.getActive()
    }).immediate()
    this.archiveUndo = null
    return snapshot
  }

  private async consistentBackup(name: string) {
    await mkdir(this.backupDir, { recursive: true })
    const temp = join(this.backupDir, `${randomUUID()}.partial`)
    try {
      await this.db.backup(temp)
      await rename(temp, join(this.backupDir, name))
    } finally {
      await rm(temp, { force: true })
    }
  }

  safetyBackup(label: string) {
    const clock = new Date().toISOString().replaceAll(':', '-')
    return this.consistentBackup(`${label}-${clock}-${randomUUID()}.sqlite`)
  }

  backupToday() {
    if (this.dailyBackup) return this.dailyBackup
    this.dailyBackup = this.rotateDaily().finally(() => { this.dailyBackup = null })
    return this.dailyBackup
  }

  private async rotateDaily() {
    const day = new Intl.DateTimeFormat('sv-SE').format(new Date())
    const name = `daily-${day}.sqlite`
    if (!existsSync(join(this.backupDir, name))) await this.consistentBackup(name)
    const files = (await readdir(this.backupDir)).filter(file => /^daily-\d{4}-\d{2}-\d{2}\.sqlite$/.test(file)).sort().reverse()
    for (const old of files.slice(7)) await rm(join(this.backupDir, old), { force: true })
  }
}
