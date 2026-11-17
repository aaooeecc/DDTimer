import { contextBridge, ipcRenderer } from 'electron'
import type { MiniCountdown, Operations, Result, TimerApi } from '../shared/domain'

const method = <K extends keyof Operations>(channel: K) =>
  (payload: Operations[K][0]): Promise<Result<Operations[K][1]>> => ipcRenderer.invoke(channel, payload)

const api: TimerApi = {
  'plan:get': method('plan:get'),
  'plan:create': method('plan:create'),
  'plan:update': method('plan:update'),
  'plan:archive': method('plan:archive'),
  'plan:undoArchive': method('plan:undoArchive'),
  'task:create': method('task:create'),
  'task:update': method('task:update'),
  'task:status': method('task:status'),
  'task:delete': method('task:delete'),
  'task:restore': method('task:restore'),
  'group:create': method('group:create'),
  'group:update': method('group:update'),
  'group:delete': method('group:delete'),
  'settings:setTaskGrouping': method('settings:setTaskGrouping'),
  'settings:setLanguage': method('settings:setLanguage'),
  'rest:replace': method('rest:replace'),
  'history:list': method('history:list'),
  'history:get': method('history:get'),
  'backup:export': method('backup:export'),
  'backup:import': method('backup:import'),
  'window:getState': method('window:getState'),
  'window:setPin': method('window:setPin'),
  'window:setCompact': method('window:setCompact'),
  'window:setMini': method('window:setMini'),
  'mini:getCountdown': method('mini:getCountdown'),
  'app:demoClock': method('app:demoClock'),
  onClockSync(listener) {
    const callback = () => listener()
    ipcRenderer.on('app:clockSync', callback)
    return () => ipcRenderer.removeListener('app:clockSync', callback)
  },
  onMiniCountdown(listener) {
    const callback = (_event: Electron.IpcRendererEvent, countdown: MiniCountdown) => listener(countdown)
    ipcRenderer.on('mini:countdown', callback)
    return () => ipcRenderer.removeListener('mini:countdown', callback)
  },
  onMiniClosed(listener) {
    const callback = () => listener()
    ipcRenderer.on('window:miniClosed', callback)
    return () => ipcRenderer.removeListener('window:miniClosed', callback)
  }
}

contextBridge.exposeInMainWorld('tsTimer', api)
