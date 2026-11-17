import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Archive, Download, Plus, Timer, Trash2, Upload, X } from 'lucide-react'
import { duration, localInput, parseLocal } from '../shared/time'
import { MAX_GROUP_TITLE_LENGTH, type Plan, type PlanInput, type RuleInput, type Snapshot, type Task, type TaskGroup, type TaskInput } from '../shared/domain'
import type { Language } from '../shared/language'
import { fullDate, useClock } from './clock'
import { useTranslation } from './language'
import styles from './Forms.module.css'

export function Modal({ title, busy, close, children, drawer = false }: {
  title: string; busy: boolean; close: () => void; children: ReactNode; drawer?: boolean
}) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  useEffect(() => {
    const node = dialog.current!
    node.showModal()
    return () => node.close()
  }, [])
  return <dialog ref={dialog} aria-labelledby={heading} className={drawer ? styles.drawer : styles.modal}
    onCancel={event => { event.preventDefault(); if (!busy) close() }}
    onKeyDown={event => {
      if (event.key === 'Enter' && event.ctrlKey && !busy) {
        event.preventDefault()
        const submit = dialog.current?.querySelector<HTMLButtonElement>('form button[type="submit"]:enabled')
        submit?.form?.requestSubmit(submit)
      }
    }}>
    <div className={styles.dialogHeader}>
      <h2 id={heading}>{title}</h2>
      <button className="icon-button" aria-label={t('关闭')} disabled={busy} onClick={close}><X size={22} /></button>
    </div>
    {children}
  </dialog>
}

export function FormError({ message, retry }: { message: string | undefined; retry?: () => void }) {
  const { t } = useTranslation()
  return message && <div role="alert" className="form-error">{message}{retry && <button type="button" onClick={retry}>{t('重试')}</button>}</div>
}

export function EmptyState({ busy, error, retry, onCreate, onSettings, onDirty }: {
  busy: boolean; error?: string; retry?: () => void; onCreate: (input: PlanInput) => void
  onSettings: () => void; onDirty: (dirty: boolean) => void
}) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [deadlineLocal, setDeadline] = useState('')
  useEffect(() => {
    onDirty(Boolean(title || deadlineLocal))
    return () => onDirty(false)
  }, [title, deadlineLocal, onDirty])
  return <main className={styles.empty}>
    <section className={styles.createCard}>
      <div className={styles.createIcon}><Timer size={30} strokeWidth={1.6} /></div>
      <h1>{t('创建计划')}</h1>
      <p>{t('设定目标和最终截止时间，开始拆分任务。')}</p>
      <form className={styles.fields} onSubmit={event => { event.preventDefault(); onCreate({ title, deadlineLocal }) }}>
        <label>{t('计划名称')}<input required maxLength={80} value={title} onChange={e => setTitle(e.target.value)} placeholder={t('例如，本周产品上线')} autoFocus readOnly={busy} /></label>
        <label>{t('最终截止')}<input required type="datetime-local" value={deadlineLocal} onChange={e => setDeadline(e.target.value)} readOnly={busy} /></label>
        <FormError message={error} retry={retry} />
        <button className="primary" disabled={busy} type="submit">{t('开始计划')}</button>
      </form>
      <button className={styles.emptySettings} disabled={busy} onClick={onSettings}>{t('设置与归档历史')}</button>
    </section>
  </main>
}

export function PlanEditor({ field, plan, busy, error, retry, onSubmit, close, onDirty }: {
  field: 'title' | 'deadlineLocal'; plan: Plan; busy: boolean; error?: string; retry?: () => void
  onSubmit: (values: Partial<PlanInput>) => void; close: () => void; onDirty: (dirty: boolean) => void
}) {
  const { t } = useTranslation()
  const rename = field === 'title'
  const [value, setValue] = useState(() => rename ? plan.title : localInput(plan.deadlineAtMs, plan.timeZone))
  return <Modal title={t(rename ? '重命名计划' : '修改最终截止')} busy={busy} close={close}>
    <form className={styles.fields} onSubmit={event => { event.preventDefault(); onSubmit({ [field]: value }) }}>
      <label>{t(rename ? '计划名称' : '最终截止')}
        <input autoFocus required type={rename ? 'text' : 'datetime-local'} maxLength={rename ? 80 : undefined} readOnly={busy}
          value={value} onChange={event => { setValue(event.target.value); onDirty(true) }} />
      </label>
      {!rename && <p className={styles.hint}>{t('计划时区 · {zone}', { zone: plan.timeZone })}</p>}
      <FormError message={error} retry={retry} />
      <div className={styles.formActions}><button type="button" className="secondary" disabled={busy} onClick={close}>{t('取消')}</button>
        <button type="submit" className="primary" disabled={busy}>{t('保存')}</button></div>
    </form>
  </Modal>
}

