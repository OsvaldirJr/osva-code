import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, shell, Tray } from 'electron'
import {
  attachEmbeddedBrowser,
  browserCommand,
  browserNavigate,
  browserOpenExternal,
  browserOpenFile,
  browserState,
  setBrowserBounds
} from './browser'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { DEFAULT_OPENWEBUI_URL, loadSettings, saveSettings } from './config'
import { McpManager } from './mcp'
import { runTeam } from './agents'
import { listModels, runChat, runSimplify, type PermissionRequest } from './chat'
import { owuiDeleteChat, owuiListChats, owuiPullChat, owuiPushChat, type OwuiAuth } from './sync'
import { clearSessionFile, loadSessionFile, owuiSignin, owuiSignup, saveSessionFile } from './auth'
import {
  autoInstallSkills,
  catalogStatus,
  deleteProjectAction,
  deleteProjectSkill,
  ensureProjectDir,
  installCatalogSkill,
  loadProjectContext,
  projectPromptBlock,
  readProjectFiles,
  saveProjectAction,
  saveProjectInstructions,
  saveProjectNotes,
  saveProjectSkill
} from './project'
import { expandSlashCommands, listSlashCommands } from './slashCommands'
import { readFileAttachment, readFolderAttachment, readImageAttachment } from './attach'
import { startAutomationHooks } from './automationHooks'
import { startTunnel, stopTunnel, tunnelUrl } from './tunnel'
import {
  ensureOpenCodeSession,
  interruptOpenCode,
  openCodeDiff,
  listOpenCodeModels,
  openCodeStatus,
  promptOpenCode,
  switchOpenCodeModel,
  replyOpenCodePermission,
  startOpenCodeStream
} from './opencode'
import { rejectWorkspaceHunk, restoreWorkspaceFile, type HunkEdit } from './workspaceActions'
import { AUTOMATION_HOOK_PORT } from '../shared/types'
import { designInstructions } from '../shared/design'
import type { AutomationHookEvent, OpenCodeModel, OpenCodeNotice } from '../shared/types'
import type {
  AppSettings,
  AuthSession,
  ChatEventPayload,
  ChatMessage,
  BrowserBounds,
  ChatSendOptions,
  PermissionDecision,
  StreamEvent,
  SyncPushPayload
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
let settings: AppSettings = {
  providers: [],
  activeProviderId: null,
  mcpServers: [],
  systemPrompt: '',
  userName: '',
  toolPermissions: {},
  openWebUi: { url: '', apiKey: '', enabled: false },
  teams: [],
  automations: [],
  opencode: { url: 'http://127.0.0.1:4096', username: 'opencode', password: '' }
}
const mcp = new McpManager()
const activeRequests = new Map<string, AbortController>()
const pendingPermissions = new Map<string, (decision: PermissionDecision) => void>()
let session: AuthSession | null = null
let hookPort = AUTOMATION_HOOK_PORT
let tray: Tray | null = null
let quitting = false

/** Normaliza a URL do servidor de login (aceita sem protocolo, remove barra final). */
function resolveServerUrl(raw?: string): string {
  let url = (raw ?? '').trim() || settings.openWebUi.url || DEFAULT_OPENWEBUI_URL
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  return url.replace(/\/+$/, '')
}

/** Após autenticar com sucesso, o servidor usado vira o padrão do app. */
function rememberServerUrl(url: string): void {
  if (settings.openWebUi.url !== url) {
    settings = { ...settings, openWebUi: { ...settings.openWebUi, url } }
    saveSettings(settings)
  }
}

/** Credenciais de sync: token da sessão logada, ou a chave de API como reserva. */
function syncAuth(): OwuiAuth | null {
  if (session?.token) {
    return { url: session.serverUrl || settings.openWebUi.url, token: session.token }
  }
  if (settings.openWebUi.apiKey) {
    return { url: settings.openWebUi.url, token: settings.openWebUi.apiKey }
  }
  return null
}

/**
 * Decide se uma ferramenta pode rodar: permissões salvas liberam direto;
 * caso contrário pergunta na tela e aguarda a escolha do usuário.
 */
async function resolvePermission(
  requestId: string,
  request: PermissionRequest,
  signal: AbortSignal
): Promise<'allow' | 'deny'> {
  if (settings.toolPermissions[request.fullName] === 'always') return 'allow'

  const permissionId = randomUUID()
  emitTo(requestId, {
    type: 'tool-permission',
    callId: request.callId,
    permissionId,
    toolName: request.toolName,
    serverName: request.serverName,
    explanation: request.explanation
  })

  const decision = await new Promise<PermissionDecision>((resolve) => {
    const onAbort = (): void => resolve('deny')
    // remove o listener ao responder para não acumular um por ferramenta no mesmo signal
    pendingPermissions.set(permissionId, (d) => {
      signal.removeEventListener('abort', onAbort)
      resolve(d)
    })
    signal.addEventListener('abort', onAbort, { once: true })
  })
  pendingPermissions.delete(permissionId)

  if (decision === 'allow-always') {
    settings.toolPermissions = { ...settings.toolPermissions, [request.fullName]: 'always' }
    saveSettings(settings)
    return 'allow'
  }
  return decision === 'allow' ? 'allow' : 'deny'
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 560,
    title: 'OsvaCode',
    backgroundColor: '#090b10',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    mainWindow?.hide()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  attachEmbeddedBrowser(mainWindow, () => mcp.workspaceFolder())

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function publishOpenCode(notice: OpenCodeNotice): void {
  mainWindow?.webContents.send('opencode:event', notice)
}

function emitTo(requestId: string, event: StreamEvent): void {
  const payload: ChatEventPayload = { requestId, event }
  mainWindow?.webContents.send('chat:event', payload)
}

function activeProvider() {
  return settings.providers.find((p) => p.id === settings.activeProviderId) ?? settings.providers[0]
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings)

  ipcMain.handle('settings:save', async (_event, next: AppSettings) => {
    settings = next
    saveSettings(settings)
    startOpenCodeStream(settings.opencode, publishOpenCode)
    await mcp.sync(settings.mcpServers)
    return mcp.status(settings.mcpServers)
  })

  ipcMain.handle('mcp:status', () => mcp.status(settings.mcpServers))
  ipcMain.handle('hooks:port', () => hookPort)

  ipcMain.handle('opencode:status', () => openCodeStatus(settings.opencode))
  ipcMain.handle('opencode:models', () => listOpenCodeModels(settings.opencode))
  ipcMain.handle('opencode:model', (_event, sessionID: string, model: OpenCodeModel) =>
    switchOpenCodeModel(settings.opencode, sessionID, model)
  )
  ipcMain.handle(
    'opencode:ensure',
    (_event, input: { sessionID: string | null; directory: string; title: string; model?: OpenCodeModel | null }) =>
      ensureOpenCodeSession(settings.opencode, input).then((sessionID) => ({ sessionID }))
  )
  ipcMain.handle('opencode:prompt', (_event, sessionID: string, text: string) =>
    promptOpenCode(settings.opencode, sessionID, text)
  )
  ipcMain.handle('opencode:interrupt', (_event, sessionID: string) => interruptOpenCode(settings.opencode, sessionID))
  ipcMain.handle(
    'opencode:permission',
    (_event, sessionID: string, requestID: string, decision: 'once' | 'always' | 'reject') =>
      replyOpenCodePermission(settings.opencode, sessionID, requestID, decision)
  )
  ipcMain.handle('opencode:diff', (_event, sessionID: string) => openCodeDiff(settings.opencode, sessionID))

  const publishTunnel = (url: string | null): void => {
    mainWindow?.webContents.send('automation:tunnel', url)
    refreshTray()
  }

  ipcMain.handle('hooks:tunnel-status', () => tunnelUrl())
  ipcMain.handle('hooks:tunnel-stop', () => {
    stopTunnel()
    publishTunnel(null)
  })
  ipcMain.handle('hooks:tunnel-start', async () => {
    try {
      const url = await startTunnel(hookPort, () => publishTunnel(null))
      publishTunnel(url)
      return { url }
    } catch (err) {
      publishTunnel(null)
      return { url: null, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'workspace:revert',
    (_event, folder: string, filePath: string, previous: string | null) =>
      restoreWorkspaceFile(folder, filePath, previous)
  )
  ipcMain.handle(
    'workspace:revert-hunk',
    (_event, folder: string, filePath: string, previous: string | null, hunk: HunkEdit) =>
      rejectWorkspaceHunk(folder, filePath, previous, hunk)
  )

  ipcMain.handle('models:list', async (_event, providerId: string) => {
    const provider = settings.providers.find((p) => p.id === providerId)
    if (!provider) return []
    try {
      return await listModels(provider)
    } catch {
      return []
    }
  })

  ipcMain.handle('dialog:pickFolder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Escolha a pasta de trabalho da conversa',
      buttonLabel: 'Usar esta pasta',
      properties: ['openDirectory', 'createDirectory']
    })
    const folder = result.canceled ? null : (result.filePaths[0] ?? null)
    if (folder) {
      // cria a estrutura .osvacode/ e instala as skills da stack detectada
      ensureProjectDir(folder)
      autoInstallSkills(folder)
    }
    return folder
  })

  ipcMain.handle('dialog:pickAttachment', async (_event, kind: 'image' | 'file' | 'folder') => {
    if (!mainWindow) return null
    if (kind === 'folder') {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Adicionar pasta',
        buttonLabel: 'Adicionar',
        properties: ['openDirectory']
      })
      const folder = result.canceled ? null : (result.filePaths[0] ?? null)
      return folder ? [readFolderAttachment(folder)] : null
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: kind === 'image' ? 'Adicionar imagem' : 'Adicionar arquivo',
      buttonLabel: 'Adicionar',
      properties: ['openFile', 'multiSelections'],
      filters:
        kind === 'image'
          ? [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }]
          : [{ name: 'Arquivos', extensions: ['*'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const picked = result.filePaths.flatMap((filePath) => {
      if (kind === 'image') {
        const image = readImageAttachment(filePath)
        return image ? [image] : []
      }
      return [readFileAttachment(filePath)]
    })
    return picked.length > 0 ? picked : null
  })

  ipcMain.handle(
    'chat:send',
    async (_event, requestId: string, history: ChatMessage[], options?: ChatSendOptions) => {
      const provider = options?.providerId
        ? (settings.providers.find((item) => item.id === options.providerId) ?? activeProvider())
        : activeProvider()
      const team = options?.teamId
        ? (settings.teams ?? []).find((item) => item.id === options.teamId)
        : undefined
      const useTeam = !!team && team.steps.length > 0
      if ((!useTeam || options?.design) && !provider) {
        emitTo(requestId, {
          type: 'error',
          message: 'Nenhum provedor de modelo configurado. Abra as Configurações.'
        })
        return
      }

      const folder = options?.folder ?? null
      const mode = options?.mode ?? 'edit'
      await mcp.setWorkspace(folder)

      // "/acao args" e "/skill" viram o prompt completo só no que vai ao modelo;
      // a conversa na tela continua mostrando o comando curto que o usuário digitou
      history = history.map((message) =>
        message.role === 'user'
          ? { ...message, content: expandSlashCommands(folder, message.content) }
          : message
      )

      let systemPrompt = folder
        ? `${settings.systemPrompt}\n\nPasta de trabalho: ${folder}.\n` +
          'Você pode ler e editar os arquivos desta pasta. Mantenha o contexto das mensagens anteriores. ' +
          'Se o usuário pedir para alterar um arquivo já criado, grave de novo no mesmo caminho. ' +
          'Se ele só perguntar, responda em texto e não crie outro arquivo. ' +
          `O path do arquivo é absoluto e começa com ${folder} uma única vez. Não repita essa pasta no meio do caminho.`
        : settings.systemPrompt

      if (folder) {
        // garante a estrutura .osvacode/ (pastas antigas ganham na 1ª mensagem),
        // instala skills da stack detectada e injeta tudo no prompt
        ensureProjectDir(folder)
        autoInstallSkills(folder)
        systemPrompt += projectPromptBlock(folder, loadProjectContext(folder))
      }

      if (mode === 'propose') {
        systemPrompt += '\n\nATENÇÃO: Você está no modo "APENAS PROPOR". VOCÊ ESTÁ PROIBIDO DE MODIFICAR, ESCREVER OU CRIAR ARQUIVOS. Apenas sugira e mostre os códigos na resposta.'
      }

      if (options?.design) {
        systemPrompt += `\n\n${designInstructions(options.design)}`
      }

      const controller = new AbortController()
      activeRequests.set(requestId, controller)
      const emit = (event: Parameters<typeof emitTo>[1]): void => emitTo(requestId, event)
      const requestPermission = (request: PermissionRequest): Promise<'allow' | 'deny'> =>
        resolvePermission(requestId, request, controller.signal)
      const run = useTeam && !options?.design
        ? runTeam({
            team: team!,
            providers: settings.providers,
            systemPrompt,
            history,
            mcp,
            emit,
            requestPermission,
            signal: controller.signal,
            allowFileWrites: mode !== 'propose'
          })
        : runChat({
            provider: provider!,
            systemPrompt,
            history,
            mcp,
            emit,
            requestPermission,
            signal: controller.signal,
            allowFileWrites: mode !== 'propose',
            design: options?.design
          })
      void run.finally(() => activeRequests.delete(requestId))
    }
  )

  ipcMain.handle(
    'chat:permission-response',
    (_event, permissionId: string, decision: PermissionDecision) => {
      pendingPermissions.get(permissionId)?.(decision)
    }
  )

  ipcMain.handle('chat:simplify', (_event, requestId: string, text: string) => {
    const provider = activeProvider()
    if (!provider) {
      emitTo(requestId, { type: 'error', message: 'Nenhum provedor de modelo configurado.' })
      return
    }
    const controller = new AbortController()
    activeRequests.set(requestId, controller)
    void runSimplify({
      provider,
      text,
      emit: (event) => emitTo(requestId, event),
      signal: controller.signal
    }).finally(() => activeRequests.delete(requestId))
  })

  ipcMain.handle('chat:abort', (_event, requestId: string) => {
    activeRequests.get(requestId)?.abort()
    activeRequests.delete(requestId)
  })

  ipcMain.handle('sync:list', async () => {
    const auth = syncAuth()
    if (!settings.openWebUi.enabled || !auth) return []
    try {
      return await owuiListChats(auth)
    } catch (err) {
      console.error('sync:list falhou:', err)
      return []
    }
  })

  ipcMain.handle('sync:pull', async (_event, id: string) => {
    const auth = syncAuth()
    if (!auth) throw new Error('Sem credenciais para o Open WebUI. Faça login.')
    return owuiPullChat(auth, id)
  })

  ipcMain.handle('sync:push', async (_event, payload: SyncPushPayload) => {
    const auth = syncAuth()
    if (!settings.openWebUi.enabled || !auth || payload.messages.length === 0) return null
    try {
      return await owuiPushChat(auth, payload)
    } catch (err) {
      console.error('sync:push falhou:', err)
      return null
    }
  })

  ipcMain.handle('project:read', (_event, folder: string) => readProjectFiles(folder))

  ipcMain.handle('project:catalog', (_event, folder: string) => catalogStatus(folder))

  ipcMain.handle('project:install-catalog-skill', (_event, folder: string, id: string) => {
    installCatalogSkill(folder, id)
  })

  ipcMain.handle('project:save-instructions', (_event, folder: string, content: string) => {
    saveProjectInstructions(folder, content)
  })

  ipcMain.handle('project:save-notes', (_event, folder: string, content: string) => {
    saveProjectNotes(folder, content)
  })

  ipcMain.handle('project:save-skill', (_event, folder: string, name: string, content: string) => {
    return saveProjectSkill(folder, name, content)
  })

  ipcMain.handle('project:delete-skill', (_event, folder: string, name: string) => {
    deleteProjectSkill(folder, name)
  })

  ipcMain.handle('project:save-action', (_event, folder: string, name: string, content: string) => {
    return saveProjectAction(folder, name, content)
  })

  ipcMain.handle('project:delete-action', (_event, folder: string, name: string) => {
    deleteProjectAction(folder, name)
  })

  ipcMain.handle('project:commands', (_event, folder: string | null) => listSlashCommands(folder))

  ipcMain.handle('sync:delete', async (_event, owuiId: string) => {
    const auth = syncAuth()
    if (!auth) return false
    try {
      await owuiDeleteChat(auth, owuiId)
      return true
    } catch (err) {
      console.error('sync:delete falhou:', err)
      return false
    }
  })

  ipcMain.handle('auth:session', () => session)

  ipcMain.handle(
    'auth:login',
    async (_event, email: string, password: string, serverUrl?: string) => {
      const url = resolveServerUrl(serverUrl)
      const result = await owuiSignin(url, email, password)
      if (result.user.role === 'pending') {
        throw new Error(
          'Sua conta ainda está aguardando aprovação do administrador. Tente novamente mais tarde.'
        )
      }
      session = result
      saveSessionFile(session)
      rememberServerUrl(url)
      return session
    }
  )

  ipcMain.handle(
    'auth:signup',
    async (_event, name: string, email: string, password: string, serverUrl?: string) => {
      const url = resolveServerUrl(serverUrl)
      const result = await owuiSignup(url, name, email, password)
      rememberServerUrl(url)
      // contas novas nascem pendentes: só entram no app depois de aprovadas
      if (result.user.role !== 'pending') {
        session = result
        saveSessionFile(session)
      }
      return result
    }
  )

  // Modo anônimo/local: entra sem conta e sem Open WebUI. A sincronização fica
  // desligada (token vazio) e as conversas são guardadas só neste computador.
  ipcMain.handle('auth:anonymous', () => {
    session = {
      token: '',
      serverUrl: '',
      user: {
        id: 'local',
        name: settings.userName?.trim() || 'Convidado',
        email: '',
        role: 'local'
      }
    }
    saveSessionFile(session)
    return session
  })

  ipcMain.handle('auth:logout', () => {
    session = null
    clearSessionFile()
  })

  ipcMain.handle('browser:navigate', (_event, url: string) => browserNavigate(url))
  ipcMain.handle('browser:open-file', (_event, relativePath: string) => browserOpenFile(relativePath))
  ipcMain.handle('browser:command', (_event, command: 'back' | 'forward' | 'reload' | 'stop') =>
    browserCommand(command)
  )
  ipcMain.handle('browser:bounds', (_event, bounds: BrowserBounds | null) => {
    setBrowserBounds(bounds)
  })
  ipcMain.handle('browser:state', () => browserState())
  ipcMain.handle('browser:external', () => {
    browserOpenExternal()
  })
}

/**
 * Ao acordar da suspensão (computador dormiu), as conexões de streaming ficam
 * meio-abertas e a resposta trava. Interrompemos as gerações ativas na hora e
 * avisamos a interface, que oferece um botão "Continuar".
 */
function registerPowerHandlers(): void {
  powerMonitor.on('resume', () => {
    for (const [requestId, controller] of [...activeRequests]) {
      emitTo(requestId, {
        type: 'interrupted',
        message:
          'A resposta foi interrompida porque o computador suspendeu (dormiu). ' +
          'Clique em Continuar para gerar a resposta novamente.'
      })
      controller.abort()
    }
  })
}

function trayIcon(): Electron.NativeImage {
  const size = 16
  const bitmap = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - 7.5
      const dy = y - 7.5
      const dist = Math.sqrt(dx * dx + dy * dy)
      const i = (y * size + x) * 4
      bitmap[i + 3] = dist < 6.2 && dist > 3.4 ? 255 : 0
    }
  }
  const image = nativeImage.createFromBitmap(bitmap, { width: size, height: size })
  image.setTemplateImage(true)
  return image
}

