import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'
import * as resedit from 'resedit'

const profile = await mkdtemp(join(tmpdir(), 'dd-timer-flow-'))
const output = resolve('test-results')
const installer = process.env.DD_TIMER_TEST_INSTALLER ?? process.env.TS_TIMER_TEST_INSTALLER
const installDir = join(profile, 'program')
const executablePath = installer ? join(installDir, 'DD Timer.exe') : (process.env.DD_TIMER_TEST_EXE ?? process.env.TS_TIMER_TEST_EXE)
const uninstallPath = join(installDir, 'Uninstall DD Timer.exe')
const runFile = promisify(execFile)
const reports = []
const databasePath = join(profile, 'data', 'ts-timer.sqlite')
const backupFile = join(profile, 'backup.json')
const badFile = join(profile, 'invalid.json')
await mkdir(output, { recursive: true })
let app
let page
let installedHere = false
const button = (label, parent = page) => parent.getByRole('button', { name: label, exact: true })
const settings = () => page.getByRole('dialog', { name: '设置', exact: true })
const visible = locator => locator.waitFor({ state: 'visible' })
const hidden = locator => locator.waitFor({ state: 'hidden' })
const api = (key, data) => page.evaluate(([method, payload]) => window.tsTimer[method](payload), [key, data])
const current = async () => {
  const result = await api('plan:get')
  assert.equal(result.ok, true)
  return result.data
}
const ref = snapshot => ({ planId: snapshot.plan.id, expectedRevision: snapshot.plan.revision })
const local = ms => {
  const dt = new Date(ms)
  return new Date(ms - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
const readDatabase = sql => {
  const db = new DatabaseSync(databasePath)
  try { return db.prepare(sql).get() } finally { db.close() }
}
const editDatabase = sql => {
  const db = new DatabaseSync(databasePath)
  try { db.exec(sql) } finally { db.close() }
}

async function open(args = [], override = executablePath) {
  const t = performance.now()
  app = await electron.launch({
    executablePath: override,
    args: [
      ...(override ? [] : ['.']),
      `--user-data-dir=${profile}`,
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      ...args
    ],
    timeout: 20_000
  })
  page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', error => console.error('Renderer error:', error))
  page.on('console', message => {
    if (message.type() === 'error') console.error('Renderer console:', message.text())
  })
  const path = await app.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(path, args.includes('--demo') ? `${profile}-demo` : profile, 'Keep desktop tests in their temporary profile')
  return t
}

async function stop() {
  const instance = app
  app = undefined
  await instance?.close()
}

async function record(name, work) {
  const t = performance.now()
  await work()
  const elapsed = Math.round(performance.now() - t)
  reports.push({ name, elapsedMs: elapsed })
  console.log(`PASS ${name} (${elapsed}ms)`)
}

async function install() {
  await runFile(resolve(installer), ['/S', `/D=${installDir}`], {
    timeout: 60_000, windowsHide: true, windowsVerbatimArguments: true
  })
  await access(executablePath)
  installedHere = true
}

async function uninstall() {
  await runFile(uninstallPath, ['/S'], { timeout: 60_000, windowsHide: true })
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await access(executablePath) } catch {
      installedHere = false
      return
    }
    await sleep(200)
  }
  throw new Error('卸载器退出后仍检测到应用程序文件。')
}

async function addTask(name, due) {
  await button('添加任务').click()
  const editor = page.getByRole('dialog', { name: '添加任务' })
  await editor.getByLabel('任务名称').fill(name)
  const time = editor.getByLabel('计划截止时间')
  if (due) {
    const [date, clock] = due.split('T')
    await editor.getByLabel('计划截止日期').fill(date)
    assert.equal(await time.inputValue(), '00:00')
    if (clock) await time.fill(clock)
    await visible(editor.getByText(/^距任务截止 /))
  } else {
    assert.equal(await time.isDisabled(), true)
  }
  await editor.getByLabel(/备注/).fill('验收备注\n第二行')
  await editor.getByLabel(/备注/).press('Control+Enter')
  await hidden(editor)
}

async function openMini() {
  const [mini] = await Promise.all([
    app.waitForEvent('window'),
    button('打开迷你悬浮窗').click()
  ])
  await visible(mini.getByRole('heading', { name: '距最终截止', exact: true }))
  await visible(button('关闭迷你悬浮窗'))
  return mini
}

