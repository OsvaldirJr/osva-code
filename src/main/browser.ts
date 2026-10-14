import { WebContentsView, shell, type BrowserWindow, type Rectangle } from 'electron'
import { isAbsolute, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { BrowserState } from '../shared/types'

let host: BrowserWindow | null = null
let view: WebContentsView | null = null
let getFolder: () => string | null = () => null

export function attachEmbeddedBrowser(window: BrowserWindow, folder: () => string | null): void {
  host = window
  getFolder = folder
  view = new WebContentsView({
    webPreferences: {
      partition: 'persist:osvacode-browser',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  view.setBackgroundColor('#090b10')
  window.contentView.addChildView(view)
  view.setVisible(false)
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 })

  const contents = view.webContents
  contents.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) void contents.loadURL(url).catch(() => {})
    else void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!isAllowed(url)) event.preventDefault()
  })

  const push = (): void => pushState()
  contents.on('did-start-loading', push)
  contents.on('did-stop-loading', push)
  contents.on('did-navigate', push)
  contents.on('did-navigate-in-page', push)
  contents.on('did-fail-load', push)
  contents.on('page-title-updated', push)

  window.on('closed', () => {
    detachEmbeddedBrowser()
  })
}

export function detachEmbeddedBrowser(): void {
  if (host && view) {
    try {
      host.contentView.removeChildView(view)
    } catch {
      // a janela já pode ter sido destruída
    }
  }
  const contents = view?.webContents
  if (contents && !contents.isDestroyed()) contents.close()
  view = null
  host = null
}

export function browserState(): BrowserState {
  const contents = view?.webContents
  if (!contents || contents.isDestroyed()) {
    return { url: '', title: '', canGoBack: false, canGoForward: false, loading: false }
  }
  const current = contents.getURL()
  return {
    url: current === 'about:blank' ? '' : current,
    title: contents.getTitle(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    loading: contents.isLoading()
  }
}

export function setBrowserBounds(bounds: Rectangle | null): void {
  if (!view) return
  if (!bounds || bounds.width < 8 || bounds.height < 8) {
    view.setVisible(false)
    return
  }
  view.setVisible(true)
  view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  })
}

export async function browserNavigate(input: string): Promise<BrowserState> {
  const url = normalizeHttp(input)
  if (!url || !view) return browserState()
  await view.webContents.loadURL(url).catch(() => {})
  pushState()
  return browserState()
}

export async function browserOpenFile(relativePath: string): Promise<BrowserState> {
  const folder = getFolder()
  const abs = folder ? insideFolder(folder, relativePath) : null
  if (!abs || !view) return browserState()
  await view.webContents.loadFile(abs).catch(() => {})
  pushState()
  return browserState()
}

export function browserCommand(command: 'back' | 'forward' | 'reload' | 'stop'): BrowserState {
  const contents = view?.webContents
  if (!contents || contents.isDestroyed()) return browserState()
  const history = contents.navigationHistory
  if (command === 'back' && history.canGoBack()) history.goBack()
  else if (command === 'forward' && history.canGoForward()) history.goForward()
  else if (command === 'reload') contents.reload()
  else if (command === 'stop') contents.stop()
  return browserState()
}

export function browserOpenExternal(): void {
  const url = browserState().url
  if (isHttp(url)) void shell.openExternal(url)
}

function pushState(): void {
  if (!host || host.isDestroyed()) return
  host.webContents.send('browser:state', browserState())
}

function normalizeHttp(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

function isHttp(url: string): boolean {
  return /^https?:/i.test(url)
}

function insideFolder(folder: string, input: string): string | null {
  const abs = resolve(folder, input)
  const rel = relative(folder, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

function isAllowed(url: string): boolean {
  if (url === 'about:blank' || isHttp(url)) return true
  if (!url.startsWith('file://')) return false
  const folder = getFolder()
  if (!folder) return false
  try {
    return insideFolder(folder, fileURLToPath(url)) !== null
  } catch {
    return false
  }
}
