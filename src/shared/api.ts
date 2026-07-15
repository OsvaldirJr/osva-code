import type {
  AppSettings,
  AuthSession,
  ChatEventPayload,
  ChatMessage,
  ChatSendOptions,
  McpServerStatus,
  PermissionDecision,
  RemoteChatStub,
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
  /** Lê instructions.md, skills e notas do .osvacode da pasta do projeto. */
  projectRead: (folder: string) => Promise<{
    instructions: string
    skills: { name: string; content: string }[]
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
  logout: () => Promise<void>
  onChatEvent: (callback: (payload: ChatEventPayload) => void) => () => void
}
