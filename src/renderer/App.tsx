import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, ArrowLeft, LoaderCircle, Maximize2, Minimize2, PictureInPicture2, Pin, Plus, Settings as Gear, Timer, X } from 'lucide-react'
import { PRODUCT_NAME, type AppError, type HistoryPage, type Operations, type Result, type Revision, type Snapshot, type Task, type TaskGroup, type WindowState } from '../shared/domain'
import { DEFAULT_LANGUAGE, translator, type Message } from '../shared/language'
import { Dashboard, TimerStatus } from './Dashboard'
import { EmptyState, FormError, GroupEditor, History, Modal, PlanEditor, Settings, TaskEditor } from './Forms'
import { fullDate, useRestIndex } from './clock'
import { LanguageContext, useDocumentLanguage } from './language'
import styles from './App.module.css'

const api = window.tsTimer
type Overlay =
  | { type: 'title' | 'deadlineLocal' | 'settings' | 'history' | 'archive' }
  | { type: 'task'; task?: Task; defaultGroupId?: string }
  | { type: 'group'; group?: TaskGroup }
  | { type: 'deleteGroup'; group: TaskGroup }
type Failure = AppError & { retry?: () => void }
type Notice = {
  id: string; message: Message; until: number; undo?: () => void; values?: Record<string, number>
}

function reference(snapshot: Snapshot): Revision {
  return { planId: snapshot.plan.id, expectedRevision: snapshot.plan.revision }
}