export function TaskEditor({ task, plan, groups, defaultGroupId, fixed, readOnly, busy, error, retry, onSubmit, close, onDirty }: {
  task?: Task; plan: Plan; fixed: number | null; readOnly: boolean; busy: boolean; error?: string; retry?: () => void
  groups: TaskGroup[]; defaultGroupId?: string
  onSubmit: (values: TaskInput) => void; close: () => void; onDirty: (dirty: boolean) => void
}) {
  const { language, t } = useTranslation()
  const [initialDate, initialTime = '00:00'] = useMemo(() => task?.dueAtMs == null
    ? [''] : localInput(task.dueAtMs, plan.timeZone).split('T'), [task?.dueAtMs, plan.timeZone])
  const [title, setTitle] = useState(task?.title ?? '')
  const [notes, setNotes] = useState(task?.notes ?? '')
  const [groupId, setGroupId] = useState(task?.groupId ?? defaultGroupId ?? '')
  const [dueDate, setDueDate] = useState(initialDate)
  const [dueTime, setDueTime] = useState(initialTime)
  const due = dueDate ? `${dueDate}T${dueTime || '00:00'}` : null
  const dueAtMs = useMemo(() => {
    if (!due) return null
    try {
      return parseLocal(due, plan.timeZone)
    } catch {
      return null
    }
  }, [due, plan.timeZone])
  const now = useClock(fixed)
  const dueWarning = due && dueAtMs === null ? t('请选择计划时区中有效且无歧义的时间。')
    : dueAtMs !== null && dueAtMs > plan.deadlineAtMs ? t('任务截止晚于计划目标，仍可保存。') : ''
  function submit(event: FormEvent) {
    event.preventDefault()
    if (readOnly) return
    onSubmit({ title, notes, dueLocal: due, ...(groups.length > 0 && { groupId: groupId || null }) })
  }
  return <Modal title={t(readOnly ? '任务详情' : task ? '编辑任务' : '添加任务')} busy={busy} close={close}>
    <form className={styles.fields} onChange={() => onDirty(!readOnly)} onSubmit={submit}>
      <label>{t('任务名称')}<input value={title} onChange={e => setTitle(e.target.value)} autoFocus required maxLength={120} readOnly={readOnly || busy} placeholder={t('输入具体任务')} /></label>
      {groups.length > 0 && <label>{t('分组')}<select value={groupId} disabled={readOnly || busy} onChange={event => setGroupId(event.target.value)}>
        <option value="">{t('未分组')}</option>
        {groups.map(group => <option key={group.id} value={group.id}>{group.title}</option>)}
      </select></label>}
      <fieldset className={styles.taskDue}>
        <legend>{t('计划截止')} <small>{t('选填')}</small></legend>
        <input aria-label={t('计划截止日期')} type="date" value={dueDate} readOnly={readOnly || busy} onChange={event => {
          setDueDate(event.target.value)
          if (!event.target.value) setDueTime('00:00')
        }} />
        <input aria-label={t('计划截止时间')} type="time" value={dueDate ? dueTime : ''}
          disabled={!dueDate} readOnly={readOnly || busy} onChange={event => setDueTime(event.target.value)}
          onBlur={() => { if (!dueTime) setDueTime('00:00') }} />
      </fieldset>
      {dueWarning && <p className="danger-text">{dueWarning}</p>}
      {!readOnly && dueAtMs !== null && <p className={styles.hint}>
        {dueAtMs > now ? t('距任务截止 {duration}', { duration: duration(dueAtMs - now, 'down', language) }) : t('任务已到截止时间')}
      </p>}
      <label>{t('备注')} <small>{t('选填')}</small><textarea rows={4} maxLength={2000} value={notes} readOnly={readOnly || busy} onChange={e => setNotes(e.target.value)} placeholder={t('记录与任务有关的细节')} /></label>
      <FormError message={error} retry={retry} />
      <div className={styles.formActions}><button type="button" className="secondary" disabled={busy} onClick={close}>{t(readOnly ? '关闭' : '取消')}</button>
        {!readOnly && <button type="submit" className="primary" disabled={busy}>{t('保存任务')}</button>}</div>
    </form>
  </Modal>
}

