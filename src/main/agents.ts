import type { AgentTeam, ChatMessage, ProviderConfig, StreamEvent } from '../shared/types'
import { runChat, type PermissionRequest } from './chat'
import type { McpManager } from './mcp'

const HANDOFF_LIMIT = 8000

/**
 * Roda as etapas da equipe em ordem. Cada modelo recebe o que os anteriores
 * produziram. Só a última etapa escreve a resposta visível.
 */
export async function runTeam(options: {
  team: AgentTeam
  providers: ProviderConfig[]
  systemPrompt: string
  history: ChatMessage[]
  mcp: McpManager
  emit: (event: StreamEvent) => void
  requestPermission: (request: PermissionRequest) => Promise<'allow' | 'deny'>
  signal: AbortSignal
  allowFileWrites?: boolean
}): Promise<void> {
  const { team, providers, emit, signal } = options
  const steps = team.steps ?? []
  const handoffs: string[] = []

  for (let i = 0; i < steps.length; i++) {
    if (signal.aborted) return
    const step = steps[i]
    const isLast = i === steps.length - 1
    const provider = providers.find((p) => p.id === step.providerId)
    const modelLabel = provider ? `${provider.name} · ${provider.model}` : 'modelo ausente'

    emit({
      type: 'agent-start',
      agentId: step.id,
      name: step.name.trim() || `Etapa ${i + 1}`,
      modelLabel,
      role: step.role,
      index: i + 1,
      total: steps.length
    })

    if (!provider) {
      emit({
        type: 'agent-end',
        agentId: step.id,
        ok: false,
        summary: 'Esta etapa não tem um modelo válido.'
      })
      emit({
        type: 'error',
        message:
          `A etapa “${step.name || i + 1}” da equipe “${team.name}” aponta para um modelo que não existe mais. ` +
          'Abra Configurações → Equipes e escolha outro modelo.'
      })
      return
    }

    const prior =
      handoffs.length > 0 ? `\n\nRESULTADOS DAS ETAPAS ANTERIORES:\n${handoffs.join('\n\n')}` : ''
    const who = step.name.trim() || `Etapa ${i + 1}`
    const role = step.role.trim() || 'Contribua com a sua parte desta tarefa.'
    const rolePrompt = isLast
      ? `\n\nVocê é “${who}”, a última etapa da equipe “${team.name}”. Seu papel: ${role}. ` +
        'Responda ao usuário incorporando o trabalho das etapas anteriores. ' +
        'Não descreva a mecânica da equipe, a menos que perguntem.' +
        prior
      : `\n\nVocê é “${who}”, etapa ${i + 1} de ${steps.length} da equipe “${team.name}”. ` +
        `Seu papel: ${role}. Não fale com o usuário final. ` +
        'Entregue só o resultado objetivo que a próxima etapa precisa para continuar.' +
        prior

    const result = await runChat({
      provider,
      systemPrompt: options.systemPrompt + rolePrompt,
      history: options.history,
      mcp: options.mcp,
      emit,
      requestPermission: options.requestPermission,
      signal,
      allowFileWrites: options.allowFileWrites,
      emitTokens: isLast,
      emitDone: false
    })

    const text = result.text.trim()
    emit({
      type: 'agent-end',
      agentId: step.id,
      ok: result.ok,
      summary: isLast
        ? result.ok
          ? 'Resposta entregue.'
          : 'Esta etapa parou antes de concluir a resposta.'
        : text || (result.ok ? 'Etapa concluída, sem texto adicional.' : 'A etapa parou antes de entregar um resultado.')
    })

    if (!result.ok || signal.aborted) return
    if (!isLast) {
      handoffs.push(`### ${who} (${modelLabel})\n${text.slice(0, HANDOFF_LIMIT)}`)
    }
  }

  emit({ type: 'done' })
}
