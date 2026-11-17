import OpenAI from 'openai'
import type { ChatMessage, ModelFlow, ProviderConfig, StreamEvent } from '../shared/types'
import { runChat, type PermissionRequest } from './chat'
import type { McpManager } from './mcp'

const HANDOFF_LIMIT = 8000

/**
 * Percorre o fluxo a partir da entrada. Uma decisão escolhe a rota;
 * um modelo no fim do caminho escreve a resposta visível.
 */
export async function runFlow(options: {
  flow: ModelFlow
  providers: ProviderConfig[]
  systemPrompt: string
  history: ChatMessage[]
  mcp: McpManager
  emit: (event: StreamEvent) => void
  requestPermission: (request: PermissionRequest) => Promise<'allow' | 'deny'>
  signal: AbortSignal
  allowFileWrites?: boolean
}): Promise<void> {
  const { flow, providers, emit, signal } = options
  const nodes = flow.nodes ?? []
  const edges = flow.edges ?? []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const outgoing = (id: string) => edges.filter((edge) => edge.from === id)
  const entry = nodes.find((node) => node.kind === 'entry')
  if (!entry) {
    emit({ type: 'error', message: `O fluxo “${flow.name}” não tem bloco de entrada.` })
    return
  }
  if (outgoing(entry.id).length !== 1) {
    emit({
      type: 'error',
      message: `No fluxo “${flow.name}”, a entrada precisa de uma única saída.`
    })
    return
  }

  const reachable = new Set<string>()
  const stack = [entry.id]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const edge of outgoing(id)) stack.push(edge.to)
  }

  for (const node of nodes) {
    if (!reachable.has(node.id) || node.kind === 'entry') continue
    const provider = providers.find((item) => item.id === node.providerId)
    if (!provider) {
      emit({
        type: 'error',
        message:
          `O bloco “${node.name || 'sem nome'}” do fluxo “${flow.name}” está sem modelo. ` +
          'Abra Configurações → Fluxos e escolha um modelo nesse bloco.'
      })
      return
    }
    if (node.kind === 'decide') {
      const routes = outgoing(node.id).filter((edge) => edge.when.trim())
      if (routes.length < 2) {
        emit({
          type: 'error',
          message:
            `O bloco “${node.name || 'Decisão'}” precisa de pelo menos duas rotas com condição, ` +
            'por exemplo “código simples” e “código difícil”.'
        })
        return
      }
    }
    if (node.kind === 'model' && outgoing(node.id).length > 1) {
      emit({
        type: 'error',
        message: `O bloco “${node.name || 'Modelo'}” só pode ter uma saída. Para ramificar, use uma decisão.`
      })
      return
    }
  }

  let current = entry
  let handoff = ''
  const seen = new Set<string>()
  const total = Math.max(1, nodes.filter((node) => node.kind !== 'entry' && reachable.has(node.id)).length)
  let index = 0

  for (let guard = 0; guard < 16; guard++) {
    if (signal.aborted) return
    const nextEdges = outgoing(current.id)

    if (current.kind === 'entry') {
      const target = byId.get(nextEdges[0].to)
      if (!target) {
        emit({ type: 'error', message: 'A saída da entrada aponta para um bloco que não existe.' })
        return
      }
      current = target
      continue
    }

    if (seen.has(current.id)) {
      emit({ type: 'error', message: `O fluxo “${flow.name}” entrou em ciclo no bloco “${current.name}”.` })
      return
    }
    seen.add(current.id)
    index += 1

    const who = current.name.trim() || (current.kind === 'decide' ? 'Decisão' : 'Modelo')
    const provider = providers.find((item) => item.id === current.providerId)
    if (!provider) {
      emit({ type: 'error', message: `O bloco “${who}” ficou sem modelo.` })
      return
    }
    const modelLabel = `${provider.name} · ${provider.model}`

    emit({
      type: 'agent-start',
      agentId: current.id,
      name: who,
      modelLabel,
      role: current.instruction,
      index,
      total
    })

    if (current.kind === 'decide') {
      const routes = nextEdges.filter((edge) => edge.when.trim())
      let choice = ''
      try {
        choice = await classify(provider, routes.map((edge) => edge.when.trim()), current.instruction, options.history, handoff, signal)
      } catch (err) {
        if (signal.aborted) {
          emit({ type: 'agent-end', agentId: current.id, ok: false, summary: 'Interrompido.' })
          emit({ type: 'done' })
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        emit({ type: 'agent-end', agentId: current.id, ok: false, summary: message })
        emit({ type: 'error', message })
        return
      }
      if (signal.aborted) return
      const edge = pickEdge(routes, choice)
      if (!edge) {
        const labels = routes.map((item) => `“${item.when.trim()}”`).join(', ')
        const summary = `Não reconheci a rota “${choice.trim() || 'vazia'}”. As rotas são: ${labels}.`
        emit({ type: 'agent-end', agentId: current.id, ok: false, summary })
        emit({ type: 'error', message: summary })
        return
      }
      emit({
        type: 'agent-end',
        agentId: current.id,
        ok: true,
        summary: `Rota: ${edge.when.trim()}`
      })
      const target = byId.get(edge.to)
      if (!target) {
        emit({ type: 'error', message: `A rota “${edge.when.trim()}” aponta para um bloco que não existe.` })
        return
      }
      current = target
      continue
    }

    const isFinal = nextEdges.length === 0
    const role = current.instruction.trim() || 'Cumpra o pedido.'
    const prior = handoff ? `\n\nRESULTADO DA ETAPA ANTERIOR:\n${handoff}` : ''
    const rolePrompt = isFinal
      ? `\n\nVocê é “${who}”, no fluxo “${flow.name}”. Seu papel: ${role}. ` +
        'Responda ao usuário. Não descreva a mecânica do fluxo, a menos que perguntem.' +
        prior
      : `\n\nVocê é “${who}”, uma etapa intermediária do fluxo “${flow.name}”. ` +
        `Seu papel: ${role}. Não fale com o usuário final. ` +
        'Entregue só o resultado objetivo que a próxima etapa precisa.' +
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
      emitTokens: isFinal,
      emitDone: false
    })

    const text = result.text.trim()
    emit({
      type: 'agent-end',
      agentId: current.id,
      ok: result.ok && !signal.aborted,
      summary: isFinal
        ? result.ok
          ? 'Resposta entregue.'
          : 'Esta etapa parou antes de concluir a resposta.'
        : text.slice(0, 280) || (result.ok ? 'Etapa concluída, sem texto adicional.' : 'A etapa parou antes de entregar um resultado.')
    })
    if (!result.ok || signal.aborted) return
    if (isFinal) {
      emit({ type: 'done' })
      return
    }

    const target = byId.get(nextEdges[0].to)
    if (!target) {
      emit({ type: 'error', message: `A saída de “${who}” aponta para um bloco que não existe.` })
      return
    }
    const piece = `### ${who} (${modelLabel})\n${text.slice(0, HANDOFF_LIMIT)}`
    handoff = `${handoff ? `${handoff}\n\n` : ''}${piece}`.slice(-HANDOFF_LIMIT)
    current = target
  }

  emit({ type: 'error', message: `O fluxo “${flow.name}” não chegou a um modelo final.` })
}

