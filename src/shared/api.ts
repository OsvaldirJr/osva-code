import type {
  AppSettings,
  AuthSession,
  BrowserBounds,
  BrowserState,
  AutomationHookEvent,
  ChatEventPayload,
  ChatMessage,
  PickedAttachment,
  ChatSendOptions,
  McpServerStatus,
  PermissionDecision,
  RemoteChatStub,
  SlashCommand,
  SyncMessage,
  SyncPushPayload
} from './types'

/** API exposta pelo preload em window.api. */
export interface OsvaCodeApi {
  getSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<McpServerStatus[]>
  getMcpStatus: () => Promise<McpServerStatus[]>
  listModels: (providerId: string) => Promise<string[]>
  pickFolder: () => Promise<string | null>
  /** Imagem, arquivo ou pasta para anexar na mensagem. Null se o usuário cancelar. */
  pickAttachment: (kind: 'image' | 'file' | 'folder') => Promise<PickedAttachment[] | null>
  sendChat: (requestId: string, history: ChatMessage[], options?: ChatSendOptions) => Promise<void>
  simplify: (requestId: string, text: string) => Promise<void>
  respondPermission: (permissionId: string, decision: PermissionDecision) => Promise<void>
  abort: (requestId: string) => Promise<void>
  syncList: () => Promise<RemoteChatStub[]>
  syncPull: (id: string) => Promise<{ title: string; messages: SyncMessage[] }>
  /** Envia a conversa ao Open WebUI; retorna o id remoto ou null se a sync estiver desativada/falhar. */
  syncPush: (payload: SyncPushPayload) => Promise<string | null>
  /** Apaga a conversa no Open WebUI; retorna false se falhar. */
  syncDelete: (owuiId: string) => Promise<boolean>
  /** Lê instructions.md, skills, ações e notas do .osvacode da pasta do projeto. */
  projectRead: (folder: string) => Promise<{
    instructions: string
    skills: { name: string; content: string }[]
    actions: { name: string; content: string }[]
    notes: string
  }>
  projectSaveInstructions: (folder: string, content: string) => Promise<void>
  projectSaveNotes: (folder: string, content: string) => Promise<void>
  /** Catálogo de skills prontas: instaladas e detectadas para a pasta. */
  projectCatalog: (folder: string) => Promise<
    { id: string; label: string; description: string; installed: boolean; detected: boolean }[]
  >
  projectInstallCatalogSkill: (folder: string, id: string) => Promise<void>
  /** Salva a skill e retorna o nome normalizado do arquivo. */
  projectSaveSkill: (folder: string, name: string, content: string) => Promise<string>
  projectDeleteSkill: (folder: string, name: string) => Promise<void>
  /** Salva a ação (/nome) e retorna o nome normalizado do arquivo. */
  projectSaveAction: (folder: string, name: string, content: string) => Promise<string>
  projectDeleteAction: (folder: string, name: string) => Promise<void>
  /** Comandos de barra (/ação e /skill) disponíveis; sem pasta, só as ações embutidas. */
  projectCommands: (folder: string | null) => Promise<SlashCommand[]>
  getSession: () => Promise<AuthSession | null>
  /** serverUrl opcional: quando informado, passa a ser o servidor padrão do app. */
  login: (email: string, password: string, serverUrl?: string) => Promise<AuthSession>
  /** Cria a conta no Open WebUI; se voltar com role 'pending', ela aguarda aprovação do admin. */
  signup: (
    name: string,
    email: string,
    password: string,
    serverUrl?: string
  ) => Promise<AuthSession>
  /** Entra em modo anônimo/local: sem conta e sem Open WebUI; conversas ficam só neste computador. */
  loginAnonymous: () => Promise<AuthSession>
  logout: () => Promise<void>
  onChatEvent: (callback: (payload: ChatEventPayload) => void) => () => void
  /** Porta local dos webhooks de GitHub, Slack e das outras ferramentas. */
  hookPort: () => Promise<number>
  onAutomationHook: (callback: (event: AutomationHookEvent) => void) => () => void
  /** Abre uma URL http(s) no navegador embutido. Sem esquema, assume https. */
  navigateBrowser: (url: string) => Promise<BrowserState>
  /** Abre um arquivo da pasta de trabalho atual no navegador embutido. */
  openBrowserFile: (relativePath: string) => Promise<BrowserState>
  browserCommand: (command: 'back' | 'forward' | 'reload' | 'stop') => Promise<BrowserState>
  /** null esconde a view nativa (aba fechada, modal aberto ou painel oculto). */
  setBrowserBounds: (bounds: BrowserBounds | null) => Promise<void>
  getBrowserState: () => Promise<BrowserState>
  /** Abre a URL atual no navegador do sistema. */
  openBrowserExternal: () => Promise<void>
  onBrowserState: (callback: (state: BrowserState) => void) => () => void
}
