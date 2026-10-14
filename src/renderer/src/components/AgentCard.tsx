import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { UiMessage } from '../App'

type AgentMessage = Extract<UiMessage, { kind: 'agent' }>

export function AgentCard({ message }: { message: AgentMessage }): JSX.Element {
  const [open, setOpen] = useState(message.status === 'running')
  const statusLabel =
    message.status === 'running' ? 'trabalhando…' : message.status === 'ok' ? 'concluída' : 'parou'
  const showBody = message.status === 'running' || !!message.summary

  return (
    <div className={`agent-card ${message.status}`}>
      <button
        className="tool-card-header"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={open ? 'Recolher a etapa' : 'Ver o que esta etapa entregou'}
      >
        <ChevronRight size={14} className={`caret ${open ? 'open' : ''}`} />
        <span className="agent-index">
          {message.index}/{message.total}
        </span>
        <span className="tool-name">{message.name}</span>
        <span className="tool-server">{message.modelLabel}</span>
        <span className={`tool-status ${message.status === 'error' ? 'error' : message.status === 'ok' ? 'ok' : ''}`}>
          {statusLabel}
        </span>
      </button>
      {open && showBody && (
        <div className="agent-body">
          {message.role && <p className="agent-role">{message.role}</p>}
          {message.summary && <p className="agent-summary">{message.summary}</p>}
          {message.status === 'running' && !message.summary && (
            <p className="agent-summary">Esta etapa está em andamento.</p>
          )}
        </div>
      )}
    </div>
  )
}