export function App() {
  const [ready, setReady] = useState(false)
  const [active, setActive] = useState<Snapshot | null>(null)
  const current = useRef<Snapshot | null>(null)
  const [archived, setArchived] = useState<Snapshot | null>(null)
  const [fixed, setFixed] = useState<number | null>(null)
  const [desktop, setDesktop] = useState<WindowState>({
    pinned: false, compact: false, mini: false, showTaskGroups: false, language: DEFAULT_LANGUAGE
  })
  const { pinned, compact, mini, showTaskGroups, language } = desktop
  const t = translator(language)
  useDocumentLanguage(language)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [history, setHistory] = useState<HistoryPage & { offset: number }>({ plans: [], total: 0, offset: 0 })
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [failure, setFailure] = useState<Failure>()
  const [notices, setNotices] = useState<Notice[]>([])
  const [emptyDirty, setEmptyDirty] = useState(false)
  const [formDirty, setFormDirty] = useState(false)

  function replaceActive(snapshot: Snapshot | null) {
    current.current = snapshot
    setActive(snapshot)
  }

  function readyUp() {
    void perform(async () => {
      const snapshot = await api['plan:get'](undefined)
      if (!snapshot.ok) return snapshot
      const desktopState = await api['window:getState'](undefined)
      if (!desktopState.ok) return desktopState
      const demoClock = await api['app:demoClock'](undefined)
      if (!demoClock.ok) return demoClock
      return { ok: true, data: { snapshot: snapshot.data, desktop: desktopState.data, fixed: demoClock.data } }
    }, result => {
      replaceActive(result.snapshot)
      setDesktop(result.desktop)
      setFixed(result.fixed)
      setStatus(result.snapshot ? 'saved' : 'idle')
      setReady(true)
    }, false)
  }

  useEffect(readyUp, [])
  useEffect(() => api.onMiniClosed(() => setDesktop(state => ({ ...state, mini: false }))), [])

  useEffect(() => {
    if (!emptyDirty && !formDirty && !busy) return
    const stop = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', stop)
    return () => window.removeEventListener('beforeunload', stop)
  }, [emptyDirty, formDirty, busy])

  useEffect(() => {
    if (!notices.length) return
    const next = Math.min(...notices.map(item => item.until))
    const timer = setTimeout(() => setNotices(items => items.filter(item => item.until > Date.now())), Math.max(0, next - Date.now()))
    return () => clearTimeout(timer)
  }, [notices])

  const dirty = useCallback((value: boolean) => {
    setFormDirty(value)
    if (value) setFailure(undefined)
  }, [])
  const draft = useCallback((value: boolean) => {
    setEmptyDirty(value)
    if (value) setFailure(undefined)
  }, [])

  async function perform<T>(action: () => Promise<Result<T>>, accept: (data: T) => void, saving: boolean) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    if (saving) setStatus('saving')
    setFailure(undefined)
    try {
      const result = await action()
      if (!result.ok) {
        const error = result.error
        if (error.code === 'REVISION_CONFLICT' || error.code === 'PLAN_ARCHIVED') {
          const fresh = await api['plan:get'](undefined)
          if (fresh.ok) replaceActive(fresh.data)
        }
        setFailure({ ...error, retry: error.retryable ? () => void perform(action, accept, saving) : undefined })
        if (saving) setStatus('idle')
        return
      }
      accept(result.data)
      if (saving) setStatus('saved')
    } catch {
      setFailure({
        code: 'CONNECTION_ERROR', message: t('无法连接桌面服务，请重试。'), retryable: true,
        retry: () => void perform(action, accept, saving)
      })
      if (saving) setStatus('idle')
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  function call<K extends keyof Operations>(key: K, payload: Operations[K][0],
    accept: (data: Operations[K][1]) => void, saving = true) {
    const method = api[key] as (input: Operations[K][0]) => Promise<Result<Operations[K][1]>>
    void perform(() => method(payload), accept, saving)
  }

  function show(next: Overlay | null) {
    setOverlay(next)
    setFailure(undefined)
    setFormDirty(false)
  }

  function commit(snapshot: Snapshot) {
    replaceActive(snapshot)
    show(null)
  }

  function flash(message: Message, {
    until = Date.now() + 4500, undo, values
  }: Pick<Notice, 'undo' | 'values'> & { until?: number } = {}) {
    const id = crypto.randomUUID()
    setNotices(items => [...items, { id, message, until, values, undo: undo && (() => {
      setNotices(currentItems => currentItems.filter(item => item.id !== id))
      undo()
    }) }])
  }

  function changePin() {
    call('window:setPin', { enabled: !pinned }, value => setDesktop(state => ({ ...state, pinned: value })), false)
  }

  function changeCompact() {
    call('window:setCompact', { enabled: !compact }, setDesktop, false)
  }

  function changeMini() {
    call('window:setMini', { enabled: !mini }, setDesktop, false)
  }

  function pageHistory(offset: number) {
    call('history:list', { offset }, result => setHistory({ ...result, offset }), false)
  }

  function openHistory() {
    show({ type: 'history' })
    setHistory({ plans: [], total: 0, offset: 0 })
    pageHistory(0)
  }

  function archivePlan() {
    if (!active) return
    call('plan:archive', reference(active), result => {
      replaceActive(null)
      show(null)
      setNotices([])
      flash('计划已归档', { until: result.undoUntil, undo: () => call('plan:undoArchive', result.ref, commit) })
    })
  }

  const displayed = archived ?? active
  const index = useRestIndex(displayed)
  const clock = archived ? archived.plan.archivedAtMs : fixed
  const formFeedback = { busy, error: failure?.message, retry: failure?.retry, close: () => show(null) }
  const compactLabel = t(compact ? '恢复主窗口' : '桌面小窗')
  const miniLabel = t(mini ? '关闭迷你悬浮窗' : '打开迷你悬浮窗')
  const pinLabel = t(pinned ? '取消窗口置顶' : '窗口置顶')
  const footer = displayed && <footer className={styles.statusBar}>
    {archived ? <span><Archive size={13} /> {t('归档快照')}</span> :
      <TimerStatus snapshot={displayed} index={index!} fixed={fixed} />}
    {failure && !overlay && active ? <FormError message={failure.message} retry={failure.retry} /> :
      <span role="status">{status === 'saving' ? t('保存中…') : status === 'saved' ? t('已保存') : ''}</span>}
  </footer>
  return <LanguageContext value={language}><div className={styles.window} data-window-mode={compact ? 'compact' : 'regular'}>
    <div className={styles.titleBar}>
      <div className={styles.brand} title={fixed === null ? PRODUCT_NAME : t('{name} · 开发演示', { name: PRODUCT_NAME })}>
        <Timer size={19} strokeWidth={1.8} /> <span>{PRODUCT_NAME}</span></div>
      <div className={styles.titleControls}>
        {active && !archived && <>
          <button className={`primary ${styles.newTask}`} aria-label={t('添加任务')} disabled={busy}
            onClick={() => show({ type: 'task' })}><Plus size={15} />{t('任务')}</button>
          <button className="icon-button" aria-label={t('设置')} title={t('设置')} disabled={busy}
            onClick={() => show({ type: 'settings' })}><Gear size={16} /></button>
        </>}
        {active && <button className="icon-button" aria-label={miniLabel} title={miniLabel}
          aria-pressed={mini} disabled={busy} onClick={changeMini}><PictureInPicture2 size={15} /></button>}
        <button className="icon-button" aria-label={compactLabel} title={compactLabel}
          aria-pressed={compact} disabled={!ready || busy} onClick={changeCompact}>
          {compact ? <Maximize2 size={14} /> : <Minimize2 size={15} />}
        </button>
        <button className="icon-button" aria-label={pinLabel} aria-pressed={pinned} title={pinLabel}
          disabled={!ready || busy} onClick={changePin}><Pin size={15} /></button>
      </div>
    </div>

    {!ready ? <main className={styles.loading}>
      {failure ? <FormError message={failure.message} retry={failure.retry ?? readyUp} /> :
        <><LoaderCircle className={styles.spinner} size={22} /> {t('正在打开本地计划')}</>}
    </main> : displayed ?
      <Dashboard key={displayed.plan.id} snapshot={displayed} index={index!} fixed={clock} readonly={Boolean(archived)} busy={busy}
        footer={footer} showTaskGroups={showTaskGroups}
        onTitle={() => show({ type: 'title' })} onDeadline={() => show({ type: 'deadlineLocal' })}
        onTask={(task, defaultGroupId) => show({ type: 'task', task, defaultGroupId })}
        onGroup={group => show({ type: 'group', group })}
        onDeleteGroup={group => show({ type: 'deleteGroup', group })}
        onStatus={(task, next) => active && call('task:status',
          { ...reference(active), taskId: task.id, status: next }, replaceActive)}
        onDelete={task => active && call('task:delete', { ...reference(active), taskId: task.id }, result => {
          const planId = active.plan.id
          replaceActive(result.snapshot)
          flash('任务已删除', { until: result.undoUntil, undo: () => {
            const latest = current.current
            if (latest?.plan.id === planId) {
              call('task:restore', { ...reference(latest), taskId: task.id }, replaceActive)
            }
          } })
        })}>
        {archived && <div className={styles.archiveBar}>
          <button className="secondary" onClick={() => { setArchived(null); openHistory() }}><ArrowLeft size={16} /> {t('归档历史')}</button>
          <span><Archive size={15} /> {t('已归档 · {date} · 只读', {
            date: fullDate(archived.plan.archivedAtMs!, archived.plan.timeZone, language)
          })}</span>
        </div>}
      </Dashboard> :
      <EmptyState busy={busy} error={overlay ? undefined : failure?.message} retry={overlay ? undefined : failure?.retry}
        onDirty={draft} onSettings={() => show({ type: 'settings' })}
        onCreate={values => call('plan:create', values, snapshot => { setNotices([]); commit(snapshot) })} />}

    <div className={styles.notices} aria-live="polite">
      {notices.map(item => <div className={styles.notice} key={item.id}>
        <span>{t(item.message, item.values)}</span>
        {item.undo && <button className={styles.undo} disabled={busy} onClick={item.undo}>{t('撤销')}</button>}
        <button className="icon-button" aria-label={t('关闭提示')}
          onClick={() => setNotices(items => items.filter(x => x.id !== item.id))}><X size={16} /></button>
      </div>)}
    </div>

    {(overlay?.type === 'title' || overlay?.type === 'deadlineLocal') && active &&
      <PlanEditor key={overlay.type} {...formFeedback} field={overlay.type} plan={active.plan} onDirty={dirty}
        onSubmit={values => call('plan:update', { ...reference(active), ...values }, commit)} />}
    {overlay?.type === 'task' && displayed &&
      <TaskEditor key={overlay.task?.id ?? 'new'} {...formFeedback} task={overlay.task} plan={displayed.plan} fixed={clock}
        groups={showTaskGroups ? displayed.groups : []} defaultGroupId={overlay.defaultGroupId}
        readOnly={Boolean(archived)} onDirty={dirty} onSubmit={values => {
          if (!active) return
          const payload = { ...reference(active), ...values }
          if (overlay.task) call('task:update', { ...payload, taskId: overlay.task.id }, commit)
          else call('task:create', payload, commit)
        }} />}
    {overlay?.type === 'group' && active && <GroupEditor key={overlay.group?.id ?? 'new'} {...formFeedback}
      group={overlay.group} onDirty={dirty} onSubmit={title => {
        const payload = { ...reference(active), title }
        if (overlay.group) call('group:update', { ...payload, groupId: overlay.group.id }, commit)
        else call('group:create', payload, commit)
      }} />}
    {overlay?.type === 'deleteGroup' && active && <Modal title={t('删除分组')} busy={busy} close={() => show(null)}>
      <div className={styles.confirm}>
        <p>{t('删除「{title}」后，该分组的任务会移到「未分组」。', { title: overlay.group.title })}</p>
        <FormError message={failure?.message} retry={failure?.retry} />
        <div>
          <button className="secondary" disabled={busy} onClick={() => show(null)}>{t('取消')}</button>
          <button className="secondary danger-text" disabled={busy}
            onClick={() => call('group:delete', { ...reference(active), groupId: overlay.group.id }, commit)}>{t('删除分组')}</button>
        </div>
      </div>
    </Modal>}
    {overlay?.type === 'settings' && <Settings {...formFeedback} snapshot={active} pinned={pinned} compact={compact}
      showTaskGroups={showTaskGroups} onDirty={dirty}
      save={(deductRest, rules) => active && call('rest:replace', { ...reference(active), deductRest, rules }, commit)}
      onPin={changePin} onCompact={changeCompact} onHistory={openHistory} onArchive={() => show({ type: 'archive' })}
      onTaskGrouping={enabled => call('settings:setTaskGrouping', { enabled }, setDesktop, false)}
      onLanguage={next => call('settings:setLanguage', { language: next },
        value => setDesktop(state => ({ ...state, language: value })), false)}
      onExport={() => call('backup:export', undefined, counts => {
        if (counts) { show(null); flash('已导出 {plans} 个计划、{tasks} 条任务', { values: { ...counts } }) }
      }, false)}
      onImport={() => call('backup:import', undefined, result => {
        if (result) {
          setDesktop(result.window)
          setNotices([])
          replaceActive(result.snapshot)
          show(null)
          flash('已恢复 {plans} 个计划、{tasks} 条任务', { values: { ...result.counts } })
        }
      }, false)} />}
    {overlay?.type === 'history' && <History {...formFeedback} {...history} onPage={pageHistory}
      onOpen={plan => call('history:get', { planId: plan.id }, snapshot => { setArchived(snapshot); show(null) }, false)} />}
    {overlay?.type === 'archive' && <Modal title={t('归档当前计划')} busy={busy} close={() => show({ type: 'settings' })}>
      <div className={styles.confirm}>
        <p>{t('将「{title}」移入只读历史。归档后可创建新计划。', { title: active?.plan.title ?? '' })}</p>
        <FormError message={failure?.message} retry={failure?.retry} />
        <div><button className="secondary" disabled={busy} onClick={() => show({ type: 'settings' })}>{t('取消')}</button>
          <button className="primary" disabled={busy} onClick={archivePlan}>{t('确认归档')}</button></div>
      </div>
    </Modal>}
  </div></LanguageContext>
}
