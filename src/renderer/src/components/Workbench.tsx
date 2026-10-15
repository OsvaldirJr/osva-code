import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  FileDiff,
  Globe,
  RotateCw,
  Square,
  TerminalSquare,
  X
} from 'lucide-react'
import type { BrowserState, DiffLine, FileChange } from '../../../shared/types'
import { artifactFromChange, type Artifact } from '../artifacts'

export type WorkbenchTab = 'changes' | 'artifacts' | 'browser' | 'terminal'

export interface CommandRun {
  command: string
  output: string
  ok: boolean
  at: number
}

export interface ReviewHunk {
  removed: string[]
  added: string[]
  after: string | null
  lines: DiffLine[]
}

export function reviewHunks(lines: DiffLine[]): ReviewHunk[] {
  const hunks: ReviewHunk[] = []
  let current: ReviewHunk | null = null
  const flush = (after: string | null): void => {
    if (!current) return
    current.after = after
    if (current.removed.length > 0 || current.added.length > 0) hunks.push(current)
    current = null
  }
  for (const line of lines) {
    if (line.type === 'ctx' || line.type === 'gap') {
      flush(line.type === 'ctx' ? line.text : null)
      continue
    }
    current ??= { removed: [], added: [], after: null, lines: [] }
    current.lines.push(line)
    if (line.type === 'del') current.removed.push(line.text)
    if (line.type === 'add') current.added.push(line.text)
  }
  flush(null)
  return hunks
}

const EMPTY_BROWSER: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false
}