export function GroupEditor({ group, busy, error, retry, close, onDirty, onSubmit }: {
  group?: TaskGroup; busy: boolean; error?: string; retry?: () => void
  close: () => void; onDirty: (dirty: boolean) => void; onSubmit: (title: string) => void
}) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(group?.title ?? '')
  return <Modal title={t(group ? '重命名分组' : '添加分组')} busy={busy} close={close}>
    <form className={styles.fields} onSubmit={event => {
      event.preventDefault()
      if (title.trim()) onSubmit(title)
    }}>
      <label>{t('分组名称')}<input value={title} autoFocus required maxLength={MAX_GROUP_TITLE_LENGTH}
        readOnly={busy} onChange={event => { setTitle(event.target.value); onDirty(true) }} /></label>
      <FormError message={error} retry={retry} />
      <div className={styles.formActions}>
        <button type="button" className="secondary" disabled={busy} onClick={close}>{t('取消')}</button>
        <button type="submit" className="primary" disabled={busy || !title.trim()}>{t('保存分组')}</button>
      </div>
    </form>
  </Modal>
}

export function Settings({ snapshot, pinned, compact, showTaskGroups, busy, error, retry, close, onDirty,
  save, onPin, onCompact, onTaskGrouping, onLanguage, onHistory, onArchive, onExport, onImport }: {
  snapshot: Snapshot | null; pinned: boolean; compact: boolean; showTaskGroups: boolean; busy: boolean
  error?: string; retry?: () => void
  close: () => void; onDirty: (dirty: boolean) => void
  save: (deductRest: boolean, rules: RuleInput[]) => void; onPin: () => void; onCompact: () => void
  onTaskGrouping: (enabled: boolean) => void; onHistory: () => void
  onLanguage: (language: Language) => void
  onArchive: () => void; onExport: () => void; onImport: () => void
}) {
  const { language, t } = useTranslation()
  const languageId = useId()
  const [deduct, setDeduct] = useState(snapshot?.plan.deductRest ?? true)
  const [rules, setRules] = useState(() => snapshot?.restRules.map(({ id, label, startLocal, endLocal, enabled }) =>
    ({ id, label, startLocal, endLocal, enabled })) ?? [])
  const [changed, setChanged] = useState(false)
  function dirty() { setChanged(true); onDirty(true) }
  function patchRule(id: string, patch: Partial<RuleInput>) {
    setRules(current => current.map(rule => rule.id === id ? { ...rule, ...patch } : rule))
    dirty()
  }
  const sameTimes = rules.some(x => x.startLocal && x.startLocal === x.endLocal)
  const blocked = busy || changed
  return <Modal title={t('设置')} busy={busy} close={close} drawer>
    <div className={styles.drawerContent}>
      <section className={styles.drawerSection}>
        <div className={styles.toggleLine}>
          <label htmlFor={languageId}>{t('语言')}</label>
          <select id={languageId} value={language} disabled={busy}
            onChange={event => onLanguage(event.target.value === 'en' ? 'en' : 'zh-CN')}>
            <option value="zh-CN" lang="zh-CN">简体中文</option>
            <option value="en" lang="en">English</option>
          </select>
        </div>
      </section>
      {snapshot && <form className={styles.drawerSection}
        onSubmit={event => { event.preventDefault(); save(deduct, rules.map(({ id: _id, ...rule }) => rule)) }}>
        <h3>{t('休息规则')}</h3>
        <label className={styles.toggleLine}>{t('扣除休息时间')}<input type="checkbox" role="switch"
          checked={deduct} disabled={busy} onChange={e => { setDeduct(e.target.checked); dirty() }} /></label>
        <p className={styles.hint}>{t('时段每天重复。更新后将按新规则重新计算整个计划的有效时间。')}</p>
        <div className={styles.rules}>
          {rules.map((rule, index) => <fieldset className={styles.rule} key={rule.id} disabled={busy}>
            <legend className="sr-only">{t('休息时段 {index}', { index: index + 1 })}</legend>
            <div className={styles.ruleTop}>
              <input aria-label={t('时段 {index} 名称', { index: index + 1 })} required maxLength={80} value={rule.label}
                onChange={e => patchRule(rule.id, { label: e.target.value })} />
              <input type="checkbox" role="switch" aria-label={t('启用 {label}', { label: rule.label })} checked={rule.enabled}
                onChange={e => patchRule(rule.id, { enabled: e.target.checked })} />
              <button type="button" className="icon-button" aria-label={t('删除 {label}', { label: rule.label })} disabled={busy}
                onClick={() => { setRules(current => current.filter(x => x.id !== rule.id)); dirty() }}><Trash2 size={19} /></button>
            </div>
            <div className={styles.ruleTime}>
              <input type="time" aria-label={t('{label} 开始', { label: rule.label })} required value={rule.startLocal}
                onChange={e => patchRule(rule.id, { startLocal: e.target.value })} />
              <span>{t('至')}</span>
              <input type="time" aria-label={t('{label} 结束', { label: rule.label })} required value={rule.endLocal}
                onChange={e => patchRule(rule.id, { endLocal: e.target.value })} />
              <small>{t(rule.endLocal < rule.startLocal ? '次日' : '当日')}</small>
            </div>
          </fieldset>)}
        </div>
        {sameTimes && <p className="danger-text">{t('休息时段的起止时间不能相同。')}</p>}
        <div className={styles.sectionActions}>
          <button type="button" className="secondary" disabled={busy || rules.length >= 20}
            onClick={() => { setRules(current => [...current, { id: crypto.randomUUID(), label: t('休息'), startLocal: '15:00', endLocal: '15:15', enabled: true }]); dirty() }}>
            <Plus size={18} /> {t('添加时段')}</button>
          <button className="primary" type="submit" disabled={busy || !changed || sameTimes}>{t('保存设置')}</button>
        </div>
      </form>}
      <section className={styles.drawerSection}>
        <h3>{t('窗口与计划')}</h3>
        <label className={styles.toggleLine}>{t('桌面小窗')}<input type="checkbox" role="switch" checked={compact} disabled={busy} onChange={onCompact} /></label>
        {compact && <p className={styles.hint}>{t('关闭小窗后，可从系统托盘恢复或退出。')}</p>}
        <label className={styles.toggleLine}>{t('窗口置顶')}<input type="checkbox" role="switch" checked={pinned} disabled={busy} onChange={onPin} /></label>
        <label className={styles.toggleLine}>{t('显示任务分组')}<input type="checkbox" role="switch"
          checked={showTaskGroups} disabled={busy} onChange={event => onTaskGrouping(event.target.checked)} /></label>
        {snapshot && <div className={styles.toggleLine}>{t('计划时区')} <span>{snapshot.plan.timeZone}</span></div>}
        <div className={styles.sectionActions}>
          <button className="secondary" disabled={blocked} onClick={onHistory}><Archive size={16} /> {t('归档历史')}</button>
          {snapshot && <button className="secondary" disabled={blocked} onClick={onArchive}>{t('归档当前计划')}</button>}
        </div>
      </section>
      <section className={styles.drawerSection}>
        <h3>{t('数据备份')}</h3>
        <p className={styles.hint}>{t('备份包含本机的计划、任务和设置。')}</p>
        <div className={styles.sectionActions}>
          <button className="secondary" disabled={blocked} onClick={onExport}><Download size={17} /> {t('导出备份')}</button>
          <button className="secondary" disabled={blocked} onClick={onImport}><Upload size={17} /> {t('导入备份')}</button>
        </div>
      </section>
      <FormError message={error} retry={retry} />
    </div>
  </Modal>
}

