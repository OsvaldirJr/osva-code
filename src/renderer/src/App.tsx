import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  Automation,
  AutomationHookEvent,
  AuthSession,
  ChatMessage,
  PickedAttachment,
  FileChange,
  OpenCodeFileDiff,
  OpenCodeModel,
  OpenCodeNotice,
  OpenCodePermission,
  McpServerStatus,
  RemoteChatStub,
  SlashCommand
} from '../../shared/types'
import { AUTOMATION_HOOK_PORT } from '../../shared/types'
import type { DesignKind } from '../../shared/design'
import { DESIGN_KINDS } from '../../shared/design'
import { AgentCard } from './components/AgentCard'
import { MessageView } from './components/MessageView'
import { ToolCallCard } from './components/ToolCallCard'
import { ErrorBubble } from './components/ErrorBubble'
import { SettingsModal } from './components/SettingsModal'
import { Sidebar } from './components/Sidebar'
import { AutomationsPanel, HOOK_SOURCES, scheduleIsDue } from './components/AutomationsPanel'
import { DesignPanel, type DesignDoc } from './components/DesignPanel'
import { LoginScreen } from './components/LoginScreen'
import { ProjectPanel } from './components/ProjectPanel'
import { SlashMenu, filterSlashCommands, slashQuery } from './components/SlashMenu'
import { Workbench, type CommandRun, type ReviewHunk, type WorkbenchTab } from './components/Workbench'
import { OpenCodePane, OpenCodeSections, type OpenCodeShellRun, type OpenCodeView } from './components/OpenCodePanel'
import type { Artifact } from './artifacts'
import {
  FolderOpen, Plus, Settings, AlertTriangle, Folder, Image, FileText, Mic, Square, ArrowUp, ChevronDown, X, NotebookPen, PanelRight
} from 'lucide-react'

export type UiMessage =
  | { kind: 'user'; id: string; content: string; images?: { dataUrl: string }[] }
  | {
      kind: 'assistant'
      id: string
      content: string
      streaming: boolean
      simplified?: string
      simplifying?: boolean
    }
  | {
      kind: 'tool'
      id: string
      callId: string
      toolName: string
      serverName: string
      explanation: string
      status: 'awaiting' | 'running' | 'ok' | 'error' | 'denied'
      permissionId?: string
      summary?: string
    }
  | { kind: 'error'; id: string; content: string; resumable?: boolean }
  | {
      kind: 'agent'
      id: string
      agentId: string
      name: string
      modelLabel: string
      role: string
      index: number
      total: number
      status: 'running' | 'ok' | 'error'
      summary?: string
    }

type DraftAttachment = PickedAttachment & { id: string }

function toChatMessages(messages: UiMessage[]): ChatMessage[] {
  return messages
    .filter((message): message is Extract<UiMessage, { kind: 'user' | 'assistant' }> =>
      message.kind === 'user' || message.kind === 'assistant'
    )
    .map((message) => ({
      role: message.kind,
      content: message.content,
      ...(message.kind === 'user' && message.images?.length ? { images: message.images } : {})
    }))
}

function shrinkImage(dataUrl: string): Promise<string> {
  if (dataUrl.startsWith('data:image/svg')) return Promise.resolve(dataUrl)
  return new Promise((resolve) => {
    const image = new window.Image()
    image.onload = () => {
      const max = 1600
      const scale = Math.min(1, max / Math.max(image.width, image.height))
      if (scale === 1 && dataUrl.length < 500_000) {
        resolve(dataUrl)
        return
      }
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.width * scale))
      canvas.height = Math.max(1, Math.round(image.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(dataUrl)
        return
      }
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.82))
    }
    image.onerror = () => resolve(dataUrl)
    image.src = dataUrl
  })
}

export type ConversationKind = 'chat' | 'dev' | 'opencode'

export interface Conversation {
  id: string
  title: string
  messages: UiMessage[]
  updatedAt: number
  folder?: string
  /** 'chat' = conversa simples; 'dev' = pasta e ferramentas daqui; 'opencode' = agente do OpenCode. */
  kind?: ConversationKind
  /** Sessão criada no servidor OpenCode para esta conversa. */
  opencodeSessionId?: string
  /** Modelo do OpenCode usado nesta conversa. */
  opencodeModel?: OpenCodeModel
  /** Equipe usada nesta conversa. Ausente = só o modelo ativo. */
  teamId?: string | null
  /** id da conversa correspondente no Open WebUI, quando sincronizada */
  owuiId?: string
  /** true até o título ser tirado da primeira mensagem */
  autoTitle?: boolean
  /** Última contagem de tokens desta conversa. */
  usage?: ConversationUsage
}

export interface ConversationUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  contextTokens: number | null
  /** Soma das respostas geradas nesta conversa. */
  generatedTokens: number
}

function openCodeModelKey(model: OpenCodeModel): string {
  return `${model.providerID}\u001f${model.id}`
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat('pt-BR').format(value)
}

function UsageOrb({
  usage,
  open,
  modelName,
  modelId,
  onToggle
}: {
  usage?: ConversationUsage
  open: boolean
  modelName: string
  modelId: string
  onToggle: () => void
}): JSX.Element {
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const ratio =
    usage?.contextTokens && usage.contextTokens > 0
      ? Math.min(1, usage.promptTokens / usage.contextTokens)
      : 0
  const tone = ratio >= 0.9 ? 'high' : ratio >= 0.7 ? 'mid' : 'ok'
  return (
    <>
      <button type="button" className="composer-orb" title="Uso do modelo" onClick={onToggle}>
        <svg className="usage-ring" viewBox="0 0 16 16" aria-hidden="true">
          <circle className="track" cx="8" cy="8" r={radius} />
          <circle
            className={`fill ${tone}`}
            cx="8"
            cy="8"
            r={radius}
            strokeDasharray={`${circumference * ratio} ${circumference}`}
            transform="rotate(-90 8 8)"
          />
        </svg>
      </button>
      {open && (
        <div className="usage-popover" role="dialog" aria-label="Uso do modelo">
          <h2>Uso do modelo</h2>
          <p className="usage-model">
            {modelName}
            {modelId ? ` · ${modelId}` : ''}
          </p>
          {usage ? (
            <>
              <div className="usage-row">
                <span>Contexto</span>
                <strong>{formatTokens(usage.promptTokens)}</strong>
              </div>
              <div className="usage-row">
                <span>Última resposta</span>
                <strong>{formatTokens(usage.completionTokens)}</strong>
              </div>
              <div className="usage-row">
                <span>Gerado na conversa</span>
                <strong>{formatTokens(usage.generatedTokens)}</strong>
              </div>
              {usage.contextTokens ? (
                <p className="usage-context">
                  {Math.round(ratio * 100)}% da janela de {formatTokens(usage.contextTokens)} tokens
                </p>
              ) : (
                <p className="usage-context">O servidor não informou o tamanho da janela.</p>
              )}
            </>
          ) : (
            <p className="usage-context">Nenhum uso ainda. Envie uma mensagem para contar os tokens.</p>
          )}
        </div>
      )}
    </>
  )
}

/** Categoria da conversa. Conversas antigas (sem kind) são 'dev' se têm pasta. */
export function conversationKind(c: Conversation): ConversationKind {
  return c.kind ?? (c.folder ? 'dev' : 'chat')
}

