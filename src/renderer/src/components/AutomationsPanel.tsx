import { useEffect, useState } from 'react'
import { ChevronLeft, Plus, Trash2, Play, Plug, Copy } from 'lucide-react'
import type {
  Automation,
  AutomationHookSource,
  AutomationRun,
  AutomationSchedule,
  AutomationTrigger,
  McpServerStatus,
  ProviderConfig
} from '../../../shared/types'
import { automationHookUrl } from '../../../shared/types'
import { folderLabel } from '../App'

export const HOOK_SOURCES: { source: AutomationHookSource; label: string; hint: string }[] = [
  { source: 'github', label: 'GitHub', hint: 'Cole a URL em Webhooks do repositório.' },
  { source: 'slack', label: 'Slack', hint: 'Cole a URL num workflow do Slack.' },
  { source: 'teams', label: 'Microsoft Teams', hint: 'Cole a URL num webhook de saída do Teams.' },
  { source: 'sentry', label: 'Sentry', hint: 'Cole a URL nos webhooks do projeto.' },
  { source: 'linear', label: 'Linear', hint: 'Cole a URL nos webhooks do Linear.' },
  { source: 'webhook', label: 'Webhook', hint: 'Envie um POST para esta URL.' },
  { source: 'pagerduty', label: 'PagerDuty', hint: 'Cole a URL numa extensão de webhook.' }
]

export const SCHEDULES: { schedule: AutomationSchedule; label: string; every: number }[] = [
  { schedule: 'hourly', label: 'A cada hora', every: 60 * 60 * 1000 },
  { schedule: 'daily', label: 'Todo dia', every: 24 * 60 * 60 * 1000 },
  { schedule: 'weekdays', label: 'Dias úteis', every: 24 * 60 * 60 * 1000 },
  { schedule: 'weekly', label: 'Toda semana', every: 7 * 24 * 60 * 60 * 1000 },
  { schedule: 'monthly', label: 'Todo mês', every: 30 * 24 * 60 * 60 * 1000 }
]

/** O gatilho agendado já passou da vez. A primeira vez espera o intervalo desde a criação. */
export function scheduleIsDue(trigger: AutomationTrigger, now: number): boolean {
  if (trigger.kind !== 'schedule' || !trigger.schedule) return false
  const anchor = trigger.lastFiredAt ?? trigger.createdAt ?? 0
  if (trigger.schedule === 'weekdays') {
    const day = new Date(now).getDay()
    if (day === 0 || day === 6) return false
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return anchor < start.getTime()
  }
  const every = SCHEDULES.find((item) => item.schedule === trigger.schedule)?.every
  return !!every && now - anchor >= every
}

function ready(raw: Automation): Automation {
  return {
    ...raw,
    name: raw.name || 'Sem título',
    prompt: raw.prompt || '',
    kind: raw.kind === 'dev' ? 'dev' : 'chat',
    enabled: raw.enabled !== false,
    providerId: raw.providerId ?? null,
    triggers: raw.triggers?.length
      ? raw.triggers
      : [{ id: `${raw.id}-manual`, kind: 'manual', label: 'Quando eu rodar' }],
    runs: raw.runs ?? []
  }
}