export function History({ plans, total, offset, onPage, onOpen, close, busy, error, retry }: {
  plans: Plan[]; total: number; offset: number; onPage: (offset: number) => void; onOpen: (plan: Plan) => void
  close: () => void; busy: boolean; error?: string; retry?: () => void
}) {
  const { language, t } = useTranslation()
  return <Modal title={t('归档历史')} busy={busy} close={close} drawer>
    <div className={styles.drawerContent}>
      {plans.length === 0 && !busy && <p className={styles.hint}>{t('暂无归档计划。')}</p>}
      <div className={styles.historyList}>
        {plans.map(plan => <button key={plan.id} disabled={busy} onClick={() => onOpen(plan)}>
          <strong>{plan.title}</strong>
          <span>{t('最终截止 {date}', { date: fullDate(plan.deadlineAtMs, plan.timeZone, language) })}</span>
          <small>{t('归档于 {date}', { date: fullDate(plan.archivedAtMs!, plan.timeZone, language) })}</small>
        </button>)}
      </div>
      <div className={styles.sectionActions}>
        {offset > 0 && <button className="secondary" disabled={busy} onClick={() => onPage(Math.max(0, offset - 25))}>{t('上一页')}</button>}
        {offset + plans.length < total && <button className="secondary" disabled={busy} onClick={() => onPage(offset + plans.length)}>{t('下一页')}</button>}
      </div>
      <FormError message={error} retry={retry} />
    </div>
  </Modal>
}