/** Nome da pasta principal: o último segmento do caminho. */
export function folderLabel(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** Caminho sem barra final, para conversas da mesma pasta caírem no mesmo grupo. */
export function folderKey(path: string): string {
  return path.replace(/\/+$/, '')
}

const NEW_CONVERSATION_TITLE = 'Nova conversa'

/** Título curto a partir do primeiro pedido, no lugar de um nome digitado. */
export function titleFromContext(text: string): string {
  const line =
    text
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? ''
  const clean = line
    .replace(/^#+\s*/, '')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return NEW_CONVERSATION_TITLE
  const max = 52
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

/** Caminho encurtado para exibição: …/tres/ultimos/segmentos */
export function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 3) return path
  return '…/' + parts.slice(-3).join('/')
}

const LEGACY_STORAGE_KEY = 'osvacode.conversations'

/** Retomadas automáticas seguidas após interrupção (sono/queda) antes de exigir clique. */
const MAX_AUTO_CONTINUE = 3
/** Espera antes de retomar sozinho, para a rede/modelo voltarem depois de acordar. */
const AUTO_RESUME_DELAY_MS = 5000

/** Chave de armazenamento das conversas do usuário logado. */
function storageKeyFor(userId: string): string {
  return `osvacode.conversations.${userId}`
}

function loadDesignsFor(userId: string): DesignDoc[] {
  try {
    const raw = localStorage.getItem(`osvacode.designs.${userId}`)
    const parsed = raw ? (JSON.parse(raw) as DesignDoc[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function designReply(text: string, applied: boolean, problem: string): string {
  if (problem) return problem.slice(0, 280)
  const clean = text
    .replace(/```design[\s\S]*?```/g, '')
    .replace(/\{[\s\S]*"frames"[\s\S]*\}/g, '')
    .trim()
  if (applied && (!clean || clean.length > 220)) return 'Desenho atualizado no canvas.'
  return clean.slice(0, 280)
}

function loadConversationsFor(userId: string): Conversation[] {
  try {
    let data = localStorage.getItem(storageKeyFor(userId))
    if (!data) {
      // migração: conversas antigas (antes do login) passam a pertencer ao primeiro usuário
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
      if (legacy) {
        data = legacy
        localStorage.setItem(storageKeyFor(userId), legacy)
        localStorage.removeItem(LEGACY_STORAGE_KEY)
      }
    }
    return data ? (JSON.parse(data) as Conversation[]) : []
  } catch {
    return []
  }
}

export default function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [mcpStatus, setMcpStatus] = useState<McpServerStatus[]>([])
  // undefined = ainda carregando a sessão; null = deslogado
  const [session, setSession] = useState<AuthSession | null | undefined>(undefined)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectPanelOpen, setProjectPanelOpen] = useState(false)
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>('changes')
  const [fileChanges, setFileChanges] = useState<Record<string, FileChange[]>>({})
  const [commandRuns, setCommandRuns] = useState<Record<string, CommandRun[]>>({})
  const [ocView, setOcView] = useState<OpenCodeView>('session')
  const [ocOnline, setOcOnline] = useState(false)
  const [ocStatus, setOcStatus] = useState('')
  const [ocDiffs, setOcDiffs] = useState<Record<string, OpenCodeFileDiff[]>>({})
  const [ocPerms, setOcPerms] = useState<Record<string, OpenCodePermission[]>>({})
  const [ocShell, setOcShell] = useState<Record<string, OpenCodeShellRun[]>>({})
  const [ocIntroDone, setOcIntroDone] = useState(() => {
    try {
      return localStorage.getItem('osvacode.opencode.ready') === '1'
    } catch {
      return false
    }
  })
  const [ocModels, setOcModels] = useState<OpenCodeModel[]>([])
  const [ocDefaultModel, setOcDefaultModel] = useState<OpenCodeModel | null>(null)
  const [ocPreferredModel, setOcPreferredModel] = useState<OpenCodeModel | null>(null)
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null)
  const [tunnelBusy, setTunnelBusy] = useState(false)
  const [tunnelMessage, setTunnelMessage] = useState('')
  const [artifacts, setArtifacts] = useState<Record<string, Artifact[]>>({})
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null)
  // aba ativa do menu: 'chat' (conversa simples) ou 'dev' (com pasta de trabalho)
  const [tab, setTab] = useState<ConversationKind>('chat')
  const [section, setSection] = useState<'chats' | 'automations' | 'design'>('chats')
  const [designs, setDesigns] = useState<DesignDoc[]>([])
  const [designId, setDesignId] = useState<string | null>(null)
  const [designStatus, setDesignStatus] = useState('')
  const [hookPort, setHookPort] = useState(AUTOMATION_HOOK_PORT)
  const [usageOpen, setUsageOpen] = useState(false)
  const usageRef = useRef<HTMLDivElement>(null)
  const [addOpen, setAddOpen] = useState(false)
  const addRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!usageOpen && !addOpen) return
    const close = (event: MouseEvent): void => {
      const target = event.target as Node
      if (usageOpen && !usageRef.current?.contains(target)) setUsageOpen(false)
      if (addOpen && !addRef.current?.contains(target)) setAddOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [usageOpen, addOpen])
  const [mode, setMode] = useState<'edit' | 'propose'>('edit')
  const [attachments, setAttachments] = useState<DraftAttachment[]>([])
  const [isRecording, setIsRecording] = useState(false)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const recognitionRef = useRef<any>(null)

  const [remoteChats, setRemoteChats] = useState<RemoteChatStub[]>([])

  const chatRequestId = useRef<string | null>(null)
  // requestId do chat -> conversa que está recebendo os tokens
  const chatTargets = useRef(new Map<string, string>())
  const designTargets = useRef(new Map<string, string>())
  const designsRef = useRef<DesignDoc[]>([])
  const designText = useRef('')
  const designApplied = useRef(false)
  const persistDesignsRef = useRef<(next: DesignDoc[]) => void>(() => {})
  // espelhos para acesso dentro de callbacks de eventos
  const conversationsRef = useRef<Conversation[]>([])
  const settingsRef = useRef<AppSettings | null>(null)
  // de qual usuário são as conversas em memória (evita salvar antes de carregar)
  const conversationsOwner = useRef<string | null>(null)
  // requestId de simplificação -> conversa e mensagem sendo reescrita
  const simplifyTargets = useRef(new Map<string, { conversationId: string; messageId: string }>())
  const generatingConversation = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // retomada automática após interrupção (ex.: o computador dormiu)
  const autoResumeCount = useRef(0)
  const retryRef = useRef<() => void>(() => {})
  const activeIdRef = useRef<string | null>(null)
  // conversa mostrando "retomando automaticamente…" (indicador transitório)
  const [resumingConv, setResumingConv] = useState<string | null>(null)

  const active = conversations.find((c) => c.id === activeId) ?? null
  const activeKind = active ? conversationKind(active) : null
  // pronta para conversar: chat não precisa de pasta; dev precisa.
  const activeReady = !!active && (activeKind === 'chat' || !!active.folder)
  // No Chat, dá para escrever sem conversa aberta: o envio cria uma nova.
  const composerEnabled = (tab === 'chat' && !active) || activeReady

  // ---------- comandos de barra (/ação e /skill) ----------
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([])
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const commandsFolder = active?.folder ?? null

  const refreshSlashCommands = useCallback(() => {
    void window.api
      .projectCommands(commandsFolder)
      .then(setSlashCommands)
      .catch(() => setSlashCommands([]))
  }, [commandsFolder])

  // recarrega ao trocar de pasta e ao fechar o painel do projeto (ações/skills editadas)
  useEffect(() => {
    if (!projectPanelOpen) refreshSlashCommands()
  }, [refreshSlashCommands, projectPanelOpen])

  const slash = composerEnabled && !slashDismissed ? slashQuery(input) : null
  const slashItems = slash ? filterSlashCommands(slashCommands, slash.query) : []
  const slashOpen = slashItems.length > 0

  useEffect(() => {
    setSlashIndex(0)
  }, [slash?.query, slash?.prefix])

  const pickSlashCommand = useCallback(
    (command: SlashCommand) => {
      const current = slashQuery(input)
      setInput(`${current?.prefix ?? ''}/${command.name} `)
      composerRef.current?.focus()
    },
    [input]
  )

  useEffect(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [input])

  useEffect(() => {
    void window.api.getSettings().then(setSettings)
    void window.api.hookPort().then(setHookPort)
    void window.api.tunnelStatus().then(setTunnelUrl)
    void window.api.getSession().then((s) => setSession(s))
    void window.api.getMcpStatus().then(setMcpStatus)

    if ('webkitSpeechRecognition' in window) {
      const SpeechRecognition = (window as any).webkitSpeechRecognition
      const recognition = new SpeechRecognition()
      recognition.continuous = true
      recognition.interimResults = true
      recognition.lang = 'pt-BR'

      recognition.onresult = (event: any) => {
        let finalTranscript = ''
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript
          }
        }
        if (finalTranscript) {
          setInput((prev) => prev + (prev.endsWith(' ') || prev === '' ? '' : ' ') + finalTranscript)
        }
      }

      recognition.onend = () => {
        setIsRecording(false)
      }

      recognitionRef.current = recognition
    }
    return window.api.onTunnel((url) => {
      setTunnelUrl(url)
      setTunnelBusy(false)
    })
  }, [])

  function applyOpenCodeNotice(notice: OpenCodeNotice): void {
    if (notice.type === 'status') {
      setOcOnline(notice.online)
      setOcStatus(notice.message)
      return
    }
    if (notice.type === 'permission') {
      setOcPerms((prev) => {
        const list = prev[notice.request.sessionID] ?? []
        if (list.some((item) => item.id === notice.request.id)) return prev
        return { ...prev, [notice.request.sessionID]: [...list, notice.request] }
      })
      setConversations((prev) =>
        prev.map((conversation) => {
          if (conversation.opencodeSessionId !== notice.request.sessionID) return conversation
          if (conversation.messages.some((item) => item.kind === 'tool' && item.permissionId === notice.request.id)) {
            return conversation
          }
          return {
            ...conversation,
            updatedAt: Date.now(),
            messages: [
              ...conversation.messages,
              {
                kind: 'tool',
                id: notice.request.id,
                callId: notice.request.id,
                toolName: notice.request.permission,
                serverName: 'OpenCode',
                explanation: notice.request.patterns.join('\n') || 'O OpenCode precisa da sua autorização.',
                status: 'awaiting',
                permissionId: notice.request.id
              }
            ]
          }
        })
      )
      return
    }
    if (notice.type === 'permission-cleared') {
      setOcPerms((prev) => ({
        ...prev,
        [notice.sessionID]: (prev[notice.sessionID] ?? []).filter((item) => item.id !== notice.requestID)
      }))
      return
    }
    if (notice.type === 'diff') {
      setOcDiffs((prev) => ({ ...prev, [notice.sessionID]: notice.files }))
      return
    }
    if (notice.type === 'shell') {
      setOcShell((prev) => {
        const list = prev[notice.sessionID] ?? []
        const existing = list.some((item) => item.callID === notice.callID)
        const next = existing
          ? list.map((item) =>
              item.callID === notice.callID
                ? {
                    ...item,
                    command: notice.command || item.command,
                    output: notice.done ? notice.output : item.output,
                    done: notice.done
                  }
                : item
            )
          : [...list, { callID: notice.callID, command: notice.command, output: notice.output, done: notice.done }]
        return { ...prev, [notice.sessionID]: next.slice(-20) }
      })
      return
    }
    if (notice.type === 'usage') {
      setConversations((prev) =>
        prev.map((conversation) => {
          if (conversation.opencodeSessionId !== notice.sessionID) return conversation
          return {
            ...conversation,
            usage: {
              promptTokens: notice.input,
              completionTokens: notice.output,
              totalTokens: notice.input + notice.output,
              contextTokens: conversation.usage?.contextTokens ?? null,
              generatedTokens: (conversation.usage?.generatedTokens ?? 0) + notice.output
            }
          }
        })
      )
      return
    }
    if (notice.type === 'busy') {
      const match = conversationsRef.current.find((item) => item.opencodeSessionId === notice.sessionID)
      if (match) {
        generatingConversation.current = match.id
        setBusy(true)
      }
    }
    if (notice.type === 'idle' || notice.type === 'error') {
      const match = conversationsRef.current.find((item) => item.opencodeSessionId === notice.sessionID)
      if (match && generatingConversation.current === match.id) {
        generatingConversation.current = null
        setBusy(false)
      }
      if (notice.type === 'idle') {
        void window.api.opencodeDiff(notice.sessionID).then(
          (files) => setOcDiffs((prev) => ({ ...prev, [notice.sessionID]: files })),
          () => undefined
        )
      }
    }
    setConversations((prev) =>
      prev.map((conversation) => {
        if (!notice.sessionID || conversation.opencodeSessionId !== notice.sessionID) return conversation
        const messages = [...conversation.messages]
        if (notice.type === 'text-delta') {
          const last = messages[messages.length - 1]
          if (last?.kind === 'assistant' && last.streaming) {
            messages[messages.length - 1] = { ...last, content: last.content + notice.delta }
          } else {
            messages.push({ kind: 'assistant', id: crypto.randomUUID(), content: notice.delta, streaming: true })
          }
        } else if (notice.type === 'text-ended') {
          const last = messages[messages.length - 1]
          if (last?.kind === 'assistant' && last.streaming) {
            messages[messages.length - 1] = { ...last, content: notice.text || last.content, streaming: false }
          }
        } else if (notice.type === 'tool' && notice.state === 'start') {
          messages.push({
            kind: 'tool',
            id: notice.callID,
            callId: notice.callID,
            toolName: notice.name,
            serverName: 'OpenCode',
            explanation: notice.name,
            status: 'running'
          })
        } else if (notice.type === 'tool') {
          const index = messages.findIndex((item) => item.kind === 'tool' && item.callId === notice.callID)
          const current = messages[index]
          if (current?.kind === 'tool') {
            messages[index] = {
              ...current,
              status: notice.state === 'ok' ? 'ok' : 'error',
              summary: notice.detail.slice(0, 400)
            }
          }
        } else if (notice.type === 'error') {
          const last = messages[messages.length - 1]
          if (last?.kind === 'assistant' && last.streaming) messages[messages.length - 1] = { ...last, streaming: false }
          messages.push({ kind: 'error', id: crypto.randomUUID(), content: notice.message })
        } else if (notice.type === 'idle') {
          const last = messages[messages.length - 1]
          if (last?.kind === 'assistant' && last.streaming) messages[messages.length - 1] = { ...last, streaming: false }
        }
        return { ...conversation, messages, updatedAt: Date.now() }
      })
    )
  }

  useEffect(() => {
    void window.api.opencodeStatus().then((status) => {
      setOcOnline(status.online)
      setOcStatus(status.message)
    })
    return window.api.onOpenCode(applyOpenCodeNotice)
  }, [])

  useEffect(() => {
    if (tab !== 'opencode') return
    let cancelled = false
    void window.api.opencodeModels().then(
      (result) => {
        if (cancelled) return
        setOcModels(result.models)
        setOcDefaultModel(result.defaultModel)
        setOcPreferredModel((current) => current ?? result.defaultModel)
        if (result.models.length > 0) {
          try {
            localStorage.setItem('osvacode.opencode.ready', '1')
          } catch {
            // a introdução volta na próxima abertura
          }
          setOcIntroDone(true)
        }
      },
      (err: unknown) => {
        if (cancelled) return
        setOcModels([])
        setOcStatus(err instanceof Error ? err.message : String(err))
      }
    )
    return () => {
      cancelled = true
    }
  }, [tab, ocOnline])

  // carrega as conversas do usuário logado (e busca as remotas dele)
  useEffect(() => {
    if (!session) return
    setConversations(loadConversationsFor(session.user.id))
    const storedDesigns = loadDesignsFor(session.user.id)
    designsRef.current = storedDesigns
    setDesigns(storedDesigns)
    setDesignId(null)
    conversationsOwner.current = session.user.id
    setActiveId(null)
    setRemoteChats([])
    if (session.token) void window.api.syncList().then(setRemoteChats)
  }, [session])

  useEffect(() => {
    conversationsRef.current = conversations
    if (conversationsOwner.current) {
      localStorage.setItem(storageKeyFor(conversationsOwner.current), JSON.stringify(conversations))
    }
  }, [conversations])

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  /** Envia a conversa ao Open WebUI e guarda o id remoto. */
  const pushToOwui = useCallback((conversationId: string) => {
    const s = settingsRef.current
    if (!s?.openWebUi?.enabled || !s.openWebUi.apiKey) return
    const conversation = conversationsRef.current.find((c) => c.id === conversationId)
    if (!conversation) return
    const provider = s.providers.find((p) => p.id === s.activeProviderId)
    const messages = conversation.messages
      .filter((m): m is Extract<UiMessage, { kind: 'user' | 'assistant' }> =>
        m.kind === 'user' || m.kind === 'assistant'
      )
      .map((m) => ({ role: m.kind, content: m.content }))
    void window.api
      .syncPush({
        owuiId: conversation.owuiId ?? null,
        title: conversation.title,
        model: provider?.model ?? 'desconhecido',
        messages
      })
      .then((owuiId) => {
        if (!owuiId) return
        setConversations((prev) =>
          prev.map((c) => (c.id === conversationId ? { ...c, owuiId } : c))
        )
        void window.api.syncList().then(setRemoteChats)
      })
  }, [])

  /** Importa uma conversa do Open WebUI para o app. */
  const importRemoteChat = useCallback(async (remote: RemoteChatStub) => {
    const existing = conversationsRef.current.find((c) => c.owuiId === remote.id)
    if (existing) {
      setActiveId(existing.id)
      return
    }
    const pulled = await window.api.syncPull(remote.id)
    const id = crypto.randomUUID()
    setConversations((prev) => [
      {
        id,
        title: pulled.title,
        owuiId: remote.id,
        updatedAt: Date.now(),
        messages: pulled.messages.map((m) => ({
          kind: m.role,
          id: crypto.randomUUID(),
          content: m.content,
          ...(m.role === 'assistant' ? { streaming: false } : {})
        })) as UiMessage[]
      },
      ...prev
    ])
    setActiveId(id)
  }, [])

  const patchConversation = useCallback(
    (conversationId: string, fn: (messages: UiMessage[]) => UiMessage[], touch = true) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? { ...c, messages: fn(c.messages), updatedAt: touch ? Date.now() : c.updatedAt }
            : c
        )
      )
    },
    []
  )

  persistDesignsRef.current = (next) => {
    designsRef.current = next
    setDesigns(next)
    const userId = conversationsOwner.current
    if (!userId) return
    try {
      localStorage.setItem(`osvacode.designs.${userId}`, JSON.stringify(next))
    } catch {
      // o desenho continua nesta sessão
    }
  }

  useEffect(() => {
    const unsubscribe = window.api.onChatEvent(({ requestId, event }) => {
      const simplifyTarget = simplifyTargets.current.get(requestId)
      if (simplifyTarget) {
        patchConversation(
          simplifyTarget.conversationId,
          (messages) =>
            messages.map((m) => {
              if (m.id !== simplifyTarget.messageId || m.kind !== 'assistant') return m
              if (event.type === 'token') {
                return { ...m, simplified: (m.simplified ?? '') + event.text }
              }
              if (event.type === 'done') return { ...m, simplifying: false }
              if (event.type === 'interrupted') return { ...m, simplifying: false }
              if (event.type === 'error') return { ...m, simplifying: false, simplified: undefined }
              return m
            }),
          false
        )
        if (event.type === 'done' || event.type === 'error' || event.type === 'interrupted') {
          simplifyTargets.current.delete(requestId)
        }
        return
      }

      const openDesignId = designTargets.current.get(requestId)
      if (openDesignId) {
        if (event.type === 'token') designText.current += event.text
        if (event.type === 'design-update') {
          designApplied.current = true
          persistDesignsRef.current(
            designsRef.current.map((item) =>
              item.id === event.design.id
                ? {
                    ...item,
                    title: event.design.title || item.title,
                    kind: event.design.kind,
                    frames: event.design.frames,
                    updatedAt: Date.now()
                  }
                : item
            )
          )
          setDesignStatus('Canvas atualizado.')
        }
        if (event.type === 'tool-start' && event.toolName === 'design_canvas') {
          setDesignStatus('Desenhando no canvas…')
        }
        if (event.type === 'error') setDesignStatus(event.message)
        if (event.type === 'done' || event.type === 'error' || event.type === 'interrupted') {
          designTargets.current.delete(requestId)
          const problem = event.type === 'done' ? '' : event.message
          const reply = designReply(designText.current, designApplied.current, problem)
          if (reply) {
            persistDesignsRef.current(
              designsRef.current.map((item) =>
                item.id === openDesignId
                  ? {
                      ...item,
                      notes: [...item.notes, { role: 'assistant' as const, content: reply }].slice(-12),
                      updatedAt: Date.now()
                    }
                  : item
              )
            )
          }
          designText.current = ''
          if (chatRequestId.current === requestId) {
            chatRequestId.current = null
            generatingConversation.current = null
            setBusy(false)
          }
        }
        return
      }

      const conversationId = chatTargets.current.get(requestId)
      if (!conversationId) return

      if (event.type === 'usage') {
        setConversations((prev) =>
          prev.map((conversation) => {
            if (conversation.id !== conversationId) return conversation
            const previous = conversation.usage
            return {
              ...conversation,
              usage: {
                promptTokens: event.usage.promptTokens,
                completionTokens: event.usage.completionTokens,
                totalTokens: event.usage.totalTokens,
                contextTokens: event.usage.contextTokens,
                generatedTokens: (previous?.generatedTokens ?? 0) + event.usage.completionTokens
              }
            }
          })
        )
        return
      }

      if (event.type === 'command-output') {
        setCommandRuns((prev) => {
          const current = prev[conversationId] ?? []
          return {
            ...prev,
            [conversationId]: [
              ...current,
              { command: event.command, output: event.output, ok: event.ok, at: Date.now() }
            ].slice(-20)
          }
        })
        if (conversationId === activeIdRef.current) {
          setWorkbenchOpen(true)
          setWorkbenchTab('terminal')
        }
        return
      }

      if (event.type === 'file-change') {
        setFileChanges((prev) => {
          const current = prev[conversationId] ?? []
          const next = [...current.filter((item) => item.path !== event.change.path), event.change]
          return { ...prev, [conversationId]: next }
        })
        setWorkbenchOpen(true)
        setWorkbenchTab((current) => (current === 'browser' ? current : 'changes'))
        return
      }

      patchConversation(conversationId, (prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        switch (event.type) {
          case 'token':
            if (last?.kind === 'assistant' && last.streaming) {
              next[next.length - 1] = { ...last, content: last.content + event.text }
            } else {
              next.push({
                kind: 'assistant',
                id: crypto.randomUUID(),
                content: event.text,
                streaming: true
              })
            }
            return next
          case 'tool-permission':
            if (last?.kind === 'assistant' && last.streaming) {
              next[next.length - 1] = { ...last, streaming: false }
            }
            next.push({
              kind: 'tool',
              id: crypto.randomUUID(),
              callId: event.callId,
              toolName: event.toolName,
              serverName: event.serverName,
              explanation: event.explanation,
              status: 'awaiting',
              permissionId: event.permissionId
            })
            return next
          case 'tool-start': {
            if (last?.kind === 'assistant' && last.streaming) {
              next[next.length - 1] = { ...last, streaming: false }
            }
            // já existe o cartão do pedido de permissão? então só muda para "executando"
            const existing = next.findIndex(
              (m) => m.kind === 'tool' && m.callId === event.callId
            )
            const card = next[existing]
            if (card?.kind === 'tool') {
              next[existing] = { ...card, status: 'running' }
              return next
            }
            next.push({
              kind: 'tool',
              id: crypto.randomUUID(),
              callId: event.callId,
              toolName: event.toolName,
              serverName: event.serverName,
              explanation: event.explanation,
              status: 'running'
            })
            return next
          }
          case 'tool-end':
            return next.map((m) =>
              m.kind === 'tool' && m.callId === event.callId
                ? {
                    ...m,
                    status: event.denied ? 'denied' : event.ok ? 'ok' : 'error',
                    summary: event.summary
                  }
                : m
            )
          case 'agent-start':
            next.push({
              kind: 'agent',
              id: crypto.randomUUID(),
              agentId: event.agentId,
              name: event.name,
              modelLabel: event.modelLabel,
              role: event.role,
              index: event.index,
              total: event.total,
              status: 'running'
            })
            return next
          case 'agent-end':
            return next.map((m) =>
              m.kind === 'agent' && m.agentId === event.agentId && m.status === 'running'
                ? { ...m, status: event.ok ? 'ok' : 'error', summary: event.summary }
                : m
            )
          case 'done':
            return next.map((m) =>
              m.kind === 'assistant' && m.streaming ? { ...m, streaming: false } : m
            )
          case 'error':
            next.push({ kind: 'error', id: crypto.randomUUID(), content: event.message })
            return next.map((m) =>
              m.kind === 'assistant' && m.streaming ? { ...m, streaming: false } : m
            )
          case 'interrupted':
            // encerra o streaming preservando o texto parcial; a decisão de
            // retomar sozinho ou mostrar o botão é feita no bloco abaixo
            return next.map((m) =>
              m.kind === 'assistant' && m.streaming ? { ...m, streaming: false } : m
            )
          case 'design-update':
            return next
        }
      })

      if (event.type === 'done' || event.type === 'error' || event.type === 'interrupted') {
        chatTargets.current.delete(requestId)
        if (chatRequestId.current === requestId) {
          chatRequestId.current = null
          generatingConversation.current = null
          setBusy(false)
        }
        if (event.type === 'done') {
          if (conversationId !== activeIdRef.current && typeof Notification !== 'undefined') {
            const title = conversationsRef.current.find((item) => item.id === conversationId)?.title
            if (title) {
              try {
                new Notification('OsvaCode', { body: `${title} terminou.` })
              } catch {
                // o sistema pode recusar o aviso; a conversa continua na lista
              }
            }
          }
          autoResumeCount.current = 0 // sucesso: zera as tentativas automáticas
          // adia para o estado da conversa terminar de atualizar antes de enviar
          setTimeout(() => pushToOwui(conversationId), 150)
        }
        if (event.type === 'interrupted') {
          const interruptedMessage = event.message
          const showResumeButton = (): void =>
            patchConversation(
              conversationId,
              (msgs) => [
                ...msgs,
                { kind: 'error', id: crypto.randomUUID(), content: interruptedMessage, resumable: true }
              ],
              false
            )
          if (autoResumeCount.current < MAX_AUTO_CONTINUE) {
            // retoma sozinho após um instante (deixa a rede/modelo voltarem)
            autoResumeCount.current += 1
            setResumingConv(conversationId)
            setTimeout(() => {
              setResumingConv(null)
              // só retoma se o usuário ainda está na mesma conversa; senão deixa o botão
              if (activeIdRef.current === conversationId) retryRef.current()
              else showResumeButton()
            }, AUTO_RESUME_DELAY_MS)
          } else {
            // esgotou as tentativas automáticas: oferece o botão manual
            showResumeButton()
          }
        }
      }
    })
    return unsubscribe
  }, [patchConversation, pushToOwui])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [conversations, activeId])

  // Chat sem conversa aberta: o campo já fica pronto para digitar.
  useEffect(() => {
    if (session && tab === 'chat' && !activeId) composerRef.current?.focus()
  }, [session, tab, activeId])

  const addAttachment = useCallback(async (kind: 'image' | 'file' | 'folder') => {
    setAddOpen(false)
    const picked = await window.api.pickAttachment(kind)
    if (!picked?.length) return
    const next: DraftAttachment[] = []
    for (const item of picked) {
      if (item.kind === 'image') {
        next.push({ ...item, id: crypto.randomUUID(), dataUrl: await shrinkImage(item.dataUrl) })
      } else {
        next.push({ ...item, id: crypto.randomUUID() })
      }
    }
    setAttachments((prev) => [...prev, ...next])
  }, [])

  const send = useCallback(async () => {
    const baseText = input.trim()
    if ((!baseText && attachments.length === 0) || busy) return
    // Sem conversa aberta, o Chat cria uma na hora. DevMode ainda pede pasta.
    if (!active && tab !== 'chat') return
    if (active && conversationKind(active) !== 'chat' && !active.folder) return

    setBusy(true)
    autoResumeCount.current = 0 // nova mensagem: reinicia o ciclo de retomada automática

    let fullText = baseText
    const images: { dataUrl: string }[] = []
    for (const item of attachments) {
      if (item.kind === 'image') {
        images.push({ dataUrl: item.dataUrl })
        fullText += `${fullText ? '\n' : ''}[Imagem anexada: ${item.name}]`
      } else {
        fullText += `${fullText ? '\n\n' : ''}${item.text}`
      }
    }

    const userMessage: UiMessage = {
      kind: 'user',
      id: crypto.randomUUID(),
      content: fullText,
      ...(images.length > 0 ? { images } : {})
    }
    const titleSource = baseText || attachments.map((file) => file.name).join(', ')
    const conversationId = active?.id ?? crypto.randomUUID()
    const priorMessages = active?.messages ?? []
    const folder = active?.folder
    const teamId = active?.teamId

    const nextConversations = (() => {
      const existing = conversationsRef.current.find((c) => c.id === conversationId)
      if (!existing) {
        return [
          {
            id: conversationId,
            title: titleFromContext(titleSource),
            autoTitle: false,
            messages: [userMessage],
            updatedAt: Date.now(),
            kind: 'chat' as const
          },
          ...conversationsRef.current
        ]
      }
      return conversationsRef.current.map((c) => {
        if (c.id !== conversationId) return c
        return {
          ...c,
          title: c.autoTitle ? titleFromContext(titleSource) : c.title,
          autoTitle: c.autoTitle ? false : c.autoTitle,
          messages: [...c.messages, userMessage],
          updatedAt: Date.now()
        }
      })
    })()
    conversationsRef.current = nextConversations
    setConversations(nextConversations)
    if (!active) setActiveId(conversationId)

    setInput('')
    setAttachments([])

    const sent = nextConversations.find((item) => item.id === conversationId)
    if (sent && conversationKind(sent) === 'opencode' && sent.folder) {
      const directory = sent.folder
      const title = sent.title
      generatingConversation.current = conversationId
      void window.api
        .opencodeEnsure({
          sessionID: sent.opencodeSessionId ?? null,
          directory,
          title,
          model: sent.opencodeModel ?? ocPreferredModel ?? ocDefaultModel
        })
        .then(async (ensured) => {
          const stored = conversationsRef.current.map((item) =>
            item.id === conversationId ? { ...item, opencodeSessionId: ensured.sessionID } : item
          )
          conversationsRef.current = stored
          setConversations(stored)
          await window.api.opencodePrompt(ensured.sessionID, fullText)
        })
        .catch((err: unknown) => {
          if (generatingConversation.current === conversationId) {
            generatingConversation.current = null
            setBusy(false)
          }
          const message = err instanceof Error ? err.message : String(err)
          patchConversation(conversationId, (messages) => [
            ...messages,
            { kind: 'error', id: crypto.randomUUID(), content: message }
          ])
        })
      return
    }

    const history = toChatMessages([...priorMessages, userMessage])

    const requestId = crypto.randomUUID()
    chatRequestId.current = requestId
    chatTargets.current.set(requestId, conversationId)
    generatingConversation.current = conversationId
    void window.api.sendChat(requestId, history, { folder, mode, teamId })
  }, [input, busy, active, attachments, mode, tab, patchConversation, ocPreferredModel, ocDefaultModel])

  const toggleRecording = useCallback(() => {
    if (!recognitionRef.current) {
      alert('Seu navegador não suporta reconhecimento de voz.')
      return
    }
    
    if (isRecording) {
      recognitionRef.current.stop()
      setIsRecording(false)
    } else {
      try {
        recognitionRef.current.start()
        setIsRecording(true)
      } catch (err) {
        console.error(err)
      }
    }
  }, [isRecording])

  const stop = useCallback(() => {
    const current = conversationsRef.current.find((item) => item.id === generatingConversation.current)
    if (current && conversationKind(current) === 'opencode' && current.opencodeSessionId) {
      void window.api.opencodeInterrupt(current.opencodeSessionId)
      return
    }
    if (chatRequestId.current) void window.api.abort(chatRequestId.current)
  }, [])

  /** Reenvia a conversa a partir da última mensagem do usuário, descartando erros. */
  const retry = useCallback(() => {
    if (!active || busy) return
    if (conversationKind(active) === 'opencode') return
    if (conversationKind(active) === 'dev' && !active.folder) return
    const kinds = active.messages.map((m) => m.kind)
    const lastUserIdx = kinds.lastIndexOf('user')
    if (lastUserIdx < 0) return

    const trimmed = active.messages.slice(0, lastUserIdx + 1)
    patchConversation(active.id, () => trimmed, false)

    const history = toChatMessages(trimmed)

    setBusy(true)
    const requestId = crypto.randomUUID()
    chatRequestId.current = requestId
    chatTargets.current.set(requestId, active.id)
    generatingConversation.current = active.id
    void window.api.sendChat(requestId, history, { folder: active.folder, mode, teamId: active.teamId })
  }, [active, busy, patchConversation, mode])

  // mantém refs atualizadas para uso dentro do handler de eventos (evita closures velhas)
  useEffect(() => {
    retryRef.current = retry
    activeIdRef.current = activeId
  }, [retry, activeId])

  const respondPermission = useCallback((permissionId: string, decision: Parameters<typeof window.api.respondPermission>[1]) => {
    const conversation = conversationsRef.current.find((item) =>
      item.messages.some((message) => message.kind === 'tool' && message.permissionId === permissionId)
    )
    if (conversation && conversationKind(conversation) === 'opencode' && conversation.opencodeSessionId) {
      const reply = decision === 'allow' ? 'once' : decision === 'allow-always' ? 'always' : 'reject'
      const sessionID = conversation.opencodeSessionId
      void window.api.opencodePermission(sessionID, permissionId, reply).then(() => {
        setOcPerms((prev) => ({
          ...prev,
          [sessionID]: (prev[sessionID] ?? []).filter((item) => item.id !== permissionId)
        }))
        patchConversation(conversation.id, (messages) =>
          messages.map((message) =>
            message.kind === 'tool' && message.permissionId === permissionId
              ? { ...message, status: decision === 'deny' ? 'denied' : 'ok' }
              : message
          )
        )
      })
      return
    }
    void window.api.respondPermission(permissionId, decision)
  }, [patchConversation])

  const simplify = useCallback(
    (messageId: string, content: string) => {
      if (!activeId) return
      const requestId = crypto.randomUUID()
      simplifyTargets.current.set(requestId, { conversationId: activeId, messageId })
      patchConversation(
        activeId,
        (messages) =>
          messages.map((m) =>
            m.id === messageId && m.kind === 'assistant'
              ? { ...m, simplified: '', simplifying: true }
              : m
          ),
        false
      )
      void window.api.simplify(requestId, content)
    },
    [activeId, patchConversation]
  )

  const createConversation = useCallback((kind: ConversationKind, folder: string | null) => {
    const id = crypto.randomUUID()
    const model = kind === 'opencode' ? (ocPreferredModel ?? ocDefaultModel) : null
    setConversations((prev) => [
      {
        id,
        title: NEW_CONVERSATION_TITLE,
        autoTitle: true,
        messages: [],
        updatedAt: Date.now(),
        kind,
        ...(folder ? { folder } : {}),
        ...(model ? { opencodeModel: model } : {})
      },
      ...prev
    ])
    setActiveId(id)
  }, [ocPreferredModel, ocDefaultModel])

  // Nova conversa: no DevMode a pasta é o contexto (e o grupo); no Chat cria na hora.
  // O título sai da primeira mensagem, sem pedir um nome.
  const startNewConversation = useCallback(async () => {
    if (tab === 'dev' || tab === 'opencode') {
      const picked = await window.api.pickFolder()
      if (!picked) return
      createConversation(tab, folderKey(picked))
      return
    }
    createConversation('chat', null)
  }, [tab, createConversation])

  // Trocar de aba: deseleciona a conversa (a lista passa a ser a da aba).
  const changeTab = useCallback((next: ConversationKind) => {
    setTab(next)
    setActiveId(null)
  }, [])

  const changeActiveFolder = useCallback(async () => {
    if (!activeId) return
    const folder = await window.api.pickFolder()
    if (!folder) return
    setConversations((prev) =>
      prev.map((c) => (c.id === activeId ? { ...c, folder: folderKey(folder) } : c))
    )
  }, [activeId])

  const setConversationTeam = useCallback(
    (teamId: string | null) => {
      if (!activeId) return
      setConversations((prev) => prev.map((c) => (c.id === activeId ? { ...c, teamId } : c)))
    },
    [activeId]
  )

  const deleteConversation = useCallback(
    (id: string) => {
      const conversation = conversationsRef.current.find((c) => c.id === id)
      if (conversation?.owuiId) {
        const ok = window.confirm(
          `Apagar “${conversation.title}”?\nEla também será apagada no Open WebUI.`
        )
        if (!ok) return
        void window.api.syncDelete(conversation.owuiId).then((deleted) => {
          if (deleted) void window.api.syncList().then(setRemoteChats)
        })
      }
      setConversations((prev) => prev.filter((c) => c.id !== id))
      setFileChanges((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      setArtifacts((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      if (activeId === id) setActiveId(null)
    },
    [activeId]
  )

  const openArtifact = useCallback(
    (artifact: Artifact) => {
      if (!activeId) return
      setArtifacts((prev) => {
        const list = prev[activeId] ?? []
        return { ...prev, [activeId]: [...list.filter((item) => item.id !== artifact.id), artifact] }
      })
      setActiveArtifactId(artifact.id)
      setWorkbenchTab('artifacts')
      setWorkbenchOpen(true)
    },
    [activeId]
  )

  const persistSettings = useCallback(
    (next: AppSettings) => {
      setSettings(next)
      void window.api.saveSettings(next).then(setMcpStatus)
    },
    []
  )

  const createDesign = useCallback((kind: DesignKind) => {
    const label = DESIGN_KINDS.find((item) => item.kind === kind)?.label ?? 'Design'
    const doc: DesignDoc = {
      id: crypto.randomUUID(),
      title: label,
      kind,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      frames: [],
      notes: []
    }
    persistDesignsRef.current([doc, ...designsRef.current])
    setDesignId(doc.id)
    setDesignStatus('')
    setSection('design')
  }, [])

  const askDesign = useCallback(
    (id: string, prompt: string) => {
      if (busy) return
      const design = designsRef.current.find((item) => item.id === id)
      if (!design || !prompt.trim()) return
      const withNote = designsRef.current.map((item) =>
        item.id === id
          ? {
              ...item,
              notes: [...item.notes, { role: 'user' as const, content: prompt.trim() }].slice(-12),
              updatedAt: Date.now()
            }
          : item
      )
      persistDesignsRef.current(withNote)
      const snapshot = JSON.stringify({
        title: design.title,
        kind: design.kind,
        frames: design.frames
      }).slice(0, 12000)
      const history = [
        ...design.notes.slice(-6).map((item) => ({ role: item.role, content: item.content })),
        {
          role: 'user' as const,
          content: design.frames.length
            ? `${prompt.trim()}\n\nEstado atual do canvas:\n${snapshot}`
            : prompt.trim()
        }
      ]
      const requestId = crypto.randomUUID()
      designTargets.current.set(requestId, id)
      designText.current = ''
      designApplied.current = false
      chatRequestId.current = requestId
      setBusy(true)
      setDesignStatus('Pedindo o desenho ao modelo…')
      void window.api.sendChat(requestId, history, {
        folder: design.folder,
        mode: 'propose',
        design: { id: design.id, kind: design.kind, title: design.title }
      })
    },
    [busy]
  )

  const saveAutomations = useCallback(
    (automations: Automation[]) => {
      if (!settings) return
      persistSettings({ ...settings, automations })
    },
    [settings, persistSettings]
  )

  const runAutomation = useCallback(
    async (automation: Automation, scheduleTriggerId?: string, context?: string) => {
      if (busy || automation.enabled === false || !automation.prompt.trim()) return
      let folder: string | null = null
      if (automation.kind === 'dev') {
        if (scheduleTriggerId && !automation.folder) return
        const picked = automation.folder || (await window.api.pickFolder())
        if (!picked) return
        folder = folderKey(picked)
      }
      const id = crypto.randomUUID()
      const text = context ? `${automation.prompt.trim()}\n\n${context}` : automation.prompt.trim()
      const background = Boolean(scheduleTriggerId && !context)
      const userMessage: UiMessage = { kind: 'user', id: crypto.randomUUID(), content: text }
      if (!background) {
        setTab(automation.kind)
        setSection('chats')
      }
      setConversations((prev) => [
        {
          id,
          title: titleFromContext(text),
          autoTitle: false,
          messages: [userMessage],
          updatedAt: Date.now(),
          kind: automation.kind,
          ...(folder ? { folder } : {})
        },
        ...prev
      ])
      if (!background) setActiveId(id)
      setBusy(true)
      const requestId = crypto.randomUUID()
      chatRequestId.current = requestId
      chatTargets.current.set(requestId, id)
      generatingConversation.current = id
      void window.api.sendChat(requestId, [{ role: 'user', content: text }], {
        folder: folder ?? undefined,
        mode,
        providerId: automation.providerId || undefined
      })
      const current = settingsRef.current
      if (current) {
        const automations = (current.automations ?? []).map((item) =>
          item.id === automation.id
            ? {
                ...item,
                runs: [{ at: Date.now(), conversationId: id }, ...(item.runs ?? [])].slice(0, 40),
                triggers: (item.triggers ?? []).map((trigger) =>
                  trigger.id === scheduleTriggerId ? { ...trigger, lastFiredAt: Date.now() } : trigger
                )
              }
            : item
        )
        persistSettings({ ...current, automations })
      }
    },
    [busy, mode, persistSettings]
  )

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (busy) return
      const current = settingsRef.current
      if (!current) return
      const now = Date.now()
      for (const automation of current.automations ?? []) {
        if (automation.enabled === false || !automation.prompt.trim()) continue
        if (automation.kind === 'dev' && !automation.folder) continue
        const trigger = (automation.triggers ?? []).find(
          (item) => item.kind === 'schedule' && scheduleIsDue(item, now)
        )
        if (!trigger) continue
        void runAutomation(automation, trigger.id)
        break
      }
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [busy, runAutomation])

  const pendingHooks = useRef<AutomationHookEvent[]>([])
  const busyRef = useRef(busy)
  busyRef.current = busy

  const drainHooks = useCallback(() => {
    if (busyRef.current) return
    const current = settingsRef.current
    while (pendingHooks.current.length > 0) {
      const event = pendingHooks.current[0]
      const automation = current?.automations?.find((item) => item.id === event.automationId)
      pendingHooks.current.shift()
      if (!automation || automation.enabled === false || !automation.prompt.trim()) continue
      if (automation.kind === 'dev' && !automation.folder) continue
      const label = HOOK_SOURCES.find((item) => item.source === event.source)?.label ?? event.source
      void runAutomation(automation, event.triggerId, `--- Evento ${label} ---\n${event.summary}`)
      return
    }
  }, [runAutomation])

  useEffect(() => {
    return window.api.onAutomationHook((event) => {
      pendingHooks.current = [...pendingHooks.current, event].slice(-8)
      drainHooks()
    })
  }, [drainHooks])

  useEffect(() => {
    if (!busy) drainHooks()
  }, [busy, drainHooks])

  const chooseOpenCodeModel = useCallback(
    (value: string) => {
      const model = ocModels.find((item) => openCodeModelKey(item) === value)
      if (!model) return
      setOcPreferredModel(model)
      if (!active || conversationKind(active) !== 'opencode') return
      setConversations((prev) =>
        prev.map((item) => (item.id === active.id ? { ...item, opencodeModel: model } : item))
      )
      if (!active.opencodeSessionId) return
      void window.api.opencodeUseModel(active.opencodeSessionId, model).catch((err: unknown) => {
        setOcStatus(err instanceof Error ? err.message : String(err))
      })
    },
    [ocModels, active]
  )

  const changeProvider = useCallback(
    (providerId: string) => {
      if (!settings) return
      const next = { ...settings, activeProviderId: providerId }
      setSettings(next)
      void window.api.saveSettings(next).then(setMcpStatus)
    },
    [settings]
  )

  const activeProvider = settings?.providers.find((p) => p.id === settings.activeProviderId)
  const openCodeModel =
    (activeKind === 'opencode' ? active?.opencodeModel : null) ??
    (tab === 'opencode' ? (ocPreferredModel ?? ocDefaultModel) : null)
  const openCodeModelOptions =
    openCodeModel && !ocModels.some((item) => openCodeModelKey(item) === openCodeModelKey(openCodeModel))
      ? [openCodeModel, ...ocModels]
      : ocModels
  const activeTeam = settings?.teams?.find((t) => t.id === active?.teamId) ?? null
  const messages = active?.messages ?? []

  if (session === undefined) {
    return <div className="login-screen">Carregando…</div>
  }

  if (session === null) {
    return (
      <LoginScreen
        serverUrl={settings?.openWebUi?.url ?? ''}
        onLoggedIn={(s) => setSession(s)}
      />
    )
  }

  return (
    <div className="app">
      {settings && (
        <Sidebar
          user={session.user}
          onLogout={() => {
            void window.api.logout().then(() => {
              conversationsOwner.current = null
              setConversations([])
              setActiveId(null)
              setSession(null)
            })
          }}
          settings={settings}
          mcpStatus={mcpStatus}
          conversations={conversations}
          activeId={activeId}
          generatingId={busy ? generatingConversation.current : null}
          tab={tab}
          onTabChange={changeTab}
          remoteChats={remoteChats}
          onImportRemote={(remote) => void importRemoteChat(remote)}
          onSelect={(id) => {
            setActiveId(id)
            setSection('chats')
          }}
          onNew={() => {
            setSection('chats')
            void startNewConversation()
          }}
          onDelete={deleteConversation}
          onChangeProvider={changeProvider}
          onOpenSettings={() => setSettingsOpen(true)}
          section={section}
          onSectionChange={setSection}
        />
      )}

      <main className="main">
        <div className="chat-column">
        {section === 'design' ? (
          <DesignPanel
            designs={designs}
            activeId={designId}
            busy={busy}
            status={designStatus}
            onOpen={(id) => {
              setDesignId(id)
              setDesignStatus('')
            }}
            onCreate={createDesign}
            onDelete={(id) => {
              persistDesignsRef.current(designsRef.current.filter((item) => item.id !== id))
              if (designId === id) setDesignId(null)
            }}
            onRename={(id, title) => {
              persistDesignsRef.current(
                designsRef.current.map((item) => (item.id === id ? { ...item, title, updatedAt: Date.now() } : item))
              )
            }}
            onPatch={(id, frames) => {
              persistDesignsRef.current(
                designsRef.current.map((item) =>
                  item.id === id ? { ...item, frames, updatedAt: Date.now() } : item
                )
              )
            }}
            onAsk={(id, prompt) => askDesign(id, prompt)}
            onPickFolder={(id) => {
              void window.api.pickFolder().then((folder) => {
                if (!folder) return
                persistDesignsRef.current(
                  designsRef.current.map((item) =>
                    item.id === id ? { ...item, folder: folderKey(folder), updatedAt: Date.now() } : item
                  )
                )
              })
            }}
            onStop={stop}
          />
        ) : section === 'automations' && settings ? (
          <AutomationsPanel
            automations={settings.automations ?? []}
            providers={settings.providers}
            activeProviderId={settings.activeProviderId}
            mcpStatus={mcpStatus}
            userName={session.user.name}
            hookPort={hookPort}
            tunnelUrl={tunnelUrl}
            tunnelBusy={tunnelBusy}
            tunnelMessage={tunnelMessage}
            onToggleTunnel={() => {
              if (tunnelBusy) return
              setTunnelBusy(true)
              setTunnelMessage('')
              const task = tunnelUrl
                ? window.api.tunnelStop().then(() => null)
                : window.api.tunnelStart().then((result) => {
                    if (result.error) setTunnelMessage(result.error)
                    return result.url
                  })
              void task.then((url) => setTunnelUrl(url)).finally(() => setTunnelBusy(false))
            }}
            busy={busy}
            onSave={(automation) => {
              const next = {
                ...automation,
                ...(automation.folder ? { folder: folderKey(automation.folder) } : {})
              }
              const list = settings.automations ?? []
              saveAutomations(
                list.some((item) => item.id === next.id)
                  ? list.map((item) => (item.id === next.id ? next : item))
                  : [next, ...list]
              )
            }}
            onDelete={(id) => saveAutomations((settings.automations ?? []).filter((item) => item.id !== id))}
            onRun={(item) => void runAutomation(item)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : active && (
          <div className="chat-header">
            <span className="chat-title">{active.title}</span>
            <div className="chat-header-actions">
              {activeKind !== 'opencode' && (settings?.teams?.length ?? 0) > 0 && (
                <label className="team-select">
                  Equipe
                  <select
                    value={active.teamId ?? ''}
                    onChange={(e) => setConversationTeam(e.target.value || null)}
                  >
                    <option value="">Modelo único</option>
                    {settings?.teams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {activeKind !== 'opencode' && activeTeam && activeTeam.steps.length > 0 && (
                <span className="team-path" title="Ordem dos modelos nesta tarefa">
                  {activeTeam.steps.map((step, index) => {
                    const provider = settings?.providers.find((p) => p.id === step.providerId)
                    return (
                      <span key={step.id} className="team-path-step">
                        {index > 0 && <span className="team-path-arrow">→</span>}
                        {step.name}
                        {provider ? ` · ${provider.model}` : ''}
                      </span>
                    )
                  })}
                </span>
              )}
            {activeKind === 'dev' && active.folder && (
              <button
                className="folder-chip"
                title="Instruções e skills do projeto (.osvacode)"
                onClick={() => setProjectPanelOpen(true)}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <NotebookPen size={14} /> Projeto
                </span>
              </button>
            )}
            {(activeKind === 'dev' || activeKind === 'opencode') && (
              <button
                className="folder-chip"
                title={active.folder ?? 'Definir a pasta em que esta conversa trabalha'}
                onClick={() => void changeActiveFolder()}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <FolderOpen size={14} /> {active.folder ? folderLabel(active.folder) : 'Definir pasta'}
                </span>
              </button>
            )}
            {activeKind !== 'opencode' && (
            <button
              className={`folder-chip ${workbenchOpen ? 'active' : ''}`}
              title="Alterações, artefatos e navegador"
              onClick={() => setWorkbenchOpen((open) => !open)}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <PanelRight size={14} /> Painel
                {(activeId ? fileChanges[activeId]?.length ?? 0 : 0) > 0 && (
                  <span className="panel-count">{fileChanges[activeId!].length}</span>
                )}
              </span>
            </button>
            )}
            </div>
          </div>
        )}
        {section === 'chats' && (
        <>
        <div className="chat" ref={scrollRef}>
          {activeKind === 'opencode' && (
            <OpenCodeSections
              view={ocView}
              onView={setOcView}
              online={ocOnline}
              message={ocStatus}
              diffCount={active?.opencodeSessionId ? (ocDiffs[active.opencodeSessionId]?.length ?? 0) : 0}
              permissionCount={active?.opencodeSessionId ? (ocPerms[active.opencodeSessionId]?.length ?? 0) : 0}
              shellCount={active?.opencodeSessionId ? (ocShell[active.opencodeSessionId]?.length ?? 0) : 0}
            />
          )}
          {activeKind === 'opencode' && ocView !== 'session' ? (
            <OpenCodePane
              view={ocView}
              files={active?.opencodeSessionId ? (ocDiffs[active.opencodeSessionId] ?? []) : []}
              permissions={active?.opencodeSessionId ? (ocPerms[active.opencodeSessionId] ?? []) : []}
              shell={active?.opencodeSessionId ? (ocShell[active.opencodeSessionId] ?? []) : []}
              status={ocStatus}
              onReply={(requestID, decision) => respondPermission(requestID, decision)}
            />
          ) : messages.length === 0 && (
            <div className="empty-state">
              <h1>Olá, {session.user.name.split(' ')[0] || 'você'}</h1>
              {active ? (
                activeKind === 'opencode' ? (
                  <>
                    <p>
                      Pasta <strong>{active.folder ? folderLabel(active.folder) : 'sem pasta'}</strong>.
                      Esta conversa usa o agente do OpenCode
                      {ocOnline ? '' : ', que ainda não respondeu neste computador'}.
                    </p>
                    <p className="hint">
                      Sessão, alterações, permissões e terminal ficam nas seções desta conversa.
                      {ocStatus ? ` ${ocStatus}` : ''}
                    </p>
                  </>
                ) : activeKind === 'dev' ? (
                  <>
                    <p>
                      Pasta <strong>{active.folder ? folderLabel(active.folder) : 'sem pasta'}</strong>{' '}
                      pronta. Converse com <strong>{activeProvider?.name ?? 'seu modelo'}</strong> — ele
                      pode ler e escrever arquivos em <code>{shortPath(active.folder ?? '')}</code>.
                    </p>
                    <p className="hint">
                      As respostas chegam em tempo real. Alterações, artefatos e o navegador ficam no painel à direita.
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      Conversa pronta. Fale com <strong>{activeProvider?.name ?? 'seu modelo'}</strong>.
                      Sem pasta de trabalho nem ferramentas de arquivo. O título passa a ser o assunto
                      da primeira mensagem.
                    </p>
                    <p className="hint">
                      As respostas chegam em tempo real. Artefatos e o navegador ficam no painel à direita.
                    </p>
                  </>
                )
              ) : tab === 'opencode' && !ocIntroDone ? (
                <>
                  <p>Para a lista de modelos aparecer, o OpenCode 2 precisa estar no ar neste computador.</p>
                  <div className="opencode-setup">
                    <ol>
                      <li>
                        Instale o OpenCode 2 e conecte um provedor com <code>/connect</code>. Sem um provedor, a lista
                        fica vazia.
                      </li>
                      <li>
                        Deixe o servidor rodando com <code>opencode serve</code>. O endereço padrão é{' '}
                        <code>http://127.0.0.1:4096</code>.
                      </li>
                      <li>
                        Se subir com <code>opencode pair</code>, a porta muda. Copie a URL que ele mostrar para
                        Configurações → OpenCode.
                      </li>
                      <li>
                        Se você definiu <code>OPENCODE_SERVER_PASSWORD</code>, coloque a mesma senha nessa tela.
                      </li>
                    </ol>
                    <button type="button" onClick={() => setSettingsOpen(true)}>
                      Abrir configurações
                    </button>
                  </div>
                  {ocStatus && <p className="hint">{ocStatus}</p>}
                </>
              ) : tab === 'opencode' ? (
                <>
                  <p>
                    Clique em <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><Plus size={14} /> Nova conversa</strong> e
                    escolha a pasta. O OpenCode conduz o agente, as alterações e o terminal dessa pasta.
                  </p>
                  <p className="hint">
                    O seletor abaixo lista os modelos do servidor. O endereço fica em Configurações → OpenCode.
                  </p>
                </>
              ) : tab === 'chat' ? (
                <>
                  <p>
                    Escreva abaixo para começar. A conversa é criada na hora e o título sai do assunto
                    da primeira mensagem.
                  </p>
                  <p className="hint">
                    Dica: adicione modelos e servidores MCP em <em style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><Settings size={14} /> Configurações</em>.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    Clique em <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><Plus size={14} /> Nova conversa</strong> no menu lateral
                    e escolha a pasta. O modelo ganha ferramentas para ler e editar os arquivos dela.
                  </p>
                  <p className="hint">
                    Dica: adicione modelos e servidores MCP em <em style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><Settings size={14} /> Configurações</em>.
                  </p>
                </>
              )}
            </div>
          )}
          {!(activeKind === 'opencode' && ocView !== 'session') && messages.map((m) => {
            switch (m.kind) {
              case 'tool':
                return <ToolCallCard key={m.id} message={m} onRespond={respondPermission} />
              case 'agent':
                return <AgentCard key={m.id} message={m} />
              case 'error':
                return (
                  <ErrorBubble
                    key={m.id}
                    message={m.content}
                    resumable={m.resumable}
                    canRetry={!busy}
                    onRetry={retry}
                  />
                )
              default:
                return (
                  <MessageView
                    key={m.id}
                    message={m}
                    collapseCode={activeKind === 'dev'}
                    onSimplify={simplify}
                    onOpenArtifact={openArtifact}
                  />
                )
            }
          })}
          {(() => {
            const last = messages[messages.length - 1]
            const waitingModel =
              busy &&
              generatingConversation.current === activeId &&
              (last?.kind === 'user' ||
                (last?.kind === 'tool' && last.status !== 'running' && last.status !== 'awaiting'))
            return waitingModel ? <div className="thinking">Pensando…</div> : null
          })()}
          {resumingConv !== null && resumingConv === activeId && (
            <div className="thinking reconnecting">Conexão caiu — retomando automaticamente…</div>
          )}
        </div>

        <footer className="composer-area">
          {(() => {
            const changes = activeId ? fileChanges[activeId] ?? [] : []
            const additions = changes.reduce((sum, change) => sum + change.additions, 0)
            const deletions = changes.reduce((sum, change) => sum + change.deletions, 0)
            const showChips =
              attachments.length > 0 || changes.length > 0 || (activeKind === 'dev' && !active?.folder)
            if (!showChips) return null
            return (
              <div className="composer-chips">
                {activeKind === 'dev' && !active?.folder && (
                  <button type="button" className="composer-chip warn" onClick={() => void changeActiveFolder()}>
                    <AlertTriangle size={13} /> Definir pasta
                  </button>
                )}
                {changes.length > 0 && (
                  <button
                    type="button"
                    className="composer-chip"
                    onClick={() => {
                      setWorkbenchTab('changes')
                      setWorkbenchOpen(true)
                    }}
                  >
                    Alterações
                    <span className="add">+{additions}</span>
                    <span className="del">-{deletions}</span>
                  </button>
                )}
                {attachments.map((file) => (
                  <span key={file.id} className="composer-chip">
                    {file.kind === 'image' && <img className="composer-chip-thumb" src={file.dataUrl} alt="" />}
                    {file.name}
                    <button
                      type="button"
                      title="Remover anexo"
                      onClick={() => setAttachments((prev) => prev.filter((item) => item.id !== file.id))}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )
          })()}

          <div className="composer">
            {slashOpen && (
              <SlashMenu
                items={slashItems}
                selectedIndex={Math.min(slashIndex, slashItems.length - 1)}
                onHover={setSlashIndex}
                onPick={pickSlashCommand}
              />
            )}
            <div className="composer-add" ref={addRef}>
              <button
                type="button"
                className={`composer-icon-btn ${addOpen ? 'open' : ''}`}
                title="Adicionar"
                onClick={() => setAddOpen((open) => !open)}
                disabled={!composerEnabled || busy}
              >
                <Plus size={16} />
              </button>
              {addOpen && (
                <div className="composer-add-menu" role="menu">
                  <button type="button" onClick={() => void addAttachment('image')}>
                    <Image size={15} /> Imagem
                  </button>
                  <button type="button" onClick={() => void addAttachment('file')}>
                    <FileText size={15} /> Arquivo
                  </button>
                  <button type="button" onClick={() => void addAttachment('folder')}>
                    <Folder size={15} /> Pasta
                  </button>
                </div>
              )}
            </div>

            <textarea
              ref={composerRef}
              value={input}
              disabled={!composerEnabled}
              rows={1}
              placeholder={
                !composerEnabled
                  ? 'Crie uma conversa no menu para começar'
                  : messages.length > 0
                    ? 'Envie uma continuação  ·  / para ações e skills'
                    : 'Envie uma mensagem  ·  / para ações e skills'
              }
              onChange={(e) => {
                setInput(e.target.value)
                setSlashDismissed(false)
              }}
              onKeyDown={(e) => {
                if (slashOpen) {
                  const count = slashItems.length
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setSlashIndex((i) => (i + 1) % count)
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setSlashIndex((i) => (i - 1 + count) % count)
                    return
                  }
                  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                    e.preventDefault()
                    pickSlashCommand(slashItems[Math.min(slashIndex, count - 1)])
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setSlashDismissed(true)
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                } else if (e.key === 'ArrowUp' && input === '') {
                  e.preventDefault()
                  const userMsgs = active?.messages.filter((m) => m.kind === 'user') || []
                  if (userMsgs.length > 0) setInput(userMsgs[userMsgs.length - 1].content)
                }
              }}
            />

            <div className="composer-right">
              {tab === 'opencode' ? (
                <label
                  className="composer-model"
                  title={openCodeModel ? `${openCodeModel.name} · ${openCodeModel.providerID}` : 'Modelo do OpenCode'}
                >
                  <span>{openCodeModel?.name ?? (ocModels.length ? 'Modelo' : 'Sem modelos')}</span>
                  <ChevronDown size={14} />
                  <select
                    value={openCodeModel ? openCodeModelKey(openCodeModel) : ''}
                    onChange={(e) => chooseOpenCodeModel(e.target.value)}
                    disabled={busy || openCodeModelOptions.length === 0}
                  >
                    {openCodeModelOptions.map((model) => (
                      <option key={openCodeModelKey(model)} value={openCodeModelKey(model)}>
                        {model.providerID} · {model.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                settings && settings.providers.length > 0 && (
                <label className="composer-model" title={activeProvider ? `${activeProvider.name} · ${activeProvider.model}` : 'Modelo'}>
                  <span>{activeProvider?.name ?? 'Modelo'}</span>
                  <ChevronDown size={14} />
                  <select
                    value={settings.activeProviderId ?? ''}
                    onChange={(e) => changeProvider(e.target.value)}
                    disabled={busy}
                  >
                    {settings.providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                </label>
                )
              )}

              {busy ? (
                <button type="button" className="composer-icon-btn stop-ready" title="Parar" onClick={stop}>
                  <Square size={12} fill="currentColor" />
                </button>
              ) : (
                <>
                  {(input.trim() || attachments.length > 0) && (
                    <button
                      type="button"
                      className="composer-icon-btn send-ready"
                      title="Enviar"
                      onClick={send}
                      disabled={!composerEnabled}
                    >
                      <ArrowUp size={16} />
                    </button>
                  )}
                  {(!input.trim() && attachments.length === 0) || isRecording ? (
                    <button
                      type="button"
                      className={`composer-icon-btn ${isRecording ? 'recording' : ''}`}
                      title="Gravar áudio"
                      onClick={toggleRecording}
                      disabled={!composerEnabled}
                    >
                      <Mic size={15} />
                    </button>
                  ) : null}
                </>
              )}
            </div>
          </div>

          <div className="composer-meta">
            <div className="composer-meta-left">
              {activeKind === 'dev' && (
                <button
                  type="button"
                  className="composer-meta-btn"
                  title={active?.folder ?? 'Definir a pasta de trabalho'}
                  onClick={() => void changeActiveFolder()}
                >
                  <Folder size={13} />
                  <span>{active?.folder ? folderLabel(active.folder) : 'Definir pasta'}</span>
                  <ChevronDown size={13} />
                </button>
              )}
              {activeKind === 'dev' && (
                <label className="composer-meta-btn">
                  <span>{mode === 'edit' ? 'Editar arquivos' : 'Apenas propor'}</span>
                  <ChevronDown size={13} />
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as 'edit' | 'propose')}
                    disabled={busy}
                  >
                    <option value="edit">Editar arquivos</option>
                    <option value="propose">Apenas propor</option>
                  </select>
                </label>
              )}
              {activeKind !== 'dev' && (
                <span className="composer-meta-quiet">{tab === 'opencode' ? 'OpenCode' : 'Chat'}</span>
              )}
            </div>
            <div className="composer-usage" ref={usageRef}>
              <UsageOrb
                usage={active?.usage}
                open={usageOpen}
                modelName={tab === 'opencode' ? (openCodeModel?.name ?? 'OpenCode') : (activeProvider?.name ?? 'Modelo')}
                modelId={
                  tab === 'opencode'
                    ? openCodeModel
                      ? `${openCodeModel.providerID}/${openCodeModel.id}`
                      : ''
                    : (activeProvider?.model ?? '')
                }
                onToggle={() => setUsageOpen((open) => !open)}
              />
            </div>
          </div>
        </footer>
        </>
        )}
        </div>
        {section === 'chats' && workbenchOpen && activeId && activeKind !== 'opencode' && (
          <Workbench
            changes={fileChanges[activeId] ?? []}
            artifacts={artifacts[activeId] ?? []}
            activeArtifactId={activeArtifactId}
            tab={workbenchTab}
            covered={settingsOpen || projectPanelOpen}
            onTab={setWorkbenchTab}
            onClose={() => setWorkbenchOpen(false)}
            onSelectArtifact={setActiveArtifactId}
            onOpenArtifact={openArtifact}
            onClearChanges={() =>
              setFileChanges((prev) => ({ ...prev, [activeId]: [] }))
            }
            commands={commandRuns[activeId] ?? []}
            onAcceptChange={(path) =>
              setFileChanges((prev) => ({
                ...prev,
                [activeId]: (prev[activeId] ?? []).filter((item) => item.path !== path)
              }))
            }
            onRevertChange={(change) => {
              const folder = active?.folder
              if (!folder || change.previous === undefined) return
              void window.api.revertWorkspace(folder, change.path, change.previous).then((next) => {
                setFileChanges((prev) => ({
                  ...prev,
                  [activeId]: next
                    ? (prev[activeId] ?? []).map((item) => (item.path === change.path ? next : item))
                    : (prev[activeId] ?? []).filter((item) => item.path !== change.path)
                }))
              })
            }}
            onRevertHunk={(change, hunk: ReviewHunk) => {
              const folder = active?.folder
              if (!folder || change.previous === undefined) return
              void window.api
                .revertHunk(folder, change.path, change.previous, {
                  removed: hunk.removed,
                  added: hunk.added,
                  after: hunk.after
                })
                .then((next) => {
                  setFileChanges((prev) => ({
                    ...prev,
                    [activeId]: next
                      ? (prev[activeId] ?? []).map((item) => (item.path === change.path ? next : item))
                      : (prev[activeId] ?? []).filter((item) => item.path !== change.path)
                  }))
                })
            }}
          />
        )}
      </main>

      {settingsOpen && settings && (
        <SettingsModal
          settings={settings}
          mcpStatus={mcpStatus}
          onClose={() => setSettingsOpen(false)}
          onSave={async (next) => {
            setSettings(next)
            const status = await window.api.saveSettings(next)
            setMcpStatus(status)
          }}
        />
      )}

      {projectPanelOpen && active?.folder && (
        <ProjectPanel folder={active.folder} onClose={() => setProjectPanelOpen(false)} />
      )}
    </div>
  )
}