function showMainWindow(): void {
  if (!mainWindow) createWindow()
  else {
    mainWindow.show()
    mainWindow.focus()
  }
}

function refreshTray(): void {
  if (!tray) return
  const url = tunnelUrl()
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'Abrir OsvaCode', click: () => showMainWindow() },
    {
      label: url ? 'Encerrar túnel' : 'Abrir túnel',
      click: () => {
        if (url) {
          stopTunnel()
          mainWindow?.webContents.send('automation:tunnel', null)
          refreshTray()
          return
        }
        void startTunnel(hookPort, () => {
          mainWindow?.webContents.send('automation:tunnel', null)
          refreshTray()
        })
          .then((next) => {
            mainWindow?.webContents.send('automation:tunnel', next)
            refreshTray()
          })
          .catch(() => refreshTray())
      }
    }
  ]
  if (url) template.push({ label: url, enabled: false })
  template.push(
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        quitting = true
        stopTunnel()
        app.quit()
      }
    }
  )
  tray.setContextMenu(template.length ? Menu.buildFromTemplate(template) : null)
  tray.setToolTip(url ? `OsvaCode · ${url}` : 'OsvaCode')
}

function installTray(): void {
  tray = new Tray(trayIcon())
  tray.on('click', () => showMainWindow())
  refreshTray()
}

function deliverHook(event: AutomationHookEvent): void {
  const note = new Notification({
    title: 'OsvaCode',
    body: 'Uma ferramenta disparou uma automatização.'
  })
  note.on('click', () => showMainWindow())
  note.show()
  if (!mainWindow) createWindow()
  const send = (): void => {
    mainWindow?.webContents.send('automation:hook', event)
  }
  if (mainWindow?.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send)
  else send()
}

app.whenReady().then(async () => {
  settings = loadSettings()
  session = loadSessionFile()
  registerIpc()
  try {
    hookPort = await startAutomationHooks(() => settings, deliverHook)
  } catch (err) {
    console.error('Não foi possível abrir o endereço das automações:', err)
  }
  registerPowerHandlers()
  installTray()
  createWindow()
  startOpenCodeStream(settings.opencode, publishOpenCode)
  await mcp.sync(settings.mcpServers)

  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('window-all-closed', () => {
  // O ícone na barra mantém os webhooks e os horários enquanto o processo vive.
})

app.on('before-quit', () => {
  quitting = true
  stopTunnel()
  void mcp.closeAll()
})
