import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, screen, Tray, type IpcMainInvokeEvent, type Rectangle } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PRODUCT_NAME, type MiniCountdown, type Operations, type Result, type WindowState } from '../shared/domain'
import { DEFAULT_LANGUAGE, translator } from '../shared/language'
import { backupSchema, inputSchemas, windowBounds } from '../shared/schemas'
import { demoData, demoNow } from './demo'
import { OperationError } from './errors'
import { Store } from './store'

const demo = !app.isPackaged && process.argv.includes('--demo')
const rendererFile = resolve(__dirname, '../renderer/index.html')
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const expectedUrl = devUrl ? new URL(devUrl).href : pathToFileURL(rendererFile).href
const miniUrl = new URL(expectedUrl)
miniUrl.searchParams.set('view', 'mini')
const iconPath = join(app.isPackaged ? process.resourcesPath : join(__dirname, '../../build'), 'icon.ico')
const sizes = {
  regular: { width: 1080, height: 704, minWidth: 780, minHeight: 520 },
  compact: { width: 420, height: 598, minWidth: 355, minHeight: 420 }
}
let window: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null
let miniDeadline: number | null = null
let tray: Tray | null = null
let store: Store
let compact = false
let quitting = false
let importInProgress = false
let backupDialogOpen = false
let closing = false
let backupInterval: ReturnType<typeof setInterval> | undefined
let boundsTimer: ReturnType<typeof setTimeout> | undefined
const localized = () => translator(store?.language ?? DEFAULT_LANGUAGE)

app.setName(PRODUCT_NAME)
const profile = app.commandLine.getSwitchValue('user-data-dir')
const profileDirectory = profile ? resolve(profile) : join(app.getPath('appData'), 'TS Timer')
mkdirSync(profileDirectory, { recursive: true })
app.setPath('userData', profileDirectory)
if (demo) app.setPath('userData', `${app.getPath('userData')}-demo`)

function log(error: unknown) {
  try {
    const dir = join(app.getPath('userData'), 'data')
    mkdirSync(dir, { recursive: true })
    const details = error instanceof Error ? error.stack ?? error.message : String(error)
    appendFileSync(join(dir, 'app.log'), `[${new Date().toISOString()}] ${details}\n`)
  } catch {
    console.error(error)
  }
}

function validCaller(event: IpcMainInvokeEvent, channel: keyof Operations) {
  const fromMini = channel === 'mini:getCountdown'
  const target = fromMini ? miniWindow : window
  return target && event.sender === target.webContents && event.senderFrame === event.sender.mainFrame
    && event.senderFrame?.url === (fromMini ? miniUrl.href : expectedUrl)
}

function on<K extends keyof Operations>(
  channel: K,
  handler: (input: Operations[K][0]) => Operations[K][1] | Promise<Operations[K][1]>,
  writes = false
) {
  ipcMain.handle(channel, async (event, payload: unknown): Promise<Result<Operations[K][1]>> => {
    try {
      if (!validCaller(event, channel)) throw new OperationError('FORBIDDEN', '请求来源无效。')
      const result = inputSchemas[channel].safeParse(payload)
      if (!result.success) {
        throw new OperationError('VALIDATION_ERROR', '请检查必填内容、长度、日期和预计时长。休息起止时间不能相同。')
      }
      if (writes && importInProgress) throw new OperationError('DB_BUSY', '正在恢复备份，完成后可重试。', true)
      return { ok: true, data: await handler(result.data as Operations[K][0]) }
    } catch (error) {
      const t = localized()
      if (error instanceof OperationError) {
        return { ok: false, error: { code: error.code, message: t(error.message), retryable: error.retryable } }
      }
      log(error)
      return { ok: false, error: {
        code: writes ? 'DB_WRITE_FAILED' : 'DATA_ACCESS_FAILED',
        message: t(writes ? '无法保存，请检查数据目录权限和磁盘空间后重试。' : '无法读取数据，请重试。'),
        retryable: true
      } }
    }
  })
}

async function backupDialog<T>(work: (owner: BrowserWindow) => Promise<T>) {
  if (backupDialogOpen || !window) throw new OperationError('DB_BUSY', '备份操作正在进行。', true)
  backupDialogOpen = true
  try {
    return await work(window)
  } finally {
    backupDialogOpen = false
  }
}

const jsonFilter = () => [{ name: localized()('{name} JSON 备份', { name: PRODUCT_NAME }), extensions: ['json'] }]