export function Workbench({
  changes,
  artifacts,
  activeArtifactId,
  tab,
  covered,
  onTab,
  onClose,
  onSelectArtifact,
  onOpenArtifact,
  onClearChanges,
  commands,
  onAcceptChange,
  onRevertChange,
  onRevertHunk
}: {
  changes: FileChange[]
  artifacts: Artifact[]
  activeArtifactId: string | null
  tab: WorkbenchTab
  covered: boolean
  onTab: (tab: WorkbenchTab) => void
  onClose: () => void
  onSelectArtifact: (id: string) => void
  onOpenArtifact: (artifact: Artifact) => void
  onClearChanges: () => void
  commands: CommandRun[]
  onAcceptChange: (path: string) => void
  onRevertChange: (change: FileChange) => void
  onRevertHunk: (change: FileChange, hunk: ReviewHunk) => void
}): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [browser, setBrowser] = useState<BrowserState>(EMPTY_BROWSER)
  const [draftUrl, setDraftUrl] = useState('')
  const [urlFocused, setUrlFocused] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const embedded = typeof window.api?.setBrowserBounds === 'function'

  useEffect(() => {
    if (changes.length === 0) {
      setSelectedPath(null)
      return
    }
    if (!selectedPath || !changes.some((change) => change.path === selectedPath)) {
      setSelectedPath(changes[changes.length - 1].path)
    }
  }, [changes, selectedPath])

  useEffect(() => {
    if (!embedded) return
    void window.api.getBrowserState().then(setBrowser)
    return window.api.onBrowserState(setBrowser)
  }, [embedded])

  useEffect(() => {
    if (!urlFocused) setDraftUrl(browser.url)
  }, [browser.url, urlFocused])

  useEffect(() => {
    const node = viewportRef.current
    if (!embedded || !node || tab !== 'browser' || covered) {
      if (embedded) void window.api.setBrowserBounds(null)
      return
    }
    const report = (): void => {
      const rect = node.getBoundingClientRect()
      void window.api.setBrowserBounds({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(node)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      void window.api.setBrowserBounds(null)
    }
  }, [embedded, tab, covered])

  const selected = changes.find((change) => change.path === selectedPath) ?? null
  const artifact =
    artifacts.find((item) => item.id === activeArtifactId) ?? artifacts[artifacts.length - 1] ?? null

  const go = (url: string): void => {
    if (!embedded) return
    void window.api.navigateBrowser(url).then(setBrowser)
  }

  return (
    <aside className="workbench">
      <div className="workbench-top">
        <div className="workbench-tabs" role="tablist">
          <button
            className={tab === 'changes' ? 'active' : ''}
            onClick={() => onTab('changes')}
          >
            <FileDiff size={14} /> Alterações
            {changes.length > 0 && <span className="panel-count">{changes.length}</span>}
          </button>
          <button
            className={tab === 'artifacts' ? 'active' : ''}
            onClick={() => onTab('artifacts')}
          >
            Artefatos
            {artifacts.length > 0 && <span className="panel-count">{artifacts.length}</span>}
          </button>
          <button className={tab === 'browser' ? 'active' : ''} onClick={() => onTab('browser')}>
            <Globe size={14} /> Navegador
          </button>
          <button className={tab === 'terminal' ? 'active' : ''} onClick={() => onTab('terminal')}>
            <TerminalSquare size={14} /> Terminal
            {commands.length > 0 && <span className="panel-count">{commands.length}</span>}
          </button>
        </div>
        <button className="workbench-close" title="Fechar painel" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      {tab === 'changes' && (
        <div className="workbench-body">
          {changes.length === 0 ? (
            <div className="workbench-empty">
              Quando o modelo criar ou editar arquivos da pasta, as diferenças aparecem aqui.
            </div>
          ) : (
            <>
              <div className="change-toolbar">
                <span>{changes.length === 1 ? '1 arquivo' : `${changes.length} arquivos`}</span>
                <button onClick={onClearChanges}>Limpar</button>
              </div>
              <div className="change-list">
                {changes.map((change) => (
                  <button
                    key={change.path}
                    className={change.path === selected?.path ? 'active' : ''}
                    title={change.path}
                    onClick={() => setSelectedPath(change.path)}
                  >
                    <span className="change-name">{change.path.split('/').pop()}</span>
                    <span className={`change-kind ${change.kind}`}>{kindLabel(change.kind)}</span>
                    <span className="change-stat">
                      <span className="add">+{change.additions}</span>
                      <span className="del">−{change.deletions}</span>
                    </span>
                  </button>
                ))}
              </div>
              {selected && (
                <div className="change-detail">
                  <div className="change-path">
                    <span title={selected.path}>{selected.path}</span>
                    <span className="change-actions">
                      <button onClick={() => onAcceptChange(selected.path)}>Aceitar</button>
                      {selected.previous !== undefined && (
                        <button onClick={() => onRevertChange(selected)}>Desfazer</button>
                      )}
                      {artifactFromChange(selected) && (
                        <button onClick={() => onOpenArtifact(artifactFromChange(selected)!)}>
                          Pré-visualizar
                        </button>
                      )}
                      {embedded && selected.kind !== 'deleted' && (
                        <button
                          onClick={() => {
                            onTab('browser')
                            void window.api.openBrowserFile(selected.path).then(setBrowser)
                          }}
                        >
                          Abrir
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="diff">
                    {selected.lines.length === 0 ? (
                      <div className="diff-line gap">Arquivo vazio</div>
                    ) : (
                      renderDiff(selected, onRevertHunk)
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'terminal' && (
        <div className="workbench-body">
          {commands.length === 0 ? (
            <div className="workbench-empty">
              Quando o modelo rodar um comando na pasta, a saída aparece aqui.
            </div>
          ) : (
            <div className="terminal-log">
              {commands.map((run) => (
                <article key={run.at} className={run.ok ? 'ok' : 'fail'}>
                  <header>$ {run.command}</header>
                  <pre>{run.output}</pre>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'artifacts' && (
        <div className="workbench-body">
          {artifacts.length === 0 || !artifact ? (
            <div className="workbench-empty">
              Abra um bloco de HTML, SVG ou Markdown de uma resposta, ou pré-visualize um arquivo
              alterado.
            </div>
          ) : (
            <>
              {artifacts.length > 1 && (
                <div className="artifact-list">
                  {artifacts.map((item) => (
                    <button
                      key={item.id}
                      className={item.id === artifact.id ? 'active' : ''}
                      onClick={() => onSelectArtifact(item.id)}
                    >
                      {item.title}
                    </button>
                  ))}
                </div>
              )}
              <div className="artifact-frame">
                <div className="artifact-caption">
                  {artifact.title}
                  <span>{artifact.language}</span>
                </div>
                <ArtifactView artifact={artifact} />
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'browser' && (
        <div className="workbench-body browser-body">
          <form
            className="browser-bar"
            onSubmit={(event) => {
              event.preventDefault()
              go(draftUrl)
            }}
          >
            <button
              type="button"
              title="Voltar"
              disabled={!browser.canGoBack}
              onClick={() => void window.api.browserCommand('back').then(setBrowser)}
            >
              <ArrowLeft size={14} />
            </button>
            <button
              type="button"
              title="Avançar"
              disabled={!browser.canGoForward}
              onClick={() => void window.api.browserCommand('forward').then(setBrowser)}
            >
              <ArrowRight size={14} />
            </button>
            <button
              type="button"
              title={browser.loading ? 'Parar' : 'Recarregar'}
              onClick={() =>
                void window.api
                  .browserCommand(browser.loading ? 'stop' : 'reload')
                  .then(setBrowser)
              }
            >
              {browser.loading ? <Square size={12} /> : <RotateCw size={14} />}
            </button>
            <input
              value={draftUrl}
              placeholder="https:// ou um endereço"
              spellCheck={false}
              onFocus={() => setUrlFocused(true)}
              onBlur={() => setUrlFocused(false)}
              onChange={(event) => setDraftUrl(event.target.value)}
            />
            <button type="submit">Ir</button>
            <button
              type="button"
              title="Abrir no navegador do sistema"
              disabled={!browser.url}
              onClick={() => void window.api.openBrowserExternal()}
            >
              <ExternalLink size={14} />
            </button>
          </form>
          <div className="browser-viewport" ref={viewportRef}>
            {!browser.url && (
              <div className="workbench-empty">
                {embedded
                  ? 'Digite um endereço para navegar aqui, sem sair do OsvaCode.'
                  : 'O navegador embutido abre na janela do aplicativo OsvaCode.'}
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}

function ArtifactView({ artifact }: { artifact: Artifact }): JSX.Element {
  if (artifact.kind === 'markdown') {
    return (
      <div className="artifact-markdown markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.content}</ReactMarkdown>
      </div>
    )
  }
  if (artifact.kind === 'html' || artifact.kind === 'svg') {
    return (
      <iframe
        className="artifact-iframe"
        title={artifact.title}
        sandbox="allow-scripts"
        srcDoc={frameDocument(artifact)}
      />
    )
  }
  return <pre className="artifact-code">{artifact.content}</pre>
}

function frameDocument(artifact: Artifact): string {
  if (artifact.kind === 'svg') return artifact.content
  if (/<html[\s>]/i.test(artifact.content)) return artifact.content
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:16px;font-family:sans-serif;color:#1c1c1c}</style></head><body>${artifact.content}</body></html>`
}

function renderDiff(change: FileChange, onRevertHunk: (change: FileChange, hunk: ReviewHunk) => void): JSX.Element {
  const hunks = reviewHunks(change.lines)
  let hunkIndex = 0
  const nodes: JSX.Element[] = []
  for (let index = 0; index < change.lines.length; index++) {
    const line = change.lines[index]
    if ((line.type === 'add' || line.type === 'del') && hunks[hunkIndex] && hunks[hunkIndex].lines[0] === line) {
      const hunk = hunks[hunkIndex]
      hunkIndex++
      nodes.push(
        <div key={`hunk-${index}`} className="diff-hunk">
          {change.previous !== undefined && (
            <button type="button" onClick={() => onRevertHunk(change, hunk)}>
              Recusar trecho
            </button>
          )}
          {hunk.lines.map((item, lineIndex) => (
            <div key={lineIndex} className={`diff-line ${item.type}`}>
              <span className="diff-mark">{item.type === 'add' ? '+' : item.type === 'del' ? '−' : ''}</span>
              <span className="diff-text">{item.text}</span>
            </div>
          ))}
        </div>
      )
      index += hunk.lines.length - 1
      continue
    }
    nodes.push(
      <div key={index} className={`diff-line ${line.type}`}>
        <span className="diff-mark">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''}</span>
        <span className="diff-text">{line.text}</span>
      </div>
    )
  }
  return <>{nodes}</>
}

function kindLabel(kind: FileChange['kind']): string {
  if (kind === 'added') return 'novo'
  if (kind === 'deleted') return 'removido'
  return 'editado'
}
