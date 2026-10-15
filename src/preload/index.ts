import { contextBridge, ipcRenderer } from 'electron'
import type { AutomationHookEvent, BrowserState, ChatEventPayload, OpenCodeNotice } from '../shared/types'
import type { OsvaCodeApi } from '../shared/api'

const api: OsvaCodeApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getMcpStatus: () => ipcRenderer.invoke('mcp:status'),
  listModels: (providerId) => ipcRenderer.invoke('models:list', providerId),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickAttachment: (kind) => ipcRenderer.invoke('dialog:pickAttachment', kind),
  sendChat: (requestId, history, options) =>
    ipcRenderer.invoke('chat:send', requestId, history, options),
  simplify: (requestId, text) => ipcRenderer.invoke('chat:simplify', requestId, text),
  respondPermission: (permissionId, decision) =>
    ipcRenderer.invoke('chat:permission-response', permissionId, decision),
  abort: (requestId) => ipcRenderer.invoke('chat:abort', requestId),
  syncList: () => ipcRenderer.invoke('sync:list'),
  syncPull: (id) => ipcRenderer.invoke('sync:pull', id),
  syncPush: (payload) => ipcRenderer.invoke('sync:push', payload),
  syncDelete: (owuiId) => ipcRenderer.invoke('sync:delete', owuiId),
  projectRead: (folder) => ipcRenderer.invoke('project:read', folder),
  projectSaveInstructions: (folder, content) =>
    ipcRenderer.invoke('project:save-instructions', folder, content),
  projectSaveNotes: (folder, content) => ipcRenderer.invoke('project:save-notes', folder, content),
  projectCatalog: (folder) => ipcRenderer.invoke('project:catalog', folder),
  projectInstallCatalogSkill: (folder, id) =>
    ipcRenderer.invoke('project:install-catalog-skill', folder, id),
  projectSaveSkill: (folder, name, content) =>
    ipcRenderer.invoke('project:save-skill', folder, name, content),
  projectDeleteSkill: (folder, name) => ipcRenderer.invoke('project:delete-skill', folder, name),
  projectSaveAction: (folder, name, content) =>
    ipcRenderer.invoke('project:save-action', folder, name, content),
  projectDeleteAction: (folder, name) => ipcRenderer.invoke('project:delete-action', folder, name),
  projectCommands: (folder) => ipcRenderer.invoke('project:commands', folder),
  getSession: () => ipcRenderer.invoke('auth:session'),
  login: (email, password, serverUrl) =>
    ipcRenderer.invoke('auth:login', email, password, serverUrl),
  signup: (name, email, password, serverUrl) =>
    ipcRenderer.invoke('auth:signup', name, email, password, serverUrl),
  loginAnonymous: () => ipcRenderer.invoke('auth:anonymous'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  onChatEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ChatEventPayload): void =>
      callback(payload)
    ipcRenderer.on('chat:event', listener)
    return () => ipcRenderer.removeListener('chat:event', listener)
  },
  hookPort: () => ipcRenderer.invoke('hooks:port'),
  onAutomationHook: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AutomationHookEvent): void =>
      callback(payload)
    ipcRenderer.on('automation:hook', listener)
    return () => ipcRenderer.removeListener('automation:hook', listener)
  },
  tunnelStatus: () => ipcRenderer.invoke('hooks:tunnel-status'),
  tunnelStart: () => ipcRenderer.invoke('hooks:tunnel-start'),
  tunnelStop: () => ipcRenderer.invoke('hooks:tunnel-stop'),
  onTunnel: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, url: string | null): void => callback(url)
    ipcRenderer.on('automation:tunnel', listener)
    return () => ipcRenderer.removeListener('automation:tunnel', listener)
  },
  revertWorkspace: (folder, path, previous) => ipcRenderer.invoke('workspace:revert', folder, path, previous),
  revertHunk: (folder, path, previous, hunk) =>
    ipcRenderer.invoke('workspace:revert-hunk', folder, path, previous, hunk),
  navigateBrowser: (url) => ipcRenderer.invoke('browser:navigate', url),
  openBrowserFile: (relativePath) => ipcRenderer.invoke('browser:open-file', relativePath),
  browserCommand: (command) => ipcRenderer.invoke('browser:command', command),
  setBrowserBounds: (bounds) => ipcRenderer.invoke('browser:bounds', bounds),
  getBrowserState: () => ipcRenderer.invoke('browser:state'),
  openBrowserExternal: () => ipcRenderer.invoke('browser:external'),
  onBrowserState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: BrowserState): void => callback(state)
    ipcRenderer.on('browser:state', listener)
    return () => ipcRenderer.removeListener('browser:state', listener)
  },
  opencodeStatus: () => ipcRenderer.invoke('opencode:status'),
  opencodeEnsure: (input) => ipcRenderer.invoke('opencode:ensure', input),
  opencodeModels: () => ipcRenderer.invoke('opencode:models'),
  opencodeUseModel: (sessionID, model) => ipcRenderer.invoke('opencode:model', sessionID, model),
  opencodePrompt: (sessionID, text) => ipcRenderer.invoke('opencode:prompt', sessionID, text),
  opencodeInterrupt: (sessionID) => ipcRenderer.invoke('opencode:interrupt', sessionID),
  opencodePermission: (sessionID, requestID, decision) =>
    ipcRenderer.invoke('opencode:permission', sessionID, requestID, decision),
  opencodeDiff: (sessionID) => ipcRenderer.invoke('opencode:diff', sessionID),
  onOpenCode: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, notice: OpenCodeNotice): void => callback(notice)
    ipcRenderer.on('opencode:event', listener)
    return () => ipcRenderer.removeListener('opencode:event', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
