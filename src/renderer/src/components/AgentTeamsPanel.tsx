import type { Dispatch, SetStateAction } from 'react'
import { ArrowDown, ArrowUp, Plus, Sparkles, Trash2, Users } from 'lucide-react'
import type { AgentStep, AgentTeam, AppSettings } from '../../../shared/types'

const STRONG_ROLE =
  'Você é o modelo mais capaz desta equipe. Pegue o que as etapas anteriores produziram, resolva a parte difícil com rigor e devolva um resultado preciso para as etapas seguintes aplicarem.'

function blankStep(providerId: string, name: string, role: string): AgentStep {
  return { id: crypto.randomUUID(), name, role, providerId }
}

function defaultTeam(providerId: string): AgentTeam {
  return {
    id: crypto.randomUUID(),
    name: 'Tarefa pesada',
    steps: [
      blankStep(
        providerId,
        'Planejador',
        'Entenda o pedido e quebre em passos objetivos, sem executar a parte difícil.'
      ),
      blankStep(
        providerId,
        'Executor',
        'Aplique o que as etapas anteriores definiram e responda ao usuário.'
      )
    ]
  }
}

export function AgentTeamsPanel({
  draft,
  setDraft
}: {
  draft: AppSettings
  setDraft: Dispatch<SetStateAction<AppSettings>>
}): JSX.Element {
  const teams = draft.teams ?? []
  const providerId = draft.activeProviderId ?? draft.providers[0]?.id ?? ''

  const updateTeam = (teamId: string, patch: (team: AgentTeam) => AgentTeam): void => {
    setDraft((current) => ({
      ...current,
      teams: (current.teams ?? []).map((team) => (team.id === teamId ? patch(team) : team))
    }))
  }

  const insertStep = (teamId: string, index: number, step: AgentStep): void => {
    updateTeam(teamId, (team) => {
      const steps = [...team.steps]
      steps.splice(index, 0, step)
      return { ...team, steps }
    })
  }

  return (
    <>
      <p className="help">
        Uma equipe passa a tarefa de modelo em modelo. Deixe os mais leves nas pontas e
        insira um modelo moderno no meio, só na parte que precisa de mais recurso.
      </p>
      {draft.providers.length === 0 && (
        <p className="help warn">Cadastre pelo menos um modelo na aba Modelos antes de montar uma equipe.</p>
      )}
      {teams.map((team) => (
        <div className="card team-card" key={team.id}>
          <div className="team-card-head">
            <label>
              Nome da equipe
              <input
                value={team.name}
                onChange={(e) => updateTeam(team.id, (current) => ({ ...current, name: e.target.value }))}
              />
            </label>
            <button
              className="danger"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  teams: (current.teams ?? []).filter((item) => item.id !== team.id)
                }))
              }
            >
              Remover equipe
            </button>
          </div>

          <ol className="team-steps">
            {team.steps.map((step, index) => {
              const provider = draft.providers.find((item) => item.id === step.providerId)
              return (
                <li key={step.id}>
                  <div className="team-step">
                    <div className="team-step-index">{index + 1}</div>
                    <div className="team-step-fields">
                      <div className="card-row">
                        <label>
                          Etapa
                          <input
                            value={step.name}
                            onChange={(e) =>
                              updateTeam(team.id, (current) => ({
                                ...current,
                                steps: current.steps.map((item) =>
                                  item.id === step.id ? { ...item, name: e.target.value } : item
                                )
                              }))
                            }
                          />
                        </label>
                        <label>
                          Modelo
                          <select
                            value={step.providerId}
                            onChange={(e) =>
                              updateTeam(team.id, (current) => ({
                                ...current,
                                steps: current.steps.map((item) =>
                                  item.id === step.id ? { ...item, providerId: e.target.value } : item
                                )
                              }))
                            }
                          >
                            {draft.providers.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name} · {item.model}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <label>
                        O que esta etapa faz
                        <textarea
                          rows={2}
                          value={step.role}
                          onChange={(e) =>
                            updateTeam(team.id, (current) => ({
                              ...current,
                              steps: current.steps.map((item) =>
                                item.id === step.id ? { ...item, role: e.target.value } : item
                              )
                            }))
                          }
                        />
                      </label>
                      <p className="help">
                        {provider
                          ? `Entra aqui: ${provider.name} (${provider.model}).`
                          : 'Escolha um modelo cadastrado.'}
                      </p>
                    </div>
                    <div className="team-step-actions">
                      <button
                        className="ghost icon"
                        title="Subir etapa"
                        disabled={index === 0}
                        onClick={() =>
                          updateTeam(team.id, (current) => {
                            const steps = [...current.steps]
                            ;[steps[index - 1], steps[index]] = [steps[index], steps[index - 1]]
                            return { ...current, steps }
                          })
                        }
                      >
                        <ArrowUp size={16} />
                      </button>
                      <button
                        className="ghost icon"
                        title="Descer etapa"
                        disabled={index === team.steps.length - 1}
                        onClick={() =>
                          updateTeam(team.id, (current) => {
                            const steps = [...current.steps]
                            ;[steps[index + 1], steps[index]] = [steps[index], steps[index + 1]]
                            return { ...current, steps }
                          })
                        }
                      >
                        <ArrowDown size={16} />
                      </button>
                      <button
                        className="ghost icon"
                        title="Remover etapa"
                        onClick={() =>
                          updateTeam(team.id, (current) => ({
                            ...current,
                            steps: current.steps.filter((item) => item.id !== step.id)
                          }))
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                  {index < team.steps.length - 1 && (
                    <button
                      className="team-insert"
                      onClick={() =>
                        insertStep(
                          team.id,
                          index + 1,
                          blankStep(providerId, 'Nova etapa', 'Continue o trabalho da etapa anterior.')
                        )
                      }
                    >
                      <Plus size={14} /> Inserir etapa aqui
                    </button>
                  )}
                </li>
              )
            })}
          </ol>

          <div className="add-row">
            <button
              className="add"
              disabled={!providerId}
              onClick={() =>
                insertStep(
                  team.id,
                  team.steps.length,
                  blankStep(providerId, 'Nova etapa', 'Continue o trabalho da etapa anterior.')
                )
              }
            >
              <Plus size={16} /> Adicionar etapa no fim
            </button>
            <button
              className="add"
              disabled={team.steps.length < 2 || !providerId}
              onClick={() => {
                const edgeId = team.steps[0]?.providerId
                const other = draft.providers.find((item) => item.id !== edgeId)
                insertStep(
                  team.id,
                  Math.max(1, Math.floor(team.steps.length / 2)),
                  blankStep(other?.id ?? providerId, 'Especialista', STRONG_ROLE)
                )
              }}
            >
              <Sparkles size={16} /> Inserir modelo forte no meio
            </button>
          </div>
        </div>
      ))}

      <button
        className="add"
        disabled={!providerId}
        onClick={() =>
          setDraft((current) => ({
            ...current,
            teams: [...(current.teams ?? []), defaultTeam(providerId)]
          }))
        }
      >
        <Users size={16} /> Nova equipe
      </button>
    </>
  )
}
