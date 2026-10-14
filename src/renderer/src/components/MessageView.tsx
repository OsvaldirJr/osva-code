import { Children, isValidElement, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AppWindow, ChevronRight, Copy, Lightbulb } from 'lucide-react'
import type { UiMessage } from '../App'
import { artifactFromMessage, type Artifact } from '../artifacts'

type ChatBubble = Extract<UiMessage, { kind: 'user' | 'assistant' }>

export function MessageView({
  message,
  collapseCode,
  onSimplify,
  onOpenArtifact
}: {
  message: ChatBubble
  /** No DevMode o código da resposta fica recolhido, como uma alteração. */
  collapseCode?: boolean
  onSimplify: (messageId: string, content: string) => void
  onOpenArtifact: (artifact: Artifact) => void
}): JSX.Element {
  if (message.kind === 'user') {
    return (
      <div className="row user">
        <div className="bubble user-bubble">
          {message.content}
          <button 
            className="copy-user-btn" 
            title="Copiar texto" 
            onClick={() => navigator.clipboard.writeText(message.content)}
          >
            <Copy size={14} />
          </button>
        </div>
      </div>
    )
  }

  const showSimplified = message.simplified !== undefined
  const artifact = artifactFromMessage(message.id, message.content)

  return (
    <div className="row assistant">
      <div className="bubble assistant-bubble">
        <MarkdownText text={message.content} collapseCode={collapseCode} />
        {message.streaming && <span className="cursor">▍</span>}

        {showSimplified && (
          <div className="simplified">
            <div className="simplified-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Lightbulb size={14} /> Em palavras simples
            </div>
            <MarkdownText text={message.simplified ?? ''} collapseCode={collapseCode} />
            {message.simplifying && <span className="cursor">▍</span>}
          </div>
        )}

        {!message.streaming && message.content.trim() && (artifact || !showSimplified) && (
          <div className="message-actions">
            {artifact && (
              <button
                className="simplify-btn"
                onClick={() => onOpenArtifact(artifact)}
                title="Abre este bloco no painel de artefatos"
              >
                <AppWindow size={14} /> Artefato
              </button>
            )}
            {!showSimplified && (
              <button
                className="simplify-btn"
                onClick={() => onSimplify(message.id, message.content)}
                title="Reescreve esta resposta em linguagem simples, para quem não é técnico"
              >
                <Lightbulb size={14} /> Simplificar
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function MarkdownText({ text, collapseCode }: { text: string; collapseCode?: boolean }): JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={collapseCode ? { pre: CollapsedCode } : undefined}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/** Bloco de código vira uma alteração no meio do texto. O código só abre no clique. */
function CollapsedCode({ children }: { children?: ReactNode }): JSX.Element {
  const fence = fenceFromPre(children)
  if (!fence) return <pre>{children}</pre>
  return <InlineChange language={fence.language} code={fence.code} />
}

function InlineChange({ language, code }: { language: string; code: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const lines = code.replace(/\n$/, '').split('\n').length
  return (
    <div className={`inline-change ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="inline-change-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={open ? 'Ocultar o código' : 'Mostrar o código'}
      >
        <ChevronRight size={14} className={`caret ${open ? 'open' : ''}`} />
        <span className="inline-change-kind">alteração</span>
        <span className="inline-change-name">{language}</span>
        <span className="inline-change-stat">+{lines}</span>
      </button>
      {open && (
        <pre>
          <code>{code.replace(/\n$/, '')}</code>
        </pre>
      )}
    </div>
  )
}

function fenceFromPre(children: ReactNode): { language: string; code: string } | null {
  const codeNode = Children.toArray(children).find(
    (node) => isValidElement(node) && node.type === 'code'
  )
  if (!isValidElement(codeNode)) return null
  const props = codeNode.props as { className?: string; children?: ReactNode }
  const code = textOf(props.children).replace(/\n$/, '')
  if (!code.trim()) return null
  const language = props.className?.replace(/^language-/, '').trim() || 'código'
  return { language, code }
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}