function registerHandlers() {
  on('plan:get', () => store.getActive())
  on('plan:create', input => store.create(input), true)
  on('plan:update', input => {
    const snapshot = store.update(input)
    syncMiniCountdown(snapshot.plan.deadlineAtMs)
    return snapshot
  }, true)
  on('plan:archive', input => {
    const archived = store.archive(input)
    miniWindow?.close()
    return archived
  }, true)
  on('plan:undoArchive', input => store.undoArchive(input), true)
  on('task:create', input => store.createTask(input), true)
  on('task:update', input => store.updateTask(input), true)
  on('task:status', input => store.setStatus(input), true)
  on('task:delete', input => store.deleteTask(input), true)
  on('task:restore', input => store.restoreTask(input), true)
  on('group:create', input => store.createGroup(input), true)
  on('group:update', input => store.updateGroup(input), true)
  on('group:delete', input => store.deleteGroup(input), true)
  on('settings:setTaskGrouping', ({ enabled }) => {
    store.setSetting('showTaskGroups', enabled)
    return windowState()
  }, true)
  on('settings:setLanguage', ({ language }) => {
    store.setSetting('language', language)
    sendMiniCountdown()
    syncTray()
    return language
  }, true)
  on('rest:replace', input => store.replaceRest(input), true)
  on('history:list', ({ offset }) => store.history(offset))
  on('history:get', ({ planId }) => store.archived(planId))
  on('window:getState', windowState)
  on('window:setPin', ({ enabled }) => {
    store.setSetting('pinned', enabled)
    window!.setAlwaysOnTop(enabled)
    return window!.isAlwaysOnTop()
  }, true)
  on('window:setCompact', ({ enabled }) => {
    if (enabled === compact) return windowState()
    clearTimeout(boundsTimer)
    saveBounds()
    store.setCompact(enabled)
    applyWindowMode(enabled, store.getSetting('pinned') === true)
    return windowState()
  }, true)
  on('window:setMini', async ({ enabled }) => {
    if (enabled && !miniWindow) {
      const plan = store.getActivePlan()
      if (!plan) throw new OperationError('PLAN_NOT_FOUND', '请先创建计划，再打开迷你悬浮窗。')
      await createMiniWindow(plan.deadlineAtMs)
    } else if (!enabled) miniWindow?.close()
    return windowState()
  })
  on('mini:getCountdown', currentMiniCountdown)
  on('app:demoClock', () => demo ? demoNow : null)
  on('backup:export', () => backupDialog(async owner => {
    const t = localized()
    const { filePath } = await dialog.showSaveDialog(owner, {
      title: t('导出 {name} 备份', { name: PRODUCT_NAME }),
      defaultPath: `DD-Timer-${new Date().toISOString().slice(0, 10)}.json`, filters: jsonFilter()
    })
    if (!filePath) return null
    const data = store.exportData()
    const temp = `${filePath}.${randomUUID()}.partial`
    try {
      await writeFile(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx' })
      await rename(temp, filePath)
    } catch (error) {
      log(error)
      throw new OperationError('EXPORT_FAILED', '无法写入备份，请检查目标目录权限或选择其他位置。', true)
    } finally {
      await rm(temp, { force: true }).catch(log)
    }
    return { plans: data.plans.length, tasks: data.tasks.length }
  }))
  on('backup:import', () => backupDialog(async owner => {
    const t = localized()
    const { filePaths } = await dialog.showOpenDialog(owner, {
      title: t('选择 {name} 备份', { name: PRODUCT_NAME }), properties: ['openFile'], filters: jsonFilter()
    })
    if (!filePaths.length) return null
    let raw: unknown
    try {
      raw = JSON.parse((await readFile(filePaths[0], 'utf8')).replace(/^\uFEFF/, ''))
    } catch {
      throw new OperationError('IMPORT_INVALID', '无法读取此 JSON 备份，请检查文件。')
    }
    const validated = backupSchema.safeParse(raw)
    if (!validated.success) {
      throw new OperationError('IMPORT_INVALID', '备份数据损坏或版本不受支持。')
    }
    const data = validated.data
    const counts = { plans: data.plans.length, tasks: data.tasks.length }
    const { response } = await dialog.showMessageBox(owner, {
      type: 'warning', title: t('替换现有数据'), message: t('导入将替换此应用中的现有数据。'),
      detail: t('这份备份包含 {plans} 个计划、{tasks} 条任务。替换前会保存当前数据库的恢复副本。', counts),
      buttons: [t('取消'), t('替换数据')], defaultId: 0, cancelId: 0
    })
    if (response !== 1) return null
    importInProgress = true
    try {
      await store.safetyBackup('before-import')
      const snapshot = store.replaceData(data)
      syncMiniCountdown(snapshot?.plan.deadlineAtMs ?? null)
      const nextCompact = data.settings.compact === true
      if (compact !== nextCompact) applyWindowMode(nextCompact, data.settings.pinned)
      else {
        owner.setAlwaysOnTop(data.settings.pinned)
        const saved = compact ? data.settings.compactBounds : data.settings.windowBounds
        if (saved && !owner.isMaximized()) owner.setBounds(visibleBounds())
      }
      return { snapshot, counts, window: windowState() }
    } finally {
      importInProgress = false
    }
  }), true)
}

function syncClock() {
  for (const target of [window, miniWindow]) {
    if (target && !target.isDestroyed()) target.webContents.send('app:clockSync')
  }
}

function showWindow() {
  if (window?.isMinimized()) window.restore()
  window?.show()
  window?.focus()
}

function syncTray() {
  if (!compact && !miniWindow) {
    tray?.destroy()
    tray = null
    return
  }
  if (!tray) {
    tray = new Tray(iconPath)
    tray.setToolTip(PRODUCT_NAME)
    tray.on('click', showWindow)
  }
  const t = localized()
  const items = [{ label: t('显示 {name}', { name: PRODUCT_NAME }), click: showWindow }]
  if (miniWindow) items.push({ label: t('关闭迷你悬浮窗'), click: () => miniWindow?.close() })
  items.push({ label: t('退出 {name}', { name: PRODUCT_NAME }), click: () => app.quit() })
  tray.setContextMenu(Menu.buildFromTemplate(items))
}

function windowState(): WindowState {
  return {
    compact, pinned: window?.isAlwaysOnTop() ?? false, mini: Boolean(miniWindow),
    showTaskGroups: store.getSetting('showTaskGroups') === true,
    language: store.language
  }
}

function currentMiniCountdown(): MiniCountdown | null {
  return miniDeadline === null ? null : {
    deadlineAtMs: miniDeadline, fixedNow: demo ? demoNow : null, language: store.language
  }
}

function sendMiniCountdown() {
  if (miniWindow) miniWindow.webContents.send('mini:countdown', currentMiniCountdown())
}

function syncMiniCountdown(deadline: number | null) {
  if (!miniWindow || miniDeadline === deadline) return
  if (deadline === null) {
    miniWindow.close()
    return
  }
  miniDeadline = deadline
  sendMiniCountdown()
}

function miniBounds(area: Rectangle): Rectangle {
  const width = 264
  const height = 94
  return {
    x: area.x + Math.max(0, area.width - width - 14),
    y: area.y + Math.max(0, Math.min(14, area.height - height)),
    width, height
  }
}

async function createMiniWindow(deadline: number) {
  const display = screen.getDisplayMatching(window!.getBounds())
  const mini = new BrowserWindow({
    ...miniBounds(display.workArea),
    title: `${PRODUCT_NAME} · ${localized()('迷你悬浮窗')}`,
    icon: iconPath,
    show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    hasShadow: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  })
  miniDeadline = deadline
  miniWindow = mini
  mini.removeMenu()
  mini.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mini.webContents.on('will-navigate', event => event.preventDefault())
  mini.webContents.on('context-menu', () => {
    const t = localized()
    Menu.buildFromTemplate([
      { label: t('显示主窗口'), click: showWindow },
      { label: t('关闭迷你悬浮窗'), click: () => mini.close() }
    ]).popup({ window: mini })
  })
  mini.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault()
      mini.close()
    }
  })
  mini.once('ready-to-show', () => mini.showInactive())
  mini.on('focus', syncClock)
  mini.on('closed', () => {
    miniWindow = null
    miniDeadline = null
    if (window && !window.isDestroyed()) window.webContents.send('window:miniClosed')
    if (quitting) return
    if (!compact && window && !window.isVisible() && !window.isMinimized()) showWindow()
    syncTray()
  })
  try {
    await mini.loadURL(miniUrl.href)
    syncTray()
  } catch (error) {
    if (!mini.isDestroyed()) mini.destroy()
    throw error
  }
}

