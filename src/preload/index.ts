import { contextBridge, ipcRenderer } from 'electron'
import type { ChatEventPayload } from '../shared/types'
import type { OsvaCodeApi } from '../shared/api'

const api: OsvaCodeApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getMcpStatus: () => ipcRenderer.invoke('mcp:status'),
  listModels: (providerId) => ipcRenderer.invoke('models:list', providerId),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
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
  getSession: () => ipcRenderer.invoke('auth:session'),
  login: (email, password) => ipcRenderer.invoke('auth:login', email, password),
  signup: (name, email, password) => ipcRenderer.invoke('auth:signup', name, email, password),
  logout: () => ipcRenderer.invoke('auth:logout'),
  onChatEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ChatEventPayload): void =>
      callback(payload)
    ipcRenderer.on('chat:event', listener)
    return () => ipcRenderer.removeListener('chat:event', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
