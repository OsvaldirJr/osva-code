import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, Lightbulb } from 'lucide-react'
import type { UiMessage } from '../App'

type ChatBubble = Extract<UiMessage, { kind: 'user' | 'assistant' }>

export function MessageView({
  message,
  onSimplify
}: {
  message: ChatBubble
  onSimplify: (messageId: string, content: string) => void
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

  return (
    <div className="row assistant">
      <div className="bubble assistant-bubble">
        <div className="markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        </div>
        {message.streaming && <span className="cursor">▍</span>}

        {showSimplified && (
          <div className="simplified">
            <div className="simplified-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Lightbulb size={14} /> Em palavras simples
            </div>
            <div className="markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.simplified ?? ''}</ReactMarkdown>
            </div>
            {message.simplifying && <span className="cursor">▍</span>}
          </div>
        )}

        {!message.streaming && !showSimplified && message.content.trim() && (
          <button
            className="simplify-btn"
            onClick={() => onSimplify(message.id, message.content)}
            title="Reescreve esta resposta em linguagem simples, para quem não é técnico"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <Lightbulb size={14} /> Simplificar
          </button>
        )}
      </div>
    </div>
  )
}
