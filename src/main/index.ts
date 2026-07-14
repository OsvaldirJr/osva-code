import { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { DEFAULT_OPENWEBUI_URL, loadSettings, saveSettings } from './config'
import { McpManager } from './mcp'
import { listModels, runChat, runSimplify, type PermissionRequest } from './chat'
import { owuiDeleteChat, owuiListChats, owuiPullChat, owuiPushChat, type OwuiAuth } from './sync'
import { clearSessionFile, loadSessionFile, owuiSignin, owuiSignup, saveSessionFile } from './auth'
import type {
  AppSettings,
  AuthSession,
  ChatEventPayload,
  ChatMessage,
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
  openWebUi: { url: '', apiKey: '', enabled: false }
}
const mcp = new McpManager()
const activeRequests = new Map<string, AbortController>()
const pendingPermissions = new Map<string, (decision: PermissionDecision) => void>()
let session: AuthSession | null = null

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
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
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
    await mcp.sync(settings.mcpServers)
    return mcp.status(settings.mcpServers)
  })

  ipcMain.handle('mcp:status', () => mcp.status(settings.mcpServers))

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
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(
    'chat:send',
    async (_event, requestId: string, history: ChatMessage[], options?: ChatSendOptions) => {
      const provider = activeProvider()
      if (!provider) {
        emitTo(requestId, {
          type: 'error',
          message: 'Nenhum provedor de modelo configurado. Abra as Configurações.'
        })
        return
      }

      const folder = options?.folder ?? null
      const mode = options?.mode ?? 'edit'
      await mcp.setWorkspace(folder)

      let systemPrompt = folder
        ? `${settings.systemPrompt}\n\nPasta de trabalho desta conversa: ${folder}.\n` +
          'Você tem ferramentas para listar, ler e escrever arquivos dentro dela.\n' +
          'Regras EXTREMAMENTE IMPORTANTES para trabalhar com arquivos:\n' +
          `1. SEMPRE use caminhos absolutos iniciando com a pasta de trabalho (ex: ${folder}/arquivo.ts).\n` +
          '2. NUNCA use caminhos relativos (como ./ ou ../) ou adivinhe caminhos de arquivos.\n' +
          '3. Antes de ler ou modificar arquivos, use a ferramenta de listar diretórios para descobrir a estrutura correta e os nomes exatos das pastas e arquivos.\n' +
          'Quando o usuário mencionar arquivos ou "esta pasta", aplique essas regras.'
        : settings.systemPrompt

      if (mode === 'propose') {
        systemPrompt += '\n\nATENÇÃO: Você está no modo "APENAS PROPOR". VOCÊ ESTÁ PROIBIDO DE MODIFICAR, ESCREVER OU CRIAR ARQUIVOS. Apenas sugira e mostre os códigos na resposta.'
      }

      const controller = new AbortController()
      activeRequests.set(requestId, controller)
      void runChat({
        provider,
        systemPrompt,
        history,
        mcp,
        emit: (event) => emitTo(requestId, event),
        requestPermission: (request) => resolvePermission(requestId, request, controller.signal),
        signal: controller.signal
      }).finally(() => activeRequests.delete(requestId))
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

  ipcMain.handle('auth:login', async (_event, email: string, password: string) => {
    const url = settings.openWebUi.url || DEFAULT_OPENWEBUI_URL
    const result = await owuiSignin(url, email, password)
    if (result.user.role === 'pending') {
      throw new Error(
        'Sua conta ainda está aguardando aprovação do administrador. Tente novamente mais tarde.'
      )
    }
    session = result
    saveSessionFile(session)
    return session
  })

  ipcMain.handle('auth:signup', async (_event, name: string, email: string, password: string) => {
    const url = settings.openWebUi.url || DEFAULT_OPENWEBUI_URL
    const result = await owuiSignup(url, name, email, password)
    // contas novas nascem pendentes: só entram no app depois de aprovadas
    if (result.user.role !== 'pending') {
      session = result
      saveSessionFile(session)
    }
    return result
  })

  ipcMain.handle('auth:logout', () => {
    session = null
    clearSessionFile()
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

app.whenReady().then(async () => {
  settings = loadSettings()
  session = loadSessionFile()
  registerIpc()
  registerPowerHandlers()
  createWindow()
  await mcp.sync(settings.mcpServers)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void mcp.closeAll()
})
