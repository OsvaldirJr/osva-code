import { useEffect, useState } from 'react'
import { ChevronLeft, Copy, Download, Folder, Trash2, ArrowUp, Square } from 'lucide-react'
import type { DesignFrame, DesignKind } from '../../../shared/design'
import { DESIGN_KINDS } from '../../../shared/design'
import { DesignCanvas, downloadFrame, downloadPdf, sampleFrame } from './DesignCanvas'

export interface DesignNote {
  role: 'user' | 'assistant'
  content: string
}

export interface DesignDoc {
  id: string
  title: string
  kind: DesignKind
  createdAt: number
  updatedAt: number
  frames: import('../../../shared/design').DesignFrame[]
  folder?: string
  notes: DesignNote[]
}

const SUGGESTIONS: Record<DesignKind, string[]> = {
  slides: ['Crie 4 slides apresentando o produto', 'Refaça o último slide com mais contraste'],
  screen: ['Desenhe a tela inicial de um app de notas', 'Acrescente uma barra de navegação embaixo'],
  code: ['Desenhe a interface desta pasta', 'Mostre a tela principal do projeto'],
  system: ['Monte uma paleta e os botões do produto', 'Inclua títulos, texto e um cartão'],
  motion: ['Anime três formas atravessando o quadro', 'Deixe o movimento mais lento']
}

