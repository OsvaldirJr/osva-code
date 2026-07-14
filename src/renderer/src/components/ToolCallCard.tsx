import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { PermissionDecision } from '../../../shared/types'
import type { UiMessage } from '../App'

type ToolMessage = Extract<UiMessage, { kind: 'tool' }>

const STATUS_LABEL: Record<ToolMessage['status'], string> = {
  awaiting: 'aguardando sua permissão',
  running: 'executando…',
  ok: 'concluído',
  error: 'falhou',
  denied: 'negado por você'
}

const STATUS_ICON: Record<ToolMessage['status'], string> = {
  awaiting: '🔐',
  running: '⏳',
  ok: '✅',
  error: '❌',
  denied: '🚫'
}

export function ToolCallCard({
  message,
  onRespond
}: {
  message: ToolMessage
  onRespond: (permissionId: string, decision: PermissionDecision) => void
}): JSX.Element {
  // colapsado por padrão: mostra só o comando. Abre sozinho ao pedir permissão.
  const [open, setOpen] = useState(message.status === 'awaiting')

  const respond = (decision: PermissionDecision): void => {
    if (message.permissionId) onRespond(message.permissionId, decision)
  }

  return (
    <div className={`tool-card ${message.status}`}>
      <button
        className="tool-card-header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? 'Recolher detalhes' : 'Ver o que foi feito'}
      >
        <ChevronRight size={14} className={`caret ${open ? 'open' : ''}`} />
        <span className="tool-icon">{STATUS_ICON[message.status]}</span>
        <span className="tool-name">{message.toolName}</span>
        <span className="tool-server">{message.serverName}</span>
        <span className={`tool-status ${message.status}`}>{STATUS_LABEL[message.status]}</span>
      </button>

      {open && (
        <>
          <p className="tool-explanation">{message.explanation}</p>
          {message.summary && <p className="tool-summary">{message.summary}</p>}
        </>
      )}

      {message.status === 'awaiting' && (
        <div className="permission-actions">
          <button className="perm-allow" onClick={() => respond('allow')}>
            ✔ Permitir
          </button>
          <button className="perm-always" onClick={() => respond('allow-always')}>
            ✔✔ Sempre permitir
          </button>
          <button className="perm-deny" onClick={() => respond('deny')}>
            ✕ Negar
          </button>
        </div>
      )}
    </div>
  )
}
