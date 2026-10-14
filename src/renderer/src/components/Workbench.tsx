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
  X
} from 'lucide-react'
import type { BrowserState, FileChange } from '../../../shared/types'
import { artifactFromChange, type Artifact } from '../artifacts'

export type WorkbenchTab = 'changes' | 'artifacts' | 'browser'

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
  onClearChanges
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
                      selected.lines.map((line, index) => (
                        <div key={index} className={`diff-line ${line.type}`}>
                          <span className="diff-mark">
                            {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''}
                          </span>
                          <span className="diff-text">{line.text}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </>
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

function kindLabel(kind: FileChange['kind']): string {
  if (kind === 'added') return 'novo'
  if (kind === 'deleted') return 'removido'
  return 'editado'
}
