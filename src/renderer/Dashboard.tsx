import { memo, useMemo, useState, type ReactNode } from 'react'
import { CalendarDays, Check, ChevronDown, ChevronRight, Clock3, Ellipsis, Pencil, Plus, TriangleAlert } from 'lucide-react'
import { orderTasks, taskTotals, type Snapshot, type Task, type TaskGroup } from '../shared/domain'
import { duration, metrics } from '../shared/time'
import { Countdown } from './Countdown'
import { fullDate, shortDate, useClock, useTaskClock } from './clock'
import { useTranslation } from './language'
import styles from './Dashboard.module.css'

interface DashboardProps {
  snapshot: Snapshot
  index: Index
  fixed: number | null
  readonly?: boolean
  busy: boolean
  showTaskGroups: boolean
  onTitle: () => void
  onDeadline: () => void
  onTask: (task?: Task, groupId?: string) => void
  onGroup: (group?: TaskGroup) => void
  onDeleteGroup: (group: TaskGroup) => void
  onStatus: (task: Task, status: Task['status']) => void
  onDelete: (task: Task) => void
  footer: ReactNode
  children?: ReactNode
}

type Index = Parameters<typeof metrics>[2]
type Totals = ReturnType<typeof taskTotals>

export function Dashboard(props: DashboardProps) {
  const { t } = useTranslation()
  const { snapshot, fixed, readonly: readOnly, busy, index } = props
  const { plan, tasks, restRules } = snapshot
  const totals = useMemo(() => taskTotals(tasks), [tasks])
  return <main className={styles.dashboard}>
    {props.children}
    <header className={styles.planHeader}>
      <div className={styles.planTitle}>
        <h1 title={plan.title}>{plan.title}</h1>
        {!readOnly && <button className="icon-button" aria-label={t('重命名计划')} title={t('重命名计划')}
          disabled={busy} onClick={props.onTitle}><Pencil size={17} /></button>}
      </div>
      <PlanDeadline plan={plan} fixed={fixed} readOnly={readOnly} busy={busy} edit={props.onDeadline} />
    </header>
    <Overview plan={plan} fixed={fixed} index={index} restEnabled={plan.deductRest && restRules.some(rule => rule.enabled)} />
    <TaskList {...props} totals={totals} />
  </main>
}

function PlanDeadline({ plan, fixed, readOnly, busy, edit }: {
  plan: Snapshot['plan']; fixed: number | null; readOnly?: boolean; busy: boolean; edit: () => void
}) {
  const { language, t } = useTranslation()
  const now = useClock(fixed)
  const date = fullDate(plan.deadlineAtMs, plan.timeZone, language)
  const display = fullDate(plan.deadlineAtMs, plan.timeZone, language, now)
  return <div className={styles.planDeadline}>
    <span>{t('截止')}</span>
    {readOnly ? <span className={styles.deadline} title={date}>{display}</span> :
      <button className={styles.deadline} aria-label={t('修改最终截止')} title={date} disabled={busy} onClick={edit}>
        {display}<CalendarDays size={15} />
      </button>}
  </div>
}

function Overview({ plan, fixed, index, restEnabled }: {
  plan: Snapshot['plan']; fixed: number | null; index: Index; restEnabled: boolean
}) {
  const { language, t } = useTranslation()
  const time = metrics(plan, useClock(fixed), index)
  const values = [
    [t(restEnabled ? '可用 · 已扣休息' : '可用 · 未扣休息'), time.usable],
    [t('今日可用'), time.today],
    [t('已过去'), time.elapsed]
  ] as const
  return <section className={styles.overview} aria-label={t('时间概览')}>
    <h2><Clock3 size={15} /> {t('距离最终截止')}</h2>
    <Countdown remaining={time.natural} className={styles.countdown} />
    <dl className={styles.metrics}>
      {values.map(([label, ms]) => {
        const value = duration(ms, 'down', language)
        return <div key={label} className={styles.metric}>
          <dt>{label}</dt>
          <dd data-long={value.length > 9 || undefined}>{value}</dd>
        </div>
      })}
    </dl>
  </section>
}

type Filter = 'all' | 'open' | 'done'
type TaskSection = { group: TaskGroup | null; open: Task[]; done: Task[] }