async function setupDialogStubs(importPath = badFile) {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.backup })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.invalid] })
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  }, { backup: backupFile, invalid: importPath })
}

async function setTaskGrouping(enabled) {
  await button('设置').click()
  const toggle = settings().getByRole('switch', { name: '显示任务分组' })
  if (await toggle.isChecked() !== enabled) await toggle.click()
  await visible(toggle.and(page.locator(enabled ? ':checked' : ':not(:checked)')))
  await button('关闭', settings()).click()
  if (enabled) await visible(button('添加分组'))
  else await hidden(button('添加分组'))
}

try {
  let startedAtMs
  let firstBootMs
  let snapshotTimeMs
  if (installer) {
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/*','HKLM:/Software/Microsoft/Windows/CurrentVersion/Uninstall/*' -ErrorAction SilentlyContinue | Where-Object DisplayName -in @('DD Timer','TS Timer')).DisplayName"
    ], { windowsHide: true })
    assert.equal(stdout.trim(), '', '请在没有安装 DD Timer 或 TS Timer 的用户环境中运行安装验收。')
    await record('NSIS 安装到隔离目录', install)
  }
  if (executablePath) await record('Windows EXE 内嵌 DD Timer 图标', async () => {
    const [binary, icon] = await Promise.all([readFile(executablePath), readFile('build/icon.ico')])
    const { Data, NtExecutable, NtExecutableResource, Resource } = resedit
    const { entries } = NtExecutableResource.from(NtExecutable.from(binary, { ignoreCert: true }))
    const groups = Resource.IconGroupEntry.fromEntries(entries)
    const imageBytes = image => Buffer.from(image.isRaw() ? image.bin : image.generate())
    const expected = Data.IconFile.from(icon).icons.map(item => imageBytes(item.data))
    assert.ok(groups.length > 0)
    for (const group of groups) assert.deepEqual(group.getIconItemsFromEntries(entries).map(imageBytes), expected)
  })
  const start = await open()
  await record('首次启动空态、创建计划、SQLite 迁移和固定起点', async () => {
    await visible(page.getByRole('heading', { name: '创建计划' }))
    assert.equal(await app.evaluate(({ app }) => app.getName()), 'DD Timer')
    firstBootMs = Math.round(performance.now() - start)
    assert.equal(await current(), null)
    assert.equal(readDatabase('PRAGMA user_version').user_version, 2)
    await button('设置与归档历史').click()
    await settings().getByLabel('语言', { exact: true }).selectOption('en')
    const englishSettings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await visible(englishSettings.getByLabel('Language', { exact: true }))
    await button('Close', englishSettings).click()
    await visible(page.getByRole('heading', { name: 'Create a plan' }))
    await button('Settings and archive').click()
    await englishSettings.getByLabel('Language', { exact: true }).selectOption('zh-CN')
    await button('关闭', settings()).click()
    await page.getByLabel('计划名称').fill('安装版验收')
    await page.getByLabel('最终截止').fill(local(Date.now() + 4 * 86400000))
    await button('开始计划').click()
    await visible(page.getByRole('heading', { name: '安装版验收' }))
    startedAtMs = (await current()).plan.startedAtMs
    await visible(button('添加第一项任务'))
  })
  await record('中英文即时切换、迷你悬浮窗同步和重启记忆', async () => {
    const before = await current()
    const mini = await openMini()
    await button('设置').click()
    const breakName = settings().getByLabel('时段 1 名称', { exact: true })
    await breakName.fill('临时编辑')
    await settings().getByLabel('语言', { exact: true }).selectOption('en')
    const englishSettings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await visible(englishSettings)
    assert.equal(await englishSettings.getByLabel('Break 1 name', { exact: true }).inputValue(), '临时编辑')
    await visible(mini.getByRole('heading', { name: 'Time until deadline', exact: true }))
    await visible(mini.getByLabel(/days, .* seconds$/))
    assert.equal(await mini.locator('html').getAttribute('lang'), 'en')
    await button('Close', englishSettings).click()
    await visible(page.getByRole('heading', { name: 'Time until final deadline', exact: true }))
    await visible(page.getByRole('heading', { name: before.plan.title, exact: true }))
    assert.deepEqual(await current(), before)
    await button('Add task').click()
    const editor = page.getByRole('dialog', { name: 'Add task', exact: true })
    await visible(editor.getByLabel('Task name', { exact: true }))
    await button('Cancel', editor).click()
    await button('Close floating countdown').click()
    await stop()
    await open()
    await visible(button('Settings'))
    assert.equal(await page.locator('html').getAttribute('lang'), 'en')
    await button('Settings').click()
    await page.getByRole('dialog', { name: 'Settings', exact: true }).getByLabel('Language', { exact: true }).selectOption('zh-CN')
    await button('关闭', settings()).click()
    await visible(page.getByRole('heading', { name: '距离最终截止', exact: true }))
  })
  await record('任务日期默认零点、自动剩余时间、状态和筛选', async () => {
    const date = local(Date.now() + 2 * 86400000).slice(0, 10)
    const due = `${date}T18:37`
    for (let i = 1; i <= 8; i++) await addTask(`任务 ${i}`, i === 1 ? date : i === 8 ? null : due)
    let snapshot = await current()
    assert.equal(snapshot.tasks.length, 8)
    assert.equal(snapshot.tasks[0].notes, '验收备注\n第二行')
    assert.equal(local(snapshot.tasks.find(task => task.title === '任务 1').dueAtMs), `${date}T00:00`)
    assert.equal(local(snapshot.tasks.find(task => task.title === '任务 2').dueAtMs), due)
    await visible(page.getByText('未设截止', { exact: true }))
    await button('任务 2').click()
    const editor = page.getByRole('dialog', { name: '编辑任务' })
    assert.equal(await editor.getByLabel('计划截止时间').inputValue(), '18:37')
    await button('取消', editor).click()
    await page.getByRole('button', { name: /任务 1 待办/ }).click()
    await visible(page.getByRole('button', { name: /任务 1 进行中/ }))
    await page.getByRole('checkbox', { name: '完成 任务 1', exact: true }).click()
    await visible(button('完成 1'))
    await button('完成 1').click()
    assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '12.5')
    await page.getByRole('checkbox', { name: '完成 任务 1', exact: true }).click()
    await visible(button('完成 0'))
    await button('全部 8').click()
    snapshot = await current()
    const task = snapshot.tasks.find(task => task.title === '任务 1')
    assert.equal(task.status, 'todo')
    assert.equal(task.completedAtMs, null)
    assert.equal(task.remainingEstimateMinutes, null)

    const row = page.getByRole('listitem').filter({ has: button('任务 1') })
    const clock = new Date(task.dueAtMs - 150_000)
    await page.clock.install({ time: clock })
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
    await visible(row.getByText(/剩余 2分钟/))
    await page.clock.fastForward(65_000)
    await visible(row.getByText(/剩余 1分钟/))
    await page.clock.setSystemTime(new Date(task.dueAtMs - 30_000))
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
    await visible(row.getByText(/小于 1 分钟/))
    await page.clock.setSystemTime(new Date(task.dueAtMs))
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
    await visible(row.getByText('已逾期', { exact: true }))
    await page.clock.setSystemTime(new Date())
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))

    await button('任务 1 更多操作').click()
    await button('删除任务').click()
    await visible(button('全部 7'))
    await button('撤销').click()
    await visible(button('全部 8'))
    const stale = await api('task:status', { ...ref(snapshot), taskId: task.id, status: 'done' })
    assert.equal(stale.error.code, 'REVISION_CONFLICT')
  })
  await record('写入失败保留任务草稿，可重试成功', async () => {
    editDatabase("UPDATE tasks SET remaining_estimate_minutes = 60 WHERE title = '任务 1'")
    editDatabase(`CREATE TRIGGER test_reject_update BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'test'); END`)
    await button('任务 1').click()
    const editor = page.getByRole('dialog', { name: '编辑任务' })
    await editor.getByLabel('任务名称').fill('任务 1 已编辑')
    await button('保存任务', editor).click()
    await visible(editor.getByRole('alert'))
    assert.equal(await editor.getByLabel('任务名称').inputValue(), '任务 1 已编辑')
    editDatabase('DROP TRIGGER test_reject_update')
    await button('重试', editor).click()
    await visible(button('任务 1 已编辑'))
    assert.equal((await current()).tasks.find(task => task.title === '任务 1 已编辑').remainingEstimateMinutes, 60)
  })
  await record('修改截止、休息规则、置顶，计时刷新不写入计划', async () => {
    await button('修改最终截止').click()
    const adjust = page.getByRole('dialog', { name: '修改最终截止' })
    await adjust.getByLabel('最终截止').fill(local(Date.now() + 86400000))
    await button('保存', adjust).click()
    await visible(page.getByText('晚于目标', { exact: true }).first())
    await button('设置').click()
    await settings().getByRole('switch', { name: '启用 午间休息' }).uncheck()
    await button('添加时段', settings()).click()
    await settings().getByLabel('休息 开始', { exact: true }).fill('13:05')
    await settings().getByLabel('休息 结束', { exact: true }).fill('13:15')
    await button('保存设置', settings()).click()
    await hidden(settings())
    assert.equal((await current()).restRules.length, 3)
    await button('窗口置顶').click()
    await visible(button('取消窗口置顶'))
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), true)
    await button('取消窗口置顶').click()
    const before = await current()
    await page.waitForTimeout(1400)
    assert.deepEqual((await current()).plan, before.plan)
  })
  await record('关闭重启并从恢复事件重新取样', async () => {
    await stop()
    assert.ok((await readdir(join(profile, 'data', 'backups'))).some(name => name.startsWith('daily-')))
    await open()
    await visible(page.getByRole('heading', { name: '安装版验收' }))
    assert.equal((await current()).plan.startedAtMs, startedAtMs)
    assert.equal((await current()).tasks.length, 8)
    const timer = page.getByLabel(/^[0-9]+天 [0-9]+时/)
    await visible(timer)
    const before = await timer.getAttribute('aria-label')
    await page.clock.install({ time: new Date(Date.now() + 10 * 60_000) })
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
    const after = await timer.getAttribute('aria-label')
    assert.notEqual(after, before)
    await page.clock.setSystemTime(new Date())
  })
  await record('导出、拒绝坏备份、归档、撤销及导入恢复', async () => {
    await writeFile(badFile, '{"schemaVersion":999}', 'utf8')
    await setupDialogStubs()
    await button('设置').click()
    await button('导出备份', settings()).click()
    await visible(page.getByText('已导出 1 个计划、8 条任务'))
    const exported = JSON.parse(await readFile(backupFile, 'utf8'))
    assert.equal(exported.schemaVersion, 2)
    assert.deepEqual(exported.groups, [])
    await button('设置').click()
    await button('导入备份', settings()).click()
    await visible(settings().getByRole('alert'))
    assert.equal((await current()).tasks.length, 8)
    await button('关闭', settings()).click()

    async function archive() {
      await button('设置').click()
      await button('归档当前计划', settings()).click()
      await button('确认归档', page.getByRole('dialog', { name: '归档当前计划' })).click()
      await visible(page.getByRole('heading', { name: '创建计划' }))
    }
    const mini = await openMini()
    const miniClosed = mini.waitForEvent('close')
    await archive()
    await miniClosed
    await button('撤销').click()
    await visible(page.getByRole('heading', { name: '安装版验收' }))
    await archive()
    await button('设置与归档历史').click()
    await button('归档历史', settings()).click()
    await page.getByRole('dialog', { name: '归档历史' }).getByRole('button', { name: /^安装版验收/ }).click()
    await visible(page.getByText(/已归档.*只读/))
    assert.equal(await button('添加任务').count(), 0)
    await button('归档历史').click()
    await button('关闭', page.getByRole('dialog', { name: '归档历史' })).click()

    const { groups: _groups, ...legacy } = exported
    legacy.schemaVersion = 1
    legacy.tasks = legacy.tasks.map(({ groupId: _id, ...task }) => task)
    delete legacy.settings.showTaskGroups
    await writeFile(backupFile, JSON.stringify(legacy), 'utf8')
    await setupDialogStubs(backupFile)
    await button('设置与归档历史').click()
    await button('导入备份', settings()).click()
    await visible(page.getByRole('heading', { name: '安装版验收' }))
    assert.equal((await current()).plan.startedAtMs, startedAtMs)
    assert.ok((await current()).tasks.every(task => task.groupId === null))
  })
  await record('任务分组显示切换、所属分组、折叠和备份恢复', async () => {
    const flatBackup = await readFile(backupFile, 'utf8')
    const section = name => page.getByRole('region', { name, exact: true })
    await hidden(button('添加分组'))
    await setTaskGrouping(true)
    await visible(section('未分组'))

    await button('添加分组').click()
    const createGroup = page.getByRole('dialog', { name: '添加分组' })
    await createGroup.getByLabel('分组名称').fill('开发')
    await button('保存分组', createGroup).click()
    await visible(section('开发').getByText('0 项', { exact: true }))
    const group = (await current()).groups[0]

    await button('向开发添加任务', section('开发')).click()
    const createTask = page.getByRole('dialog', { name: '添加任务' })
    await createTask.getByLabel('任务名称').fill('开发组任务')
    assert.equal(await createTask.getByRole('combobox').inputValue(), group.id)
    await button('保存任务', createTask).click()
    await visible(button('开发组任务', section('开发')))

    await button('任务 2', section('未分组')).click()
    const editTask = page.getByRole('dialog', { name: '编辑任务' })
    await editTask.getByRole('combobox').selectOption({ label: '开发' })
    await button('保存任务', editTask).click()
    await visible(button('任务 2', section('开发')))
    await section('开发').getByRole('checkbox', { name: '完成 任务 2', exact: true }).click()
    await visible(section('开发').getByText('1/2', { exact: true }))
    await button('完成 1').click()
    await hidden(section('未分组'))
    await visible(button('任务 2', section('开发')))
    await hidden(button('开发组任务', section('开发')))
    await button('全部 9').click()
    await button('开发', section('开发')).click()
    await hidden(button('开发组任务', section('开发')))
    await button('开发', section('开发')).click()
    await visible(button('开发组任务', section('开发')))

    await setTaskGrouping(false)
    await hidden(section('开发'))
    await visible(button('开发组任务'))
    await stop()
    await open()
    await visible(button('全部 9'))
    await hidden(button('添加分组'))
    await setTaskGrouping(true)
    await visible(button('开发组任务', section('开发')))

    await button('开发 分组操作', section('开发')).click()
    await button('重命名分组', section('开发')).click()
    const rename = page.getByRole('dialog', { name: '重命名分组' })
    await rename.getByLabel('分组名称').fill('开发交付')
    await button('保存分组', rename).click()
    await visible(button('开发组任务', section('开发交付')))

    await setupDialogStubs(backupFile)
    await button('设置').click()
    await button('导出备份', settings()).click()
    await visible(page.getByText('已导出 1 个计划、9 条任务'))
    const groupedBackup = JSON.parse(await readFile(backupFile, 'utf8'))
    assert.deepEqual(groupedBackup.groups.map(item => item.title), ['开发交付'])
    assert.equal(groupedBackup.settings.showTaskGroups, true)
    await button('开发交付 分组操作', section('开发交付')).click()
    await button('删除分组', section('开发交付')).click()
    await button('删除分组', page.getByRole('dialog', { name: '删除分组' })).click()
    await visible(button('开发组任务', section('未分组')))
    assert.equal((await current()).tasks.find(task => task.title === '开发组任务').groupId, null)

    await button('设置').click()
    await button('导入备份', settings()).click()
    await visible(button('开发组任务', section('开发交付')))
    assert.equal((await current()).tasks.find(task => task.title === '开发组任务').groupId, group.id)
    await writeFile(backupFile, flatBackup, 'utf8')
  })
  await record('500 项任务、最小主窗口和缩放', async () => {
    const data = JSON.parse(await readFile(backupFile, 'utf8'))
    const template = data.tasks[0]
    for (let i = data.tasks.length; i < 500; i++) {
      data.tasks.push({ ...template, title: `压力测试任务 ${i + 1}`, id: crypto.randomUUID() })
    }
    await writeFile(backupFile, JSON.stringify(data), 'utf8')
    await button('设置').click()
    await button('导入备份', settings()).click()
    await visible(button('全部 500'))
    const startQuery = performance.now()
    assert.equal((await current()).tasks.length, 500)
    snapshotTimeMs = Math.round(performance.now() - startQuery)
    await button('待办 500').click()
    const first = page.getByRole('checkbox', { name: /^完成 / }).first()
    await first.click()
    await visible(button('完成 1'))
    for (const scale of [1, 1.25, 1.5]) {
      await app.evaluate(({ BrowserWindow }, factor) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setSize(Math.round(780 * factor), Math.round(520 * factor))
        window.webContents.setZoomFactor(factor)
      }, scale)
      await page.waitForTimeout(120)
      assert.equal(await page.evaluate(() =>
        [...document.querySelectorAll('[aria-label="时间概览"] h2')].every(heading => {
          const panel = heading.parentElement
          return panel.scrollWidth <= panel.clientWidth
        })
      ), true)
      await button('设置').click()
      await visible(button('保存设置', settings()))
      await button('关闭', settings()).click()
    }
  })
  const processStats = await app.evaluate(({ app }) => app.getAppMetrics().map(({ type, memory }) => ({
    type, workingSetMiB: Math.round(memory.workingSetSize / 1024)
  })))

  await record('桌面小窗置顶、隐藏、恢复及重启记忆', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.webContents.setZoomFactor(1)
      window.setSize(1080, 704)
    })
    await button('桌面小窗').click()
    await visible(button('恢复主窗口'))
    assert.equal(await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return window.getBounds().width === 420 && window.isAlwaysOnTop() && !window.isMaximizable()
    }), true)
    await visible(page.getByRole('region', { name: '时间概览' }))
    await visible(button('全部 500'))
    await button('设置').click()
    await visible(settings().getByRole('switch', { name: '桌面小窗' }))
    await button('关闭', settings()).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
    await app.evaluate(({ app }) => app.emit('second-instance'))
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true)
    const position = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
    await stop()
    await open()
    await visible(button('恢复主窗口'))
    await visible(button('取消窗口置顶'))
    assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()), position)
    await button('恢复主窗口').click()
    await visible(button('桌面小窗'))
    assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().width >= 780))
    await button('取消窗口置顶').click()
    await visible(button('窗口置顶'))
  })

  await record('迷你悬浮窗右上角置顶、实时更新和独立关闭', async () => {
    const mini = await openMini()
    const countdown = mini.locator('[aria-label$="秒"]')
    await visible(countdown)
    const start = await countdown.getAttribute('aria-label')
    await mini.waitForFunction(previous =>
      document.querySelector('[aria-label$="秒"]')?.getAttribute('aria-label') !== previous, start)
    assert.equal(await mini.getByText('今日可用', { exact: true }).count(), 0)
    assert.equal(await mini.getByRole('button').count(), 0)
    assert.equal(await app.evaluate(({ BrowserWindow, screen }) => {
      const main = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('view=mini'))
      const mini = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=mini'))
      const area = screen.getDisplayMatching(main.getBounds()).workArea
      const bounds = mini.getBounds()
      return mini.isAlwaysOnTop() && !mini.isResizable() && bounds.width === 264 &&
        bounds.x + bounds.width === area.x + area.width - 14 && bounds.y === area.y + 14
    }), true)

    await button('修改最终截止').click()
    const adjust = page.getByRole('dialog', { name: '修改最终截止' })
    await adjust.getByLabel('最终截止').fill(local(Date.now() + 5 * 86400000 + 10 * 60000))
    await button('保存', adjust).click()
    await hidden(adjust)
    await visible(mini.getByLabel(/^05天 /))
    const deadline = (await current()).plan.deadlineAtMs
    await mini.clock.install({ time: new Date(deadline + 1000) })
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
    await visible(mini.getByLabel('00天 00时 00分 00秒', { exact: true }))

    assert.equal(await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('view=mini'))
      main.close()
      const mini = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=mini'))
      return !main.isVisible() && mini.isVisible()
    }), true)
    await app.evaluate(({ Menu }) => {
      const popup = Menu.prototype.popup
      Menu.prototype.popup = function () {
        Menu.prototype.popup = popup
        const close = this.items.find(item => item.label === '关闭迷你悬浮窗')
        if (close) setImmediate(() => close.click())
      }
    })
    const closed = mini.waitForEvent('close')
    await countdown.click({ button: 'right' }).catch(error => { if (!mini.isClosed()) throw error })
    await closed
    await visible(button('打开迷你悬浮窗'))
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true)
  })
  await stop()

  if (installer) await record('NSIS 同版本覆盖安装、卸载与重装保留测试数据', async () => {
    await install()
    await open()
    await visible(button('全部 500'))
    await stop()
    await uninstall()
    assert.equal(readDatabase('SELECT COUNT(*) AS total FROM tasks').total, 500)
    await install()
    await open()
    await visible(button('全部 500'))
    assert.equal((await current()).plan.startedAtMs, startedAtMs)
    await stop()
    await uninstall()
  })

  if (!executablePath) await record('截图固定验收样例', async () => {
    await open(['--demo'])
    await visible(page.getByRole('heading', { name: '本周产品上线' }))
    await visible(page.getByRole('region', { name: '开发与联调', exact: true }))
    await visible(page.getByText('11月17日 18:00 · 剩余 26小时30分', { exact: true }))
    const verifyTimeLayout = async () => {
      const overview = page.getByRole('region', { name: '时间概览' })
      assert.deepEqual(await overview.locator('dt').allTextContents(), ['可用 · 已扣休息', '今日可用', '已过去'])
      assert.deepEqual(await overview.locator('dd').allTextContents(), ['48小时30分', '6小时30分', '5小时'])
      const positions = await overview.locator('dd').evaluateAll(values =>
        values.map(value => ({ x: value.getBoundingClientRect().x, y: value.getBoundingClientRect().y }))
      )
      assert.ok(positions[0].x < positions[1].x && positions[1].x < positions[2].x)
      assert.ok(positions.every(value => value.y === positions[0].y))
      await visible(page.getByLabel('04天 02时 30分 00秒', { exact: true }))
    }
    await verifyTimeLayout()
    assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '37.5')
    await page.screenshot({ path: join(output, 'dd-timer-dashboard.png'), animations: 'disabled' })
    await button('设置').click()
    await visible(settings())
    await page.screenshot({ path: join(output, 'dd-timer-settings.png'), animations: 'disabled' })
    await button('关闭', settings()).click()
    await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window.isMaximized()) await new Promise(resolve => {
        window.once('maximize', resolve)
        window.maximize()
      })
    })
    await verifyTimeLayout()
    await page.screenshot({ path: join(output, 'dd-timer-maximized.png'), animations: 'disabled' })
    await button('桌面小窗').click()
    await visible(button('恢复主窗口'))
    await verifyTimeLayout()
    await page.screenshot({ path: join(output, 'dd-timer-compact.png'), animations: 'disabled' })
    await button('恢复主窗口').click()
    await visible(button('桌面小窗'))
    const mini = await openMini()
    await visible(mini.getByLabel('04天 02时 30分 00秒', { exact: true }))
    await mini.screenshot({ path: join(output, 'dd-timer-mini.png'), omitBackground: true, animations: 'disabled' })
    await button('关闭迷你悬浮窗').click()
    await visible(button('打开迷你悬浮窗'))
    await button('待办 5').click()
    for (let count = 5; count > 0; count--) {
      await page.getByRole('checkbox', { name: /^完成 / }).first().click()
      await visible(button(`待办 ${count - 1}`))
    }
    await visible(page.getByText('任务已完成 · 100%', { exact: true }))
    assert.equal(await page.getByLabel('04天 02时 30分 00秒').count(), 1)
  })

  const result = { executablePath: executablePath ?? 'local build', firstBootMs, snapshotTimeMs, processStats, reports }
  console.log(JSON.stringify(result, null, 2))
  await writeFile(join(output, executablePath ? 'desktop-windows.json' : 'desktop-local.json'), JSON.stringify(result, null, 2))
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(output, 'desktop-failure.png') }).catch(() => {})
  }
  if (app) {
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
    }).catch(() => {})
  }
  throw error
} finally {
  await stop()
  if (installedHere) await uninstall().catch(error => console.error('测试安装清理失败:', error))
  await rm(profile, { recursive: true, force: true, maxRetries: 5 })
  await rm(`${profile}-demo`, { recursive: true, force: true, maxRetries: 5 })
}