function applyWindowMode(enabled: boolean, pinned: boolean) {
  const owner = window!
  compact = enabled
  if (owner.isMaximized()) owner.unmaximize()
  const mode = sizes[compact ? 'compact' : 'regular']
  owner.setMinimumSize(mode.minWidth, mode.minHeight)
  owner.setMaximizable(!compact)
  owner.setBounds(visibleBounds())
  owner.setAlwaysOnTop(pinned)
  syncTray()
}

const boundsKey = () => compact ? 'compactBounds' : 'windowBounds'

function visibleBounds() {
  const mode = sizes[compact ? 'compact' : 'regular']
  const saved = windowBounds.safeParse(store.getSetting(boundsKey())).data
  const display = saved ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay()
  const area = display.workArea
  const width = Math.max(mode.minWidth, Math.min(saved?.width ?? mode.width, area.width))
  const height = Math.max(mode.minHeight, Math.min(saved?.height ?? mode.height, area.height))
  const offsetX = compact ? area.width - width - 20 : Math.floor((area.width - width) / 2)
  const offsetY = compact ? 20 : Math.floor((area.height - height) / 2)
  const x = Math.max(area.x, Math.min(saved?.x ?? area.x + offsetX, area.x + area.width - width))
  const y = Math.max(area.y, Math.min(saved?.y ?? area.y + offsetY, area.y + area.height - height))
  return { x, y, width, height }
}

