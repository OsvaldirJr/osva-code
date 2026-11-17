import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { CornerDownLeft, FolderOpen, MessageSquare, Play, RotateCw, Square, Trash2 } from 'lucide-react'
import type { TerminalSessionInfo, TerminalTarget } from '../../../shared/types'

const TARGETS: { id: TerminalTarget; label: string }[] = [
  { id: 'shell', label: 'Shell' },
  { id: 'claude', label: 'Claude' },
  { id: 'copilot', label: 'Copilot' }
]

export function terminalSessionId(conversationKey: string, target: TerminalTarget): string {
  return `${conversationKey}:${target}`
}

function shortFolder(path: string): string {
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 2) return path || '~'
  return `…/${parts.slice(-2).join('/')}`
}

export function IntegratedTerminal({
  conversationKey,
  folder,
  target,
  onTargetChange,
  hideInputBar,
  onExitToChat
}: {
  conversationKey: string
  folder?: string | null
  target: TerminalTarget
  onTargetChange: (target: TerminalTarget) => void
  hideInputBar?: boolean
  onExitToChat?: () => void
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const hideInputBarRef = useRef(hideInputBar)
  hideInputBarRef.current = hideInputBar
  const [customCwd, setCustomCwd] = useState<string | null>(null)
  const [sessionsMap, setSessionsMap] = useState<Record<string, TerminalSessionInfo>>({})
  const [lineInput, setLineInput] = useState('')
  const [cmdHistory, setCmdHistory] = useState<string[]>([])
  const [historyCursor, setHistoryCursor] = useState(-1)

  const sessionId = terminalSessionId(conversationKey, target)
  const effectiveCwd = folder || customCwd || null
  const currentSession = sessionsMap[sessionId] ?? null
  const isRunning = Boolean(currentSession?.running)

  const refreshSessions = useCallback(() => {
    void window.api.terminalList().then((list) => {
      const next: Record<string, TerminalSessionInfo> = {}
      for (const item of list) next[item.sessionId] = item
      setSessionsMap(next)
    })
  }, [])

  useEffect(() => {
    refreshSessions()
    return window.api.onTerminalEvent((event) => {
      if (event.type === 'status') {
        setSessionsMap((prev) => ({ ...prev, [event.sessionId]: event.session }))
      } else if (event.type === 'exit') {
        setSessionsMap((prev) => {
          const current = prev[event.sessionId]
          if (!current) return prev
          return { ...prev, [event.sessionId]: { ...current, running: false, exitCode: event.code } }
        })
      }
    })
  }, [refreshSessions])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12.5,
      lineHeight: 1.35,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      scrollback: 5000,
      theme: {
        background: '#090b10',
        foreground: '#eef1f6',
        cursor: '#8b9cff',
        selectionBackground: 'rgba(139, 156, 255, 0.3)',
        black: '#181c26',
        red: '#f07178',
        green: '#3dd68c',
        yellow: '#e8b84a',
        blue: '#8b9cff',
        magenta: '#c792ea',
        cyan: '#89ddff',
        white: '#eef1f6',
        brightBlack: '#6b7280',
        brightRed: '#ff8a90',
        brightGreen: '#63e3a4',
        brightYellow: '#f3d48a',
        brightBlue: '#a9b6ff',
        brightMagenta: '#dfb6ff',
        brightCyan: '#b2ecff',
        brightWhite: '#ffffff'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && term.hasSelection()) {
        const selected = term.getSelection()
        if (selected && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(selected)
        }
        return false
      }
      if (event.metaKey && event.key.toLowerCase() === 'v') {
        if (navigator.clipboard?.readText) {
          void navigator.clipboard.readText().then((clip) => {
            if (clip) void window.api.terminalWrite(sessionId, clip)
          })
        }
        return false
      }
      if (event.shiftKey && event.key === 'Enter') {
        void window.api.terminalWrite(sessionId, '\n')
        return false
      }
      return true
    })

    const fitAndResize = (): void => {
      if (!host.clientWidth || !host.clientHeight) return
      try {
        fit.fit()
        void window.api.terminalResize(sessionId, term.cols, term.rows)
      } catch {
        // container ainda não visível
      }
    }

    fitAndResize()
    if (hideInputBarRef.current) {
      requestAnimationFrame(() => term.focus())
    }
    const observer = new ResizeObserver(fitAndResize)
    observer.observe(host)

    let disposed = false
    let hydrated = false

    const unsubscribe = window.api.onTerminalEvent((event) => {
      if (disposed || event.sessionId !== sessionId || !hydrated) return
      if (event.type === 'data') {
        term.write(event.data)
      } else if (event.type === 'exit') {
        term.write(`\r\n\x1b[90m[processo encerrado · código ${event.code ?? 0}]\x1b[0m\r\n`)
      }
    })

    const dataDispose = term.onData((data) => {
      void window.api.terminalWrite(sessionId, data)
    })

    void window.api.terminalHistory(sessionId).then((res) => {
      if (disposed) return
      if (res.session) {
        setSessionsMap((prev) => ({ ...prev, [sessionId]: res.session! }))
      }
      if (res.buffer) {
        term.write(res.buffer)
      }
      hydrated = true
      if (hideInputBarRef.current) {
        requestAnimationFrame(() => term.focus())
      }
      if (!res.session) {
        void window.api
          .terminalStart({
            sessionId,
            target,
            cwd: effectiveCwd,
            cols: term.cols,
            rows: term.rows
          })
          .then((info) => {
            if (!disposed) setSessionsMap((prev) => ({ ...prev, [sessionId]: info }))
          })
      }
    })

    return () => {
      disposed = true
      observer.disconnect()
      unsubscribe()
      dataDispose.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId, target, effectiveCwd])

  const startOrRestart = (restart: boolean, initialInput?: string): void => {
    const cols = termRef.current?.cols ?? 96
    const rows = termRef.current?.rows ?? 26
    if (restart) termRef.current?.clear()
    void window.api
      .terminalStart({
        sessionId,
        target,
        cwd: effectiveCwd,
        cols,
        rows,
        restart,
        ...(initialInput !== undefined ? { initialInput } : {})
      })
      .then((info) => {
        setSessionsMap((prev) => ({ ...prev, [sessionId]: info }))
        termRef.current?.focus()
      })
  }

  const pickCwd = async (): Promise<void> => {
    const picked = await window.api.pickFolder()
    if (!picked) return
    setCustomCwd(picked)
    const cols = termRef.current?.cols ?? 96
    const rows = termRef.current?.rows ?? 26
    termRef.current?.clear()
    void window.api
      .terminalStart({
        sessionId,
        target,
        cwd: picked,
        cols,
        rows,
        restart: true
      })
      .then((info) => {
        setSessionsMap((prev) => ({ ...prev, [sessionId]: info }))
        termRef.current?.focus()
      })
  }

  const sendLine = (): void => {
    const text = lineInput.trimEnd()
    if (text.trim()) {
      setCmdHistory((prev) => [text, ...prev.filter((item) => item !== text)].slice(0, 40))
    }
    setHistoryCursor(-1)
    setLineInput('')
    if (!isRunning) {
      startOrRestart(false, text)
      return
    }
    void window.api.terminalSendLine(sessionId, text)
  }

  const targetLabel = TARGETS.find((item) => item.id === target)?.label ?? 'Terminal'
  const shownCwd = currentSession?.cwd || effectiveCwd || '~'

  return (
    <div className="integrated-terminal">
      <div className="terminal-toolbar">
        <div className="terminal-targets" role="tablist" aria-label="Modo do terminal">
          {TARGETS.map((item) => {
            const itemSession = sessionsMap[terminalSessionId(conversationKey, item.id)]
            const active = target === item.id
            return (
              <button
                key={item.id}
                type="button"
                className={active ? 'active' : ''}
                onClick={() => onTargetChange(item.id)}
              >
                <span className={`terminal-dot ${itemSession?.running ? 'on' : ''}`} />
                {item.label}
              </button>
            )
          })}
        </div>

        <div className="terminal-actions">
          {!folder && (
            <button
              type="button"
              className="terminal-cwd-btn"
              title={`Pasta: ${shownCwd} (clique para trocar)`}
              onClick={() => void pickCwd()}
            >
              <FolderOpen size={12} />
              <span>{shortFolder(shownCwd)}</span>
            </button>
          )}
          <button
            type="button"
            title="Enviar Ctrl+C para interromper"
            disabled={!isRunning}
            onClick={() => void window.api.terminalWrite(sessionId, '\x03')}
          >
            Ctrl+C
          </button>
          <button
            type="button"
            title="Limpar tela"
            onClick={() => termRef.current?.clear()}
          >
            <Trash2 size={12} />
          </button>
          <button
            type="button"
            title={isRunning ? 'Reiniciar sessão' : 'Iniciar sessão'}
            onClick={() => startOrRestart(isRunning)}
          >
            {isRunning ? <RotateCw size={12} /> : <Play size={12} />}
          </button>
          {isRunning && (
            <button
              type="button"
              className="stop-btn"
              title="Encerrar sessão"
              onClick={() => void window.api.terminalStop(sessionId)}
            >
              <Square size={11} />
            </button>
          )}
          {onExitToChat && (
            <button
              type="button"
              className="terminal-chat-btn"
              title="Voltar para as mensagens do chat"
              onClick={onExitToChat}
            >
              <MessageSquare size={12} />
              <span>Chat</span>
            </button>
          )}
        </div>
      </div>

      <div
        className="terminal-xterm-host"
        ref={hostRef}
        tabIndex={-1}
        onMouseDown={() => {
          requestAnimationFrame(() => termRef.current?.focus())
        }}
        onClick={() => termRef.current?.focus()}
      />

      {!hideInputBar && (
        <form
          className="terminal-input-bar"
          onSubmit={(event) => {
            event.preventDefault()
            sendLine()
          }}
        >
          <span className="terminal-input-prefix" title={`Enviando para ${targetLabel}`}>
            {targetLabel} ›
          </span>
          <input
            value={lineInput}
            spellCheck={false}
            placeholder={
              target === 'claude'
                ? 'Digite um comando ou pedido para o Claude…'
                : target === 'copilot'
                  ? 'Digite um comando ou pedido para o Copilot…'
                  : 'Digite um comando para executar no terminal…'
            }
            onChange={(event) => {
              setLineInput(event.target.value)
              setHistoryCursor(-1)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' && cmdHistory.length > 0) {
                event.preventDefault()
                const next = Math.min(historyCursor + 1, cmdHistory.length - 1)
                setHistoryCursor(next)
                setLineInput(cmdHistory[next] ?? '')
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                if (historyCursor <= 0) {
                  setHistoryCursor(-1)
                  setLineInput('')
                } else {
                  const next = historyCursor - 1
                  setHistoryCursor(next)
                  setLineInput(cmdHistory[next] ?? '')
                }
              }
            }}
          />
          <button type="submit" title="Passar para o terminal (Enter)">
            <CornerDownLeft size={13} />
            <span>Enviar</span>
          </button>
        </form>
      )}
    </div>
  )
}