function formatWhen(timestamp: number): string {
  return new Date(timestamp).toLocaleString('pt-BR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function DesignPanel({
  designs,
  activeId,
  busy,
  status,
  onOpen,
  onCreate,
  onDelete,
  onRename,
  onPatch,
  onAsk,
  onPickFolder,
  onStop
}: {
  designs: DesignDoc[]
  activeId: string | null
  busy: boolean
  status: string
  onOpen: (id: string | null) => void
  onCreate: (kind: DesignKind) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onPatch: (id: string, frames: DesignFrame[]) => void
  onAsk: (id: string, prompt: string) => void
  onPickFolder: (id: string) => void
  onStop: () => void
}): JSX.Element {
  const active = designs.find((item) => item.id === activeId) ?? null
  const [prompt, setPrompt] = useState('')
  const [frameIndex, setFrameIndex] = useState(0)

  useEffect(() => {
    setFrameIndex(0)
    setPrompt('')
  }, [activeId])

  if (!active) {
    const saved = [...designs].sort((a, b) => b.updatedAt - a.updatedAt)
    return (
      <div className="design">
        <header className="design-home-head">
          <h1>Design</h1>
          <p>O modelo desenha estes itens direto no canvas.</p>
        </header>
        <section className="design-block">
          <h2>Crie algo novo</h2>
          <div className="design-kinds">
            {DESIGN_KINDS.map((item) => (
              <button key={item.kind} type="button" className="design-kind" onClick={() => onCreate(item.kind)}>
                <span className="design-kind-preview">
                  <DesignCanvas frame={sampleFrame(item.kind)} animate={item.kind === 'motion'} />
                </span>
                <span className="design-kind-label">{item.label}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="design-block">
          <h2>Seus designs</h2>
          {saved.length === 0 ? (
            <p className="design-empty">Nenhum design ainda. Escolha um tipo acima para começar.</p>
          ) : (
            <div className="design-grid">
              {saved.map((item) => {
                const frame = item.frames[0]
                const label = DESIGN_KINDS.find((kind) => kind.kind === item.kind)?.label ?? item.kind
                return (
                  <article key={item.id} className="design-card">
                    <button type="button" className="design-card-open" onClick={() => onOpen(item.id)}>
                      <span className="design-card-preview">
                        {frame ? (
                          <DesignCanvas frame={frame} animate={item.kind === 'motion'} />
                        ) : (
                          <DesignCanvas frame={sampleFrame(item.kind)} />
                        )}
                      </span>
                      <span className="design-card-title">{item.title}</span>
                      <span className="design-card-meta">
                        {label} · {formatWhen(item.updatedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ghost icon design-card-delete"
                      title="Apagar design"
                      onClick={() => onDelete(item.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </article>
                )
              })}
            </div>
          )}
        </section>
      </div>
    )
  }

  const frame = active.frames[Math.min(frameIndex, Math.max(active.frames.length - 1, 0))]
  const kindLabel = DESIGN_KINDS.find((item) => item.kind === active.kind)?.label ?? active.kind
  const send = (): void => {
    const text = prompt.trim()
    if (!text || busy) return
    setPrompt('')
    onAsk(active.id, text)
  }

  return (
    <div className="design design-editor">
      <header className="design-editor-head">
        <button type="button" className="ghost icon" title="Voltar" onClick={() => onOpen(null)}>
          <ChevronLeft size={18} />
        </button>
        <input
          className="design-title"
          value={active.title}
          aria-label="Nome do design"
          onChange={(event) => onRename(active.id, event.target.value)}
        />
        <span className="design-kind-pill">{kindLabel}</span>
        <button
          type="button"
          className="ghost"
          disabled={!frame}
          onClick={() => {
            if (!frame) return
            const copy: DesignFrame = {
              ...frame,
              name: `${frame.name} cópia`,
              elements: frame.elements.map((element) => ({ ...element }))
            }
            const next = [...active.frames]
            next.splice(frameIndex + 1, 0, copy)
            onPatch(active.id, next)
            setFrameIndex(frameIndex + 1)
          }}
        >
          <Copy size={14} /> Duplicar
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!frame}
          onClick={() => frame && downloadFrame(frame, active.title)}
        >
          <Download size={14} /> PNG
        </button>
        <button
          type="button"
          className="ghost"
          disabled={active.frames.length === 0}
          onClick={() => downloadPdf(active.frames, active.title)}
        >
          <Download size={14} /> PDF
        </button>
        <button type="button" className="ghost icon" title="Apagar design" onClick={() => onDelete(active.id)}>
          <Trash2 size={16} />
        </button>
      </header>

      <div className="design-stage">
        {frame ? (
          <DesignCanvas
            frame={frame}
            animate={active.kind === 'motion' || frame.elements.some((item) => item.motion)}
            onMove={(index, x, y) => {
              const next = active.frames.map((item, itemIndex) =>
                itemIndex === frameIndex
                  ? {
                      ...item,
                      elements: item.elements.map((element, elementIndex) =>
                        elementIndex === index ? { ...element, x, y } : element
                      )
                    }
                  : item
              )
              onPatch(active.id, next)
            }}
          />
        ) : (
          <p className="design-empty">O canvas está vazio. Peça o desenho abaixo.</p>
        )}
      </div>

      {active.frames.length > 1 && (
        <div className="design-frames">
          {active.frames.map((item, index) => (
            <button
              key={`${item.name}-${index}`}
              type="button"
              className={index === frameIndex ? 'active' : ''}
              onClick={() => setFrameIndex(index)}
            >
              {index + 1}. {item.name}
            </button>
          ))}
        </div>
      )}

      {active.notes.length > 0 && (
        <ul className="design-notes">
          {active.notes.slice(-4).map((note, index) => (
            <li key={`${note.role}-${index}`} className={note.role}>
              {note.content}
            </li>
          ))}
        </ul>
      )}

      <footer className="design-composer">
        <div className="design-suggestions">
          {active.kind === 'code' && (
            <button type="button" onClick={() => onPickFolder(active.id)}>
              <Folder size={13} /> {active.folder ? active.folder.split('/').filter(Boolean).pop() : 'Escolher pasta'}
            </button>
          )}
          {SUGGESTIONS[active.kind].map((suggestion) => (
            <button key={suggestion} type="button" disabled={busy} onClick={() => onAsk(active.id, suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
        <div className="design-prompt">
          <textarea
            rows={2}
            value={prompt}
            placeholder="Descreva o que o modelo deve desenhar no canvas"
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            }}
          />
          {busy ? (
            <button type="button" className="composer-icon-btn stop-ready" title="Parar" onClick={onStop}>
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="composer-icon-btn send-ready" title="Desenhar" disabled={!prompt.trim()} onClick={send}>
              <ArrowUp size={16} />
            </button>
          )}
        </div>
        {status && <p className="design-status">{status}</p>}
      </footer>
    </div>
  )
}
