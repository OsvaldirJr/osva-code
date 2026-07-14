// Tipos compartilhados entre o processo principal (Electron) e a interface (React).

/** Um provedor de modelo: qualquer endpoint compatível com a API da OpenAI (Ollama, vLLM, OpenRouter, etc.) */
export interface ProviderConfig {
  id: string
  name: string
  baseURL: string
  apiKey: string
  model: string
}

/** Um servidor MCP iniciado via stdio (comando local). */
export interface McpServerConfig {
  id: string
  name: string
  command: string
  /** Argumentos separados; na UI são digitados como uma linha única. */
  args: string[]
  env?: Record<string, string>
  enabled: boolean
}

export interface OpenWebUiConfig {
  url: string
  apiKey: string
  enabled: boolean
}

export interface AuthUser {
  id: string
  name: string
  email: string
  role: string
}

/** Sessão do usuário logado. token vazio + id 'local' = modo sem conta. */
export interface AuthSession {
  token: string
  serverUrl: string
  user: AuthUser
}

export interface AppSettings {
  providers: ProviderConfig[]
  activeProviderId: string | null
  mcpServers: McpServerConfig[]
  systemPrompt: string
  userName: string
  /** Ferramentas com permissão permanente, chaveadas pelo nome completo (servidor__ferramenta). */
  toolPermissions: Record<string, 'always'>
  /** Sincronização de conversas com o Open WebUI. */
  openWebUi: OpenWebUiConfig
}

/** Conversa existente no Open WebUI (para importação). */
export interface RemoteChatStub {
  id: string
  title: string
  updatedAt: number
}

export interface SyncMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SyncPushPayload {
  owuiId: string | null
  title: string
  model: string
  messages: SyncMessage[]
}

export type PermissionDecision = 'allow' | 'allow-always' | 'deny'

export interface McpToolInfo {
  name: string
  description?: string
}

export interface McpServerStatus {
  id: string
  name: string
  connected: boolean
  error?: string
  tools: McpToolInfo[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatSendOptions {
  /** Pasta de trabalho da conversa; habilita ferramentas de arquivo restritas a ela. */
  folder?: string | null
  /** Se 'edit', permite edição. Se 'propose', apenas propõe sem editar arquivos. Padrão: 'edit'. */
  mode?: 'edit' | 'propose'
}

/** Eventos emitidos pelo processo principal durante uma geração. */
export type StreamEvent =
  | { type: 'token'; text: string }
  | {
      type: 'tool-permission'
      callId: string
      permissionId: string
      toolName: string
      serverName: string
      explanation: string
    }
  | {
      type: 'tool-start'
      callId: string
      toolName: string
      serverName: string
      explanation: string
    }
  | { type: 'tool-end'; callId: string; ok: boolean; denied?: boolean; summary: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  /** Geração interrompida por algo externo (computador dormiu, conexão caiu): é retomável. */
  | { type: 'interrupted'; message: string }

export interface ChatEventPayload {
  requestId: string
  event: StreamEvent
}
