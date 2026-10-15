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

/** Servidor local do OpenCode (`opencode serve`), usado pela aba OpenCode. */
export interface OpenCodeConfig {
  url: string
  username: string
  password: string
}

/** Modelo disponível no servidor OpenCode. */
export interface OpenCodeModel {
  id: string
  providerID: string
  name: string
}

export interface OpenCodeFileDiff {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: 'added' | 'deleted' | 'modified'
}

export interface OpenCodePermission {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
}

/** Eventos já traduzidos do fluxo do OpenCode para a interface. */
export type OpenCodeNotice =
  | { type: 'status'; online: boolean; message: string }
  | { type: 'text-delta'; sessionID: string; delta: string }
  | { type: 'text-ended'; sessionID: string; text: string }
  | { type: 'tool'; sessionID: string; callID: string; name: string; state: 'start' | 'ok' | 'fail'; detail: string }
  | { type: 'shell'; sessionID: string; callID: string; command: string; output: string; done: boolean }
  | { type: 'permission'; request: OpenCodePermission }
  | { type: 'permission-cleared'; sessionID: string; requestID: string }
  | { type: 'diff'; sessionID: string; files: OpenCodeFileDiff[] }
  | { type: 'idle'; sessionID: string }
  | { type: 'busy'; sessionID: string }
  | { type: 'usage'; sessionID: string; input: number; output: number }
  | { type: 'error'; sessionID: string; message: string }

/** Uma etapa de uma equipe: qual modelo entra e o que ele faz. */
export interface AgentStep {
  id: string
  name: string
  /** Instrução desta etapa. O modelo mais capaz pode ficar no meio do caminho. */
  role: string
  providerId: string
}

/** Equipe ordenada. A ordem é o caminho da tarefa. */
export interface AgentTeam {
  id: string
  name: string
  steps: AgentStep[]
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
  /** Equipes de agentes para tarefas que precisam de mais de um modelo. */
  teams: AgentTeam[]
  /** Tarefas salvas que o usuário dispara de novo pelo menu Automatização. */
  automations: Automation[]
  /** Conexão com o servidor OpenCode desta máquina. */
  opencode: OpenCodeConfig
}

export type AutomationSchedule = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly'

export type AutomationHookSource =
  | 'github'
  | 'slack'
  | 'teams'
  | 'sentry'
  | 'linear'
  | 'webhook'
  | 'pagerduty'

/** Porta local que recebe os webhooks das ferramentas. */
export const AUTOMATION_HOOK_PORT = 47321

export function automationHookUrl(token: string, port = AUTOMATION_HOOK_PORT): string {
  return `http://127.0.0.1:${port}/hooks/${token}`
}

/** Quando a automatização pode ser disparada. */
export interface AutomationTrigger {
  id: string
  kind: 'manual' | 'schedule' | 'hook'
  label: string
  schedule?: AutomationSchedule
  source?: AutomationHookSource
  /** Segredo da URL local. Quem tem o endereço dispara a automatização. */
  token?: string
  createdAt?: number
  lastFiredAt?: number
}

/** Evento recebido de uma ferramenta ligada à automatização. */
export interface AutomationHookEvent {
  automationId: string
  triggerId: string
  source: AutomationHookSource
  summary: string
}

/** Uma execução disparada pelo usuário. */
export interface AutomationRun {
  at: number
  conversationId: string
}

/** Tarefa salva: um pedido pronto para abrir uma conversa e enviar. */
export interface Automation {
  id: string
  name: string
  prompt: string
  kind: 'chat' | 'dev'
  folder?: string
  /** Desligada não roda. Ausente nas automações antigas significa ligada. */
  enabled?: boolean
  /** Modelo desta automatização. Vazio = o modelo ativo do app. */
  providerId?: string | null
  triggers?: AutomationTrigger[]
  runs?: AutomationRun[]
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
  /** Imagens desta mensagem, em data URL, para modelos que enxergam. */
  images?: { dataUrl: string }[]
}

/** O que o usuário adicionou pelo botão + do campo de mensagem. */
export type PickedAttachment =
  | { kind: 'image'; name: string; dataUrl: string }
  | { kind: 'file'; name: string; text: string }
  | { kind: 'folder'; name: string; text: string }

/**
 * Comando de barra disponível no campo de mensagem.
 * - action: prompt pronto (.osvacode/actions/*.md ou embutido no app); `/nome args`.
 * - skill: força uma skill do projeto nesta mensagem; `/nome` (pode encadear várias).
 */
export interface SlashCommand {
  name: string
  kind: 'action' | 'skill'
  description: string
  source: 'project' | 'builtin'
}

/** Contagem de tokens devolvida pelo modelo. */
export interface ModelUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Tamanho da janela de contexto, quando o servidor informa. */
  contextTokens: number | null
}

export interface ChatSendOptions {
  /** Pasta de trabalho da conversa; habilita ferramentas de arquivo restritas a ela. */
  folder?: string | null
  /** Se 'edit', permite edição. Se 'propose', apenas propõe sem editar arquivos. Padrão: 'edit'. */
  mode?: 'edit' | 'propose'
  /** Equipe desta mensagem. Vazio = só o modelo ativo. */
  teamId?: string | null
  /** Modelo desta mensagem. Vazio = o modelo ativo do app. */
  providerId?: string | null
  /** Design aberto no canvas. Liga a ferramenta design_canvas. */
  design?: import('./design').DesignContext
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
  /** Tokens contados pelo modelo nesta rodada. promptTokens é o contexto enviado. */
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'error'; message: string }
  | {
      type: 'agent-start'
      agentId: string
      name: string
      modelLabel: string
      role: string
      index: number
      total: number
    }
  | { type: 'agent-end'; agentId: string; ok: boolean; summary: string }
  /** Arquivo da pasta de trabalho criado, editado ou removido durante a geração. */
  | { type: 'file-change'; change: FileChange }
  /** Desenho pronto para o canvas da área Design. */
  | { type: 'design-update'; design: import('./design').DesignSnapshot }
  /** Saída de um comando rodado na pasta de trabalho. */
  | { type: 'command-output'; command: string; output: string; ok: boolean }
  /** Geração interrompida por algo externo (computador dormiu, conexão caiu): é retomável. */
  | { type: 'interrupted'; message: string }

export interface DiffLine {
  type: 'ctx' | 'add' | 'del' | 'gap'
  text: string
}

/** Diferença de um arquivo, pronta para o painel de alterações. */
export interface FileChange {
  /** Caminho relativo à pasta de trabalho, com barras /. */
  path: string
  kind: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  lines: DiffLine[]
  /** Conteúdo final, só para HTML, SVG e Markdown, para pré-visualizar. */
  preview?: string
  /** Texto anterior. null se o arquivo foi criado. Ausente se a reversão não cabe na memória. */
  previous?: string | null
}

/** Retângulo do navegador embutido, em pixels CSS da janela. */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export interface ChatEventPayload {
  requestId: string
  event: StreamEvent
}
