import { useState } from 'react'
import { AlertTriangle, ChevronRight, Play, RefreshCw } from 'lucide-react'

/** Primeira frase da mensagem, encurtada, usada como título do erro. */
function errorTitle(message: string): string {
  const firstLine = message.split('\n')[0].trim()
  const firstSentence = firstLine.split('. ')[0].replace(/\.$/, '')
  return firstSentence.length <= 80 ? firstSentence : firstSentence.slice(0, 79) + '…'
}

export function ErrorBubble({
  message,
  canRetry,
  onRetry,
  resumable = false
}: {
  message: string
  canRetry: boolean
  onRetry: () => void
  /** Interrupção retomável (ex.: computador dormiu): mostra "Continuar" em destaque. */
  resumable?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const title = errorTitle(message)
  // só há "mais" a mostrar se o título não for a mensagem inteira
  const hasMore = message.trim() !== title
  // erro comum: o botão de ação (Tentar novamente) fica escondido atrás do ">"
  const retryInDetail = !resumable && canRetry
  const showCaret = hasMore || retryInDetail

  return (
    <div className={`error-bubble ${resumable ? 'resumable' : ''}`}>
      <div className="error-top">
        <button
          className="error-header"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={open ? 'Recolher' : 'Ver detalhes'}
        >
          {showCaret && <ChevronRight size={14} className={`caret ${open ? 'open' : ''}`} />}
          {resumable ? <Play size={15} /> : <AlertTriangle size={15} />}
          <span className="error-title">{title}</span>
        </button>

        {/* interrupção: "Continuar" sempre à mão, sem precisar expandir */}
        {resumable && canRetry && (
          <button className="continue-btn" onClick={onRetry}>
            <Play size={14} /> Continuar
          </button>
        )}
      </div>

      {open && (hasMore || retryInDetail) && (
        <div className="error-detail">
          {hasMore && <span>{message}</span>}
          {retryInDetail && (
            <button
              className="retry-btn"
              onClick={onRetry}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <RefreshCw size={14} /> Tentar novamente
            </button>
          )}
        </div>
      )}
    </div>
  )
}