async function classify(
  provider: ProviderConfig,
  labels: string[],
  instruction: string,
  history: ChatMessage[],
  handoff: string,
  signal: AbortSignal
): Promise<string> {
  const client = new OpenAI({
    baseURL: provider.baseURL,
    apiKey: provider.apiKey || 'sem-chave'
  })
  const list = labels.map((label) => `- ${label}`).join('\n')
  const transcript = history
    .slice(-6)
    .map((message) => `${message.role === 'assistant' ? 'Assistente' : 'Usuário'}: ${message.content.slice(0, 4000)}`)
    .join('\n\n')
  const guidance = instruction.trim() || 'Escolha a rota que melhor descreve o pedido.'
  const completion = await client.chat.completions.create(
    {
      model: provider.model,
      messages: [
        {
          role: 'system',
          content:
            'Você escolhe uma rota para o próximo modelo. ' +
            `${guidance} Responda somente com o texto exato de uma destas rotas, sem explicação:\n${list}`
        },
        {
          role: 'user',
          content: transcript + (handoff ? `\n\nTrabalho já feito:\n${handoff.slice(0, HANDOFF_LIMIT)}` : '')
        }
      ]
    },
    { signal }
  )
  const message = completion.choices[0]?.message
  const content = message?.content?.trim()
  if (content) return content
  const reasoning = (message as { reasoning?: string; reasoning_content?: string } | undefined)?.reasoning
    ?? (message as { reasoning_content?: string } | undefined)?.reasoning_content
  return typeof reasoning === 'string' ? reasoning.trim() : ''
}

function norm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[."'`]/g, '')
    .replace(/\s+/g, ' ')
}

function pickEdge(
  edges: { when: string; to: string; id: string; from: string }[],
  raw: string
): (typeof edges)[number] | null {
  const text = norm(raw)
  const first = norm((raw.split('\n')[0] ?? '').replace(/^rota\s*:\s*/i, ''))
  let best: { edge: (typeof edges)[number]; score: number } | null = null
  for (const edge of edges) {
    const label = norm(edge.when)
    if (!label) continue
    let score = 0
    if (first === label) score = 100
    else if (first.startsWith(label) || (label.startsWith(first) && first.length > 2)) score = 80
    else if (text.includes(label)) score = 50 + label.length
    if (score > 0 && (!best || score > best.score)) best = { edge, score }
  }
  return best?.edge ?? null
}