function outsideArea(bounds: Rectangle, area: Rectangle) {
  return bounds.x < area.x || bounds.y < area.y || bounds.x + bounds.width > area.x + area.width
    || bounds.y + bounds.height > area.y + area.height
}

function saveBounds() {
  if (!window || window.isDestroyed() || importInProgress) return
  try {
    store.setSetting(boundsKey(), window.getNormalBounds())
  } catch (error) {
    log(error)
  }
}

function createWindow() {
  const mode = sizes[compact ? 'compact' : 'regular']
  const main = new BrowserWindow({
    ...visibleBounds(), minWidth: mode.minWidth, minHeight: mode.minHeight, maximizable: !compact,
    backgroundColor: '#f8f2e9', show: false, title: PRODUCT_NAME, autoHideMenuBar: true,
    icon: iconPath,
    alwaysOnTop: store.getSetting('pinned') === true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ece8e3', symbolColor: '#25241e', height: 34 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  })
  window = main
  main.removeMenu()
  main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  main.webContents.on('will-navigate', event => event.preventDefault())
  main.webContents.session.setPermissionRequestHandler((_, _permission, callback) => callback(false))
  main.webContents.on('will-prevent-unload', event => {
    showWindow()
    const t = localized()
    const response = dialog.showMessageBoxSync(main, {
      type: 'warning', title: t('退出 {name}', { name: PRODUCT_NAME }), message: t('当前有尚未保存的修改。'),
      buttons: [t('继续编辑'), t('放弃并退出')], defaultId: 0, cancelId: 0
    })
    if (response === 1) event.preventDefault()
    else {
      quitting = false
      syncTray()
    }
  })
  main.once('ready-to-show', () => main.show())
  main.on('show', syncClock)
  main.on('focus', syncClock)
  main.on('restore', syncClock)
  const scheduleBounds = () => {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(saveBounds, 350)
  }
  main.on('move', scheduleBounds)
  main.on('resize', scheduleBounds)
  main.on('close', event => {
    if (backupDialogOpen) {
      event.preventDefault()
      quitting = false
      return
    }
    clearTimeout(boundsTimer)
    saveBounds()
    if ((compact || miniWindow) && !quitting) {
      event.preventDefault()
      main.hide()
    }
  })
  main.on('closed', () => { window = null })
  return devUrl ? main.loadURL(devUrl) : main.loadFile(rendererFile)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setAppUserModelId('local.tstimer.desktop')
  app.on('second-instance', showWindow)
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => { quitting = true })
  app.on('will-quit', event => {
    if (!store || closing) return
    event.preventDefault()
    closing = true
    tray?.destroy()
    tray = null
    clearInterval(backupInterval)
    void store.backupToday().catch(log).then(() => {
      store.close()
      app.quit()
    })
  })
  void app.whenReady().then(async () => {
    store = await Store.open(join(app.getPath('userData'), 'data', 'ts-timer.sqlite'))
    if (demo) store.replaceData(demoData())
    compact = store.getSetting('compact') === true
    registerHandlers()
    powerMonitor.on('resume', syncClock)
    function reposition() {
      if (window && !window.isMaximized()) {
        const bounds = window.getBounds()
        const area = screen.getDisplayMatching(bounds).workArea
        if (outsideArea(bounds, area)) {
          saveBounds()
          window.setBounds(visibleBounds())
        }
      }
      if (miniWindow) {
        const bounds = miniWindow.getBounds()
        const area = screen.getDisplayMatching(bounds).workArea
        if (outsideArea(bounds, area)) miniWindow.setBounds(miniBounds(area))
      }
    }
    screen.on('display-removed', reposition)
    screen.on('display-metrics-changed', reposition)
    const backup = () => { void store.backupToday().catch(log) }
    backupInterval = setInterval(backup, 15 * 60 * 1000)
    // Allow a first-use session to accumulate data before taking its first daily backup.
    if (store.getActive() || store.history(0).total) backup()
    await createWindow()
    syncTray()
  }).catch(error => {
    log(error)
    const t = localized()
    dialog.showErrorBox(t('无法启动 {name}', { name: PRODUCT_NAME }), t(error instanceof OperationError
      ? error.message : '无法打开本地数据库。请检查数据目录权限与磁盘空间。原数据库保留在应用数据目录。'))
    app.exit(1)
  })
}