function formatWhen(timestamp: number): string {
  return new Date(timestamp).toLocaleString('pt-BR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function Switch({
  on,
  label,
  onToggle
}: {
  on: boolean
  label: string
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={`auto-switch ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
    >
      <span />
    </button>
  )
}

export function AutomationsPanel({
  automations,
  providers,
  activeProviderId,
  mcpStatus,
  userName,
  hookPort,
  tunnelUrl,
  tunnelBusy,
  tunnelMessage,
  onToggleTunnel,
  busy,
  onSave,
  onDelete,
  onRun,
  onOpenSettings
}: {
  automations: Automation[]
  providers: ProviderConfig[]
  activeProviderId: string | null
  mcpStatus: McpServerStatus[]
  userName: string
  hookPort: number
  tunnelUrl: string | null
  tunnelBusy: boolean
  tunnelMessage: string
  onToggleTunnel: () => void
  busy: boolean
  onSave: (automation: Automation) => void
  onDelete: (id: string) => void
  onRun: (automation: Automation) => void
  onOpenSettings: () => void
}): JSX.Element {
  const items = automations.map(ready)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Automation | null>(null)
  const [tab, setTab] = useState<'settings' | 'history'>('settings')
  const [addingTrigger, setAddingTrigger] = useState(false)

  useEffect(() => {
    setTab('settings')
    setAddingTrigger(false)
    if (!editingId) setDraft(null)
  }, [editingId])

  const savedRuns: AutomationRun[] = items.find((item) => item.id === editingId)?.runs ?? []

  const commit = (next: Automation): void => {
    setDraft(next)
    onSave(next)
  }

  const create = (): void => {
    const id = crypto.randomUUID()
    const automation = ready({
      id,
      name: 'Sem título',
      prompt: '',
      kind: 'chat',
      enabled: false,
      providerId: activeProviderId,
      triggers: [{ id: crypto.randomUUID(), kind: 'manual', label: 'Quando eu rodar' }],
      runs: []
    })
    onSave(automation)
    setDraft(automation)
    setEditingId(id)
  }

  if (!draft) {
    return (
      <div className="automations">
        <header className="auto-list-header">
          <div>
            <h1>Automatizações</h1>
            <p>Ligue ou desligue cada uma. Abrir entra na configuração.</p>
          </div>
          <button type="button" className="ghost" onClick={create}>
            <Plus size={15} /> Nova
          </button>
        </header>

        {items.length === 0 ? (
          <p className="automations-empty">Nenhuma automatização ainda.</p>
        ) : (
          <ul className="auto-list">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="auto-list-open"
                  onClick={() => {
                    setDraft(item)
                    setEditingId(item.id)
                  }}
                >
                  <strong>{item.name}</strong>
                  <span>
                    {item.enabled !== false ? 'Ativa' : 'Inativa'}
                    {' · '}
                    {item.folder ? folderLabel(item.folder) : 'Chat'}
                  </span>
                </button>
                <Switch
                  on={item.enabled !== false}
                  label={item.enabled !== false ? 'Desativar' : 'Ativar'}
                  onToggle={() => onSave({ ...item, enabled: item.enabled === false })}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  const provider = providers.find((item) => item.id === (draft.providerId || activeProviderId))
  const hasManual = (draft.triggers ?? []).some((trigger) => trigger.kind === 'manual')
  const hasSchedule = (schedule: AutomationSchedule): boolean =>
    (draft.triggers ?? []).some((trigger) => trigger.schedule === schedule)
  const canRun = draft.enabled !== false && draft.prompt.trim().length > 0 && !busy

  return (
    <div className="automations auto-editor">
      <button
        type="button"
        className="auto-back"
        onClick={() => {
          onSave(draft)
          setEditingId(null)
        }}
      >
        <ChevronLeft size={16} /> Automatizações
      </button>

      <div className="auto-title-row">
        <input
          className="auto-title"
          value={draft.name}
          aria-label="Nome"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          onBlur={() => onSave({ ...draft, name: draft.name.trim() || 'Sem título' })}
        />
        <button
          type="button"
          className="auto-icon"
          title="Apagar"
          onClick={() => {
            onDelete(draft.id)
            setEditingId(null)
          }}
        >
          <Trash2 size={15} />
        </button>
      </div>

      <div className="auto-meta">
        <Switch
          on={draft.enabled !== false}
          label={draft.enabled !== false ? 'Desativar' : 'Ativar'}
          onToggle={() => commit({ ...draft, enabled: draft.enabled === false })}
        />
        <span>{draft.enabled !== false ? 'Ativa' : 'Inativa'}</span>
        <span className="auto-meta-sep" />
        <button
          type="button"
          className="auto-meta-btn"
          onClick={() => {
            void window.api.pickFolder().then((picked) => {
              if (!picked) return
              commit({ ...draft, kind: 'dev', folder: picked })
            })
          }}
        >
          {draft.folder ? folderLabel(draft.folder) : 'Selecionar pasta'}
        </button>
        {draft.folder && (
          <button
            type="button"
            className="auto-meta-btn"
            onClick={() => {
              const next = { ...draft, kind: 'chat' as const }
              delete next.folder
              commit(next)
            }}
          >
            Chat
          </button>
        )}
        <span className="auto-meta-sep" />
        <span>Por {userName}</span>
      </div>

      <div className="auto-tabs">
        <button type="button" className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          Configurações
        </button>
        <button type="button" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          Histórico
        </button>
      </div>

      {tab === 'history' ? (
        <section className="auto-block">
          <h2>Histórico</h2>
          {savedRuns.length === 0 ? (
            <p className="automations-empty">Nenhuma execução ainda.</p>
          ) : (
            <ul className="auto-card">
              {savedRuns.map((run) => (
                <li key={`${run.conversationId}-${run.at}`}>
                  <span>Rodou</span>
                  <time>{formatWhen(run.at)}</time>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <>
          <section className="auto-block">
            <h2>Gatilhos</h2>
            <div className="auto-card">
              {(draft.triggers ?? []).map((trigger) => (
                <div key={trigger.id} className="auto-tool">
                  <div className="auto-trigger-main">
                    {trigger.label}
                    {trigger.kind === 'hook' && trigger.token && (
                      <button
                        type="button"
                        className="auto-hook-url"
                        title={HOOK_SOURCES.find((item) => item.source === trigger.source)?.hint}
                        onClick={() =>
                          void navigator.clipboard.writeText(
                            tunnelUrl
                              ? `${tunnelUrl.replace(/\/$/, '')}/hooks/${trigger.token}`
                              : automationHookUrl(trigger.token!, hookPort)
                          )
                        }
                      >
                        <Copy size={12} />{' '}
                        {tunnelUrl
                          ? `${tunnelUrl.replace(/\/$/, '')}/hooks/${trigger.token}`
                          : automationHookUrl(trigger.token, hookPort)}
                      </button>
                    )}
                  </div>
                  <div className="auto-tool-actions">
                    {trigger.kind === 'manual' && (
                      <button type="button" disabled={!canRun} onClick={() => onRun(draft)}>
                        <Play size={13} /> Rodar
                      </button>
                    )}
                    <button
                      type="button"
                      title="Remover gatilho"
                      onClick={() =>
                        commit({
                          ...draft,
                          triggers: (draft.triggers ?? []).filter((item) => item.id !== trigger.id)
                        })
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
              <div className="auto-add-wrap">
                <button type="button" className="auto-add" onClick={() => setAddingTrigger((open) => !open)}>
                  <Plus size={14} /> Adicionar gatilho
                </button>
                {addingTrigger && (
                  <div className="auto-add-menu">
                    <button
                      type="button"
                      disabled={hasManual}
                      onClick={() => {
                        if (hasManual) return
                        commit({
                          ...draft,
                          triggers: [
                            ...(draft.triggers ?? []),
                            { id: crypto.randomUUID(), kind: 'manual', label: 'Quando eu rodar', createdAt: Date.now() }
                          ]
                        })
                        setAddingTrigger(false)
                      }}
                    >
                      Quando eu rodar
                    </button>
                    <p className="auto-add-label">Agendado</p>
                    {SCHEDULES.map((item) => (
                      <button
                        key={item.schedule}
                        type="button"
                        disabled={hasSchedule(item.schedule)}
                        onClick={() => {
                          if (hasSchedule(item.schedule)) return
                          commit({
                            ...draft,
                            triggers: [
                              ...(draft.triggers ?? []),
                              {
                                id: crypto.randomUUID(),
                                kind: 'schedule',
                                schedule: item.schedule,
                                label: item.label,
                                createdAt: Date.now()
                              }
                            ]
                          })
                          setAddingTrigger(false)
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                    <p className="auto-add-label">Ferramentas</p>
                    {HOOK_SOURCES.map((item) => (
                      <button
                        key={item.source}
                        type="button"
                        onClick={() => {
                          commit({
                            ...draft,
                            triggers: [
                              ...(draft.triggers ?? []),
                              {
                                id: crypto.randomUUID(),
                                kind: 'hook',
                                source: item.source,
                                label: item.label,
                                token: crypto.randomUUID().replace(/-/g, ''),
                                createdAt: Date.now()
                              }
                            ]
                          })
                          setAddingTrigger(false)
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="auto-tunnel">
              <button type="button" disabled={tunnelBusy} onClick={onToggleTunnel}>
                {tunnelBusy ? 'Abrindo túnel…' : tunnelUrl ? 'Encerrar túnel' : 'Abrir túnel público'}
              </button>
              {tunnelUrl && <span className="auto-tunnel-url">{tunnelUrl}</span>}
            </div>
            {tunnelMessage && <p className="auto-hint">{tunnelMessage}</p>}
            <p className="auto-hint">
              O ícone na barra de menus mantém horários e webhooks com a janela fechada. Sem túnel, a URL fica neste
              computador. Com o túnel aberto, a URL copiada chega da internet.
            </p>
          </section>

          <section className="auto-block">
            <h2>Instruções do agente</h2>
            <div className="auto-instructions">
              <textarea
                value={draft.prompt}
                placeholder="Digite o pedido. Use / para comandos."
                onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                onBlur={() => onSave(draft)}
              />
              <label className="auto-model">
                <span>{provider?.name ?? 'Modelo'}</span>
                <select
                  value={draft.providerId || activeProviderId || ''}
                  onChange={(event) => commit({ ...draft, providerId: event.target.value || null })}
                >
                  {providers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <section className="auto-block">
            <h2>Ferramentas</h2>
            <div className="auto-card">
              {mcpStatus.filter((server) => server.connected).map((server) => (
                <div key={server.id} className="auto-tool">
                  <span>
                    <Plug size={14} /> {server.name}
                    <em>{server.tools.length} ferramenta{server.tools.length === 1 ? '' : 's'}</em>
                  </span>
                </div>
              ))}
              <button type="button" className="auto-add" onClick={onOpenSettings}>
                <Plus size={14} /> Adicionar ferramenta ou MCP
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
