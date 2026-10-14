import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  AuthSession,
  ChatMessage,
  FileChange,
  McpServerStatus,
  RemoteChatStub
} from '../../shared/types'
import { AgentCard } from './components/AgentCard'
import { MessageView } from './components/MessageView'
import { ToolCallCard } from './components/ToolCallCard'
import { ErrorBubble } from './components/ErrorBubble'
import { SettingsModal } from './components/SettingsModal'
import { Sidebar } from './components/Sidebar'
import { LoginScreen } from './components/LoginScreen'
import { ProjectPanel } from './components/ProjectPanel'
import { Workbench, type WorkbenchTab } from './components/Workbench'
import type { Artifact } from './artifacts'
import {
  FolderOpen, Plus, Settings, AlertTriangle, Folder, Paperclip, Mic, Square, Send, X, NotebookPen, PanelRight
} from 'lucide-react'

export type UiMessage =
  | { kind: 'user'; id: string; content: string }
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

export type ConversationKind = 'chat' | 'dev'

export interface Conversation {
  id: string
  title: string
  messages: UiMessage[]
  updatedAt: number
  folder?: string
  /** 'chat' = conversa simples (sem pasta); 'dev' = com pasta de trabalho e ferramentas de arquivo. */
  kind?: ConversationKind
  /** Equipe usada nesta conversa. Ausente = só o modelo ativo. */
  teamId?: string | null
  /** id da conversa correspondente no Open WebUI, quando sincronizada */
  owuiId?: string
  /** true até o título ser tirado da primeira mensagem */
  autoTitle?: boolean
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
  const [artifacts, setArtifacts] = useState<Record<string, Artifact[]>>({})
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null)
  // aba ativa do menu: 'chat' (conversa simples) ou 'dev' (com pasta de trabalho)
  const [tab, setTab] = useState<ConversationKind>('chat')
  const [mode, setMode] = useState<'edit' | 'propose'>('edit')
  const [attachments, setAttachments] = useState<File[]>([])
  const [isRecording, setIsRecording] = useState(false)
  
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const recognitionRef = useRef<any>(null)

  const [remoteChats, setRemoteChats] = useState<RemoteChatStub[]>([])

  const chatRequestId = useRef<string | null>(null)
  // requestId do chat -> conversa que está recebendo os tokens
  const chatTargets = useRef(new Map<string, string>())
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

  useEffect(() => {
    void window.api.getSettings().then(setSettings)
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
  }, [])

  // carrega as conversas do usuário logado (e busca as remotas dele)
  useEffect(() => {
    if (!session) return
    setConversations(loadConversationsFor(session.user.id))
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

      const conversationId = chatTargets.current.get(requestId)
      if (!conversationId) return

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
        }
      })

      if (event.type === 'done' || event.type === 'error' || event.type === 'interrupted') {
        chatTargets.current.delete(requestId)
        chatRequestId.current = null
        generatingConversation.current = null
        setBusy(false)
        if (event.type === 'done') {
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

  const send = useCallback(async () => {
    const baseText = input.trim()
    if ((!baseText && attachments.length === 0) || busy) return
    // Sem conversa aberta, o Chat cria uma na hora. DevMode ainda pede pasta.
    if (!active && tab !== 'chat') return
    if (active && conversationKind(active) === 'dev' && !active.folder) return

    setBusy(true)
    autoResumeCount.current = 0 // nova mensagem: reinicia o ciclo de retomada automática

    let fullText = baseText
    if (attachments.length > 0) {
      fullText += '\n\n'
      for (const file of attachments) {
        try {
          const content = await file.text()
          fullText += `--- Arquivo Anexado: ${file.name} ---\n\`\`\`\n${content}\n\`\`\`\n\n`
        } catch (err) {
          console.error('Falha ao ler arquivo', file)
        }
      }
    }

    const userMessage: UiMessage = { kind: 'user', id: crypto.randomUUID(), content: fullText }
    const titleSource = baseText || attachments.map((file) => file.name).join(', ')
    const conversationId = active?.id ?? crypto.randomUUID()
    const priorMessages = active?.messages ?? []
    const folder = active?.folder
    const teamId = active?.teamId

    setConversations((prev) => {
      const existing = prev.find((c) => c.id === conversationId)
      if (!existing) {
        return [
          {
            id: conversationId,
            title: titleFromContext(titleSource),
            autoTitle: false,
            messages: [userMessage],
            updatedAt: Date.now(),
            kind: 'chat'
          },
          ...prev
        ]
      }
      return prev.map((c) => {
        if (c.id !== conversationId) return c
        return {
          ...c,
          title: c.autoTitle ? titleFromContext(titleSource) : c.title,
          autoTitle: c.autoTitle ? false : c.autoTitle,
          messages: [...c.messages, userMessage],
          updatedAt: Date.now()
        }
      })
    })
    if (!active) setActiveId(conversationId)

    const history: ChatMessage[] = [
      ...priorMessages
        .filter((m): m is Extract<UiMessage, { kind: 'user' | 'assistant' }> =>
          m.kind === 'user' || m.kind === 'assistant'
        )
        .map((m) => ({ role: m.kind, content: m.content })),
      { role: 'user' as const, content: fullText }
    ]

    setInput('')
    setAttachments([])

    const requestId = crypto.randomUUID()
    chatRequestId.current = requestId
    chatTargets.current.set(requestId, conversationId)
    generatingConversation.current = conversationId
    void window.api.sendChat(requestId, history, { folder, mode, teamId })
  }, [input, busy, active, attachments, mode, tab])

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
    if (chatRequestId.current) void window.api.abort(chatRequestId.current)
  }, [])

  /** Reenvia a conversa a partir da última mensagem do usuário, descartando erros. */
  const retry = useCallback(() => {
    if (!active || busy) return
    if (conversationKind(active) === 'dev' && !active.folder) return
    const kinds = active.messages.map((m) => m.kind)
    const lastUserIdx = kinds.lastIndexOf('user')
    if (lastUserIdx < 0) return

    const trimmed = active.messages.slice(0, lastUserIdx + 1)
    patchConversation(active.id, () => trimmed, false)

    const history: ChatMessage[] = trimmed
      .filter((m): m is Extract<UiMessage, { kind: 'user' | 'assistant' }> =>
        m.kind === 'user' || m.kind === 'assistant'
      )
      .map((m) => ({ role: m.kind, content: m.content }))

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
    void window.api.respondPermission(permissionId, decision)
  }, [])

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
    setConversations((prev) => [
      {
        id,
        title: NEW_CONVERSATION_TITLE,
        autoTitle: true,
        messages: [],
        updatedAt: Date.now(),
        kind,
        ...(folder ? { folder } : {})
      },
      ...prev
    ])
    setActiveId(id)
  }, [])

  // Nova conversa: no DevMode a pasta é o contexto (e o grupo); no Chat cria na hora.
  // O título sai da primeira mensagem, sem pedir um nome.
  const startNewConversation = useCallback(async () => {
    if (tab === 'dev') {
      const picked = await window.api.pickFolder()
      if (!picked) return
      createConversation('dev', folderKey(picked))
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
          onSelect={setActiveId}
          onNew={() => void startNewConversation()}
          onDelete={deleteConversation}
          onChangeProvider={changeProvider}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      <main className="main">
        <div className="chat-column">
        {active && (
          <div className="chat-header">
            <span className="chat-title">{active.title}</span>
            <div className="chat-header-actions">
              {(settings?.teams?.length ?? 0) > 0 && (
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
              {activeTeam && activeTeam.steps.length > 0 && (
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
            {activeKind === 'dev' && (
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
            </div>
          </div>
        )}
        <div className="chat" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="empty-state">
              <h1>Olá, {session.user.name.split(' ')[0] || 'você'}</h1>
              {active ? (
                activeKind === 'dev' ? (
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
          {messages.map((m) => {
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
          <div className="composer-toolbar">
            {activeKind === 'dev' && (
              active?.folder ? (
                <div className="composer-folder" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Folder size={12} /> {shortPath(active.folder)}
                </div>
              ) : (
                <div className="composer-folder warn" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <AlertTriangle size={12} /> Defina uma pasta de trabalho no cabeçalho para conversar.
                </div>
              )
            )}
          </div>

          {attachments.length > 0 && (
            <div className="attachments-list">
              {attachments.map((f, i) => (
                <span key={i} className="attachment-chip">
                  📄 {f.name}
                  <button onClick={() => setAttachments(prev => prev.filter((_, idx) => idx !== i))}><X size={14} /></button>
                </span>
              ))}
            </div>
          )}

          <div className="composer">
            <input 
              type="file" 
              multiple 
              style={{ display: 'none' }} 
              ref={fileInputRef} 
              onChange={(e) => {
                if (e.target.files) {
                  setAttachments(prev => [...prev, ...Array.from(e.target.files!)])
                }
                e.target.value = ''
              }}
            />
            
            <div className="composer-input-col">
              <textarea
                ref={composerRef}
                value={input}
                disabled={!composerEnabled}
                placeholder={
                  active
                    ? 'Escreva ou dite sua mensagem… (Enter envia)'
                    : tab === 'chat'
                      ? 'Escreva para começar… (Enter cria a conversa e envia)'
                      : 'Crie uma nova conversa no menu lateral para começar'
                }
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  } else if (e.key === 'ArrowUp' && input === '') {
                    e.preventDefault()
                    const userMsgs = active?.messages.filter((m) => m.kind === 'user') || []
                    if (userMsgs.length > 0) {
                      setInput(userMsgs[userMsgs.length - 1].content)
                    }
                  }
                }}
                rows={2}
              />
              {activeKind === 'dev' && (
                <div className="composer-under-input">
                  <select
                    className="mode-select"
                    value={mode}
                    onChange={(e) => setMode(e.target.value as 'edit' | 'propose')}
                    disabled={busy}
                  >
                    <option value="edit">Editar Arquivos</option>
                    <option value="propose">Apenas Propor</option>
                  </select>
                </div>
              )}
            </div>

            <div className="composer-actions-col">
              {busy ? (
                <button className="stop" onClick={stop} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Square size={14} fill="currentColor" /> Parar
                </button>
              ) : (
                <button
                  className="send"
                  onClick={send}
                  disabled={(!input.trim() && attachments.length === 0) || !composerEnabled}
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  Enviar <Send size={14} />
                </button>
              )}

              <div className="composer-media-actions">
                <button
                  className="attach-btn"
                  title="Anexar arquivos de texto"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!composerEnabled || busy}
                >
                  <Paperclip size={18} />
                </button>
                <button
                  className={`mic-btn ${isRecording ? 'recording' : ''}`}
                  title="Gravar áudio"
                  onClick={toggleRecording}
                  disabled={!composerEnabled || busy}
                >
                  <Mic size={18} />
                </button>
              </div>
            </div>
          </div>
        </footer>
        </div>
        {workbenchOpen && activeId && (
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