const TaskList = memo(function TaskList(props: DashboardProps & { totals: Totals }) {
  const { t } = useTranslation()
  const { snapshot, readonly: readOnly, busy, totals, fixed, showTaskGroups } = props
  const { plan, tasks, groups } = snapshot
  const [filter, setFilter] = useState<Filter>('all')
  const [expanded, setExpanded] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string | null>>(() => new Set())
  const now = useTaskClock(fixed, tasks)
  const items = useMemo(() => orderTasks(tasks), [tasks])
  const sections = useMemo(() => {
    if (!showTaskGroups) return []
    const byGroup = new Map<string, TaskSection>()
    for (const group of groups) byGroup.set(group.id, { group, open: [], done: [] })
    const other: TaskSection = { group: null, open: [], done: [] }
    for (const state of ['open', 'done'] as const) {
      for (const task of items[state]) {
        const section = task.groupId === null ? other : byGroup.get(task.groupId) ?? other
        section[state].push(task)
      }
    }
    return [...byGroup.values(), ...(other.open.length || other.done.length ? [other] : [])]
  }, [groups, items, showTaskGroups])
  const options = [
    ['all', t('全部'), totals.total], ['open', t('待办'), items.open.length], ['done', t('完成'), totals.completed]
  ] as const
  const visible = filter === 'all' ? totals.total : items[filter].length
  const percent = totals.total ? totals.completed / totals.total * 100 : 0
  const row = (task: Task) => <TaskRow key={task.id} task={task} now={now} plan={plan} readOnly={readOnly}
    busy={busy} onEdit={props.onTask} onStatus={props.onStatus} onDelete={props.onDelete} />
  function toggleGroup(id: string | null) {
    setCollapsed(current => {
      const next = new Set(current)
      if (current.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return <section className={styles.taskPanel} aria-label={t('任务')}>
    <div className={styles.taskSummary}>
      <div className={styles.taskHeading}>
        <h2>{t('任务')}</h2>
        <span className={styles.taskCount}>
          {percent === 100 ? t('任务已完成 · 100%') : t('{completed}/{total} 已完成', totals)}
        </span>
        {showTaskGroups && !readOnly && <button className={`secondary ${styles.addGroup}`}
          aria-label={t('添加分组')} title={t('添加分组')} disabled={busy} onClick={() => props.onGroup()}><Plus size={14} />{t('分组')}</button>}
        <div className={styles.filters} aria-label={t('筛选任务')}>
          {options.map(([id, label, count]) => <button key={id} aria-label={t('{filter} {count}', { filter: label, count })}
            aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
        </div>
      </div>
      <div className={styles.progress} role="progressbar" aria-label={t('任务完成进度')}
        aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${percent}%` }} />
      </div>
    </div>
    <div className={styles.taskScroll}>
      {visible === 0 && (!showTaskGroups || filter !== 'all' || sections.length === 0) && <div className={styles.noTasks}>
        {totals.total === 0 && !readOnly
          ? <button className="secondary" disabled={busy} onClick={() => props.onTask()}><Plus size={15} /> {t('添加第一项任务')}</button>
          : <span>{t(filter === 'done' ? '还没有已完成任务' : filter === 'open' ? '没有待办任务' : '没有任务')}</span>}
      </div>}
      {showTaskGroups ? sections.map(({ group, open, done }) => {
        const shown = filter === 'all' ? [...open, ...done] : filter === 'open' ? open : done
        if (filter !== 'all' && shown.length === 0) return null
        const title = group?.title ?? t('未分组')
        const id = group?.id ?? null
        const isOpen = !collapsed.has(id)
        const count = open.length + done.length
        return <section key={id ?? 'ungrouped'} className={styles.taskGroup} aria-label={title}>
          <div className={styles.groupHeading}>
            <button className={styles.groupName} aria-expanded={isOpen} title={title} onClick={() => toggleGroup(id)}>
              {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />} <strong>{title}</strong>
            </button>
            <span className={styles.groupCount}>{count ? `${done.length}/${count}` : t('0 项')}</span>
            {!readOnly && <div className={styles.groupControls}>
              <button className="icon-button" aria-label={group ? t('向{title}添加任务', { title }) : t('添加未分组任务')}
                title={t('添加任务')} disabled={busy} onClick={() => props.onTask(undefined, group?.id)}><Plus size={16} /></button>
              {group && <MoreActions name={t('{title} 分组操作', { title })} busy={busy} actions={[
                { label: t('重命名分组'), select: () => props.onGroup(group) },
                { label: t('删除分组'), select: () => props.onDeleteGroup(group), destructive: true }
              ]} />}
            </div>}
          </div>
          {isOpen && shown.length > 0 && <ul className={styles.list}>{shown.map(row)}</ul>}
        </section>
      }) : <>
        {filter !== 'done' && items.open.length > 0 && <ul className={styles.list}>{items.open.map(row)}</ul>}
        {filter === 'all' && items.done.length > 0 &&
          <button className={styles.group} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />} {t('已完成 {count}', { count: items.done.length })}
          </button>}
        {(filter === 'done' || (filter === 'all' && expanded)) && items.done.length > 0 &&
          <ul className={styles.list}>{items.done.map(row)}</ul>}
      </>}
    </div>
    {props.footer}
  </section>
})

const statusNames = { todo: '待办', doing: '进行中', done: '已完成' } as const

function MoreActions({ name, busy, actions }: {
  name: string; busy: boolean; actions: { label: string; select: () => void; destructive?: boolean }[]
}) {
  const [open, setOpen] = useState(false)
  return <div className={styles.rowAction}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
    onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); event.currentTarget.querySelector('button')?.focus() } }}>
    <button className="icon-button" aria-label={name} title={name} aria-expanded={open}
      disabled={busy} onClick={() => setOpen(value => !value)}><Ellipsis size={15} /></button>
    {open && <div className={styles.rowMenu}>
      {actions.map(action => <button key={action.label} disabled={busy} className={action.destructive ? 'danger-text' : undefined}
        onClick={() => { setOpen(false); action.select() }}>{action.label}</button>)}
    </div>}
  </div>
}

function TaskRow({ task, now, plan, readOnly, busy, onEdit, onStatus, onDelete }: {
  task: Task; now: number; plan: Snapshot['plan']; readOnly?: boolean; busy: boolean
  onEdit: (task?: Task) => void; onStatus: DashboardProps['onStatus']; onDelete: DashboardProps['onDelete']
}) {
  const { language, t } = useTranslation()
  const done = task.status === 'done'
  const status = t(statusNames[task.status])
  const due = task.dueAtMs
  const pastTarget = due !== null && due > plan.deadlineAtMs
  const overdue = due !== null && (done ? task.completedAtMs! > due : now >= due)
  return <li className={styles.taskRow} data-state={task.status}>
    <button className={styles.check} role="checkbox" aria-checked={done} aria-label={t('完成 {title}', { title: task.title })}
      disabled={busy || readOnly} onClick={() => onStatus(task, done ? 'todo' : 'done')}>{done && <Check size={12} strokeWidth={2.6} />}</button>
    <div className={styles.taskInfo}>
      <button className={styles.taskTitle} title={task.title} disabled={busy} onClick={() => onEdit(task)}>{task.title}</button>
      {!done && <p className={styles.taskMeta}>
        {due === null ? t('未设截止') : shortDate(due, plan.timeZone, now, language)}
        {due !== null && !overdue && ` · ${t('剩余 {duration}', { duration: duration(due - now, 'down', language) })}`}
      </p>}
      {(overdue || pastTarget) && <span className={styles.taskWarnings}>
        {overdue && <span><TriangleAlert size={11} />{t(done ? '逾期完成' : '已逾期')}</span>}
        {pastTarget && <span><TriangleAlert size={11} />{t('晚于目标')}</span>}
      </span>}
    </div>
    <div className={styles.taskState}>
      {!done && (readOnly ? <span className={styles.stateLabel}>{status}</span> :
        <button className={styles.stateLabel} disabled={busy}
          aria-label={t('{title} {status}，点击切换状态', { title: task.title, status })}
          onClick={() => onStatus(task, task.status === 'todo' ? 'doing' : 'todo')}>{status}</button>)}
      {!readOnly && <MoreActions name={t('{title} 更多操作', { title: task.title })} busy={busy} actions={[
        { label: t('编辑任务'), select: () => onEdit(task) },
        { label: t('删除任务'), select: () => onDelete(task), destructive: true }
      ]} />}
    </div>
  </li>
}

export function TimerStatus({ snapshot, fixed, index }: { snapshot: Snapshot; fixed: number | null; index: Index }) {
  const { t } = useTranslation()
  const now = useClock(fixed)
  const { state, clockBack } = metrics(snapshot.plan, now, index)
  return <span className={styles.timerStatus}>
    <span className={state === '计时中' ? styles.activeDot : styles.inactiveDot} />
    {t(state)}
    {clockBack && <span className="danger-text"><TriangleAlert size={13} /> {t('系统时间早于计划起点')}</span>}
  </span>
}
