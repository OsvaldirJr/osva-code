import type { OpenCodeFileDiff, OpenCodePermission } from '../../../shared/types'
import type { PermissionDecision } from '../../../shared/types'

export type OpenCodeView = 'session' | 'diff' | 'permissions' | 'terminal'

export interface OpenCodeShellRun {
  callID: string
  command: string
  output: string
  done: boolean
}

export function OpenCodeSections({
  view,
  onView,
  online,
  message,
  diffCount,
  permissionCount,
  shellCount
}: {
  view: OpenCodeView
  onView: (view: OpenCodeView) => void
  online: boolean
  message: string
  diffCount: number
  permissionCount: number
  shellCount: number
}): JSX.Element {
  const item = (id: OpenCodeView, label: string, count: number): JSX.Element => (
    <button type="button" className={view === id ? 'active' : ''} onClick={() => onView(id)}>
      {label}
      {count > 0 && <span className="panel-count">{count}</span>}
    </button>
  )
  return (
    <div className="opencode-sections">
      <span className={online ? 'opencode-dot on' : 'opencode-dot'} title={message || 'OpenCode'} />
      {item('session', 'Sessão', 0)}
      {item('diff', 'Alterações', diffCount)}
      {item('permissions', 'Permissões', permissionCount)}
      {item('terminal', 'Terminal', shellCount)}
    </div>
  )
}

export function OpenCodePane({
  view,
  files,
  permissions,
  shell,
  status,
  onReply
}: {
  view: Exclude<OpenCodeView, 'session'>
  files: OpenCodeFileDiff[]
  permissions: OpenCodePermission[]
  shell: OpenCodeShellRun[]
  status: string
  onReply: (requestID: string, decision: PermissionDecision) => void
}): JSX.Element {
  if (view === 'diff') {
    if (files.length === 0) {
      return <div className="workbench-empty">O OpenCode ainda não mostrou alterações nesta sessão.</div>
    }
    return (
      <div className="opencode-pane">
        {files.map((file) => (
          <article key={file.file}>
            <header>
              <span>{file.file}</span>
              <span>
                {file.status === 'added' ? 'novo' : file.status === 'deleted' ? 'apagado' : 'alterado'} · +{file.additions} −
                {file.deletions}
              </span>
            </header>
            {file.patch ? <pre>{file.patch}</pre> : <p>Sem o texto do diff.</p>}
          </article>
        ))}
      </div>
    )
  }

  if (view === 'permissions') {
    if (permissions.length === 0) {
      return <div className="workbench-empty">Nenhuma permissão pendente do OpenCode.</div>
    }
    return (
      <div className="opencode-pane">
        {permissions.map((request) => (
          <article key={request.id}>
            <header>
              <span>{request.permission}</span>
            </header>
            {request.patterns.length > 0 && <p>{request.patterns.join('\n')}</p>}
            <div className="opencode-permission-actions">
              <button type="button" onClick={() => onReply(request.id, 'allow')}>
                Uma vez
              </button>
              <button type="button" onClick={() => onReply(request.id, 'allow-always')}>
                Sempre
              </button>
              <button type="button" onClick={() => onReply(request.id, 'deny')}>
                Recusar
              </button>
            </div>
          </article>
        ))}
      </div>
    )
  }

  if (shell.length === 0) {
    return (
      <div className="workbench-empty">
        {status || 'Quando o OpenCode rodar um comando, a saída aparece aqui.'}
      </div>
    )
  }
  return (
    <div className="terminal-log">
      {shell.map((run) => (
        <article key={run.callID} className={run.done ? 'ok' : 'fail'}>
          <header>$ {run.command || 'comando'}</header>
          <pre>{run.output || (run.done ? '(sem saída)' : 'rodando…')}</pre>
        </article>
      ))}
    </div>
  )
}
