import OpenAI from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions'
import type { ChatMessage, ProviderConfig, StreamEvent } from '../shared/types'
import type { McpManager } from './mcp'
import { explainToolCall, summarizeToolResult, SIMPLIFY_SYSTEM_PROMPT } from './humanizer'

/**
 * Espera pelo PRIMEIRO pedaço. Modelos podem demorar muito para começar —
 * carregar na memória, processar um prompt grande, "pensar". Máquinas sob
 * pressão de RAM (swap) deixam isso ainda mais lento. Janela generosa de
 * propósito: lentidão no início NÃO é queda de conexão.
 */
const FIRST_CHUNK_TIMEOUT_MS = 300_000
/**
 * Pausa máxima ENTRE pedaços depois que o streaming já começou. Aí um silêncio
 * longo indica conexão morta de verdade (ex.: o computador suspendeu e o socket
 * ficou meio-aberto), e não apenas um modelo lento.
 */
const IDLE_TIMEOUT_MS = 90_000

/**
 * Repassa os pedaços do streaming rearmando um timer a cada um. Usa uma janela
 * maior até o primeiro pedaço e outra, menor, para as pausas seguintes. Se o
 * silêncio estourar, aborta `idle` — o que derruba o fetch e faz o laço parar.
 */
async function* watchIdle<T>(
  stream: AsyncIterable<T>,
  idle: AbortController,
  firstMs: number,
  idleMs: number
): AsyncGenerator<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let started = false
  const arm = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => idle.abort(), started ? idleMs : firstMs)
  }
  try {
    arm()
    for await (const chunk of stream) {
      started = true
      arm()
      yield chunk
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const MAX_TOOL_ROUNDS = 25
/**
 * Falhas seguidas da MESMA ferramenta antes de o app parar de insistir nela.
 * Atingir o limite NÃO aborta a geração: apenas orienta o modelo, com mais
 * firmeza, a mudar de abordagem (outro caminho/ferramenta) ou responder.
 */
const MAX_TOOL_FAILURES = 3

function makeClient(provider: ProviderConfig): OpenAI {
  return new OpenAI({
    baseURL: provider.baseURL,
    // Ollama e afins ignoram a chave, mas o SDK exige um valor.
    apiKey: provider.apiKey || 'sem-chave'
  })
}

function buildTools(mcp: McpManager): ChatCompletionTool[] {
  return mcp.listNamespacedTools().map((entry) => ({
    type: 'function',
    function: {
      name: entry.fullName,
      description: entry.tool.description ?? `Ferramenta ${entry.tool.name} do servidor ${entry.serverName}`,
      parameters: (entry.tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
    }
  }))
}

interface PendingToolCall {
  id: string
  name: string
  args: string
}

/** Extrai objetos JSON com chaves balanceadas de um texto. */
function findJsonObjects(text: string): string[] {
  const results: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') {
        depth--
        if (depth === 0) {
          results.push(text.slice(i, j + 1))
          i = j
          break
        }
      }
    }
  }
  return results
}

/**
 * Modelos pequenos às vezes escrevem a chamada de ferramenta como texto
 * (ex.: {"name": "tool", "arguments": {...}}) em vez de usar o mecanismo
 * nativo. Este fallback detecta esses casos e converte em chamadas reais.
 */
function extractTextualToolCalls(text: string, mcp: McpManager): PendingToolCall[] {
  const calls: PendingToolCall[] = []
  for (const candidate of findJsonObjects(text)) {
    try {
      const obj = JSON.parse(candidate) as {
        name?: unknown
        arguments?: unknown
        parameters?: unknown
      }
      // aceita nome completo (servidor__ferramenta) ou o nome "cru" (ex.: "read_file")
      const entry = typeof obj.name === 'string' ? mcp.resolveTool(obj.name) : undefined
      if (!entry) continue
      const rawArgs = obj.arguments ?? obj.parameters ?? {}
      const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)
      if (!calls.some((c) => c.name === entry.fullName && c.args === args)) {
        calls.push({ id: `textcall_${Date.now()}_${calls.length}`, name: entry.fullName, args })
      }
    } catch {
      // não era JSON válido; ignora
    }
  }
  return calls
}

export interface PermissionRequest {
  callId: string
  fullName: string
  toolName: string
  serverName: string
  explanation: string
}

export async function runChat(options: {
  provider: ProviderConfig
  systemPrompt: string
  history: ChatMessage[]
  mcp: McpManager
  emit: (event: StreamEvent) => void
  requestPermission: (request: PermissionRequest) => Promise<'allow' | 'deny'>
  signal: AbortSignal
}): Promise<void> {
  const { provider, systemPrompt, history, mcp, emit, requestPermission, signal } = options
  const client = makeClient(provider)
  const tools = buildTools(mcp)

  const toolRules =
    tools.length > 0
      ? '\n\nREGRA DE FERRAMENTAS: para usar uma ferramenta, use EXCLUSIVAMENTE o mecanismo nativo de tool calling. ' +
        'NUNCA escreva o JSON da chamada como texto na resposta — isso não executa nada.'
      : ''

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt + toolRules },
    ...history.map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam)
  ]

  // falhas consecutivas por ferramenta ao longo de toda a geração
  const toolFailures = new Map<string, number>()

  // controlador do watchdog da rodada atual: o catch usa para saber se a parada
  // foi um travamento (idle) e não uma parada pedida pelo usuário (signal).
  let idleAbort: AbortController | null = null

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Na última rodada desligamos as ferramentas: o modelo é obrigado a fechar
      // com uma resposta em texto, em vez de a tarefa morrer só com um erro.
      const lastRound = round === MAX_TOOL_ROUNDS - 1
      const useTools = tools.length > 0 && !lastRound

      idleAbort = new AbortController()
      const stream = await client.chat.completions.create(
        {
          model: provider.model,
          messages,
          stream: true,
          ...(useTools ? { tools } : {})
        },
        { signal: AbortSignal.any([signal, idleAbort.signal]) }
      )

      let assistantText = ''
      const toolCalls: PendingToolCall[] = []

      for await (const chunk of watchIdle(stream, idleAbort, FIRST_CHUNK_TIMEOUT_MS, IDLE_TIMEOUT_MS)) {
        const delta = chunk.choices[0]?.delta
        if (!delta) continue
        if (delta.content) {
          assistantText += delta.content
          emit({ type: 'token', text: delta.content })
        }
        for (const tc of delta.tool_calls ?? []) {
          const slot = (toolCalls[tc.index] ??= { id: '', name: '', args: '' })
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name += tc.function.name
          if (tc.function?.arguments) slot.args += tc.function.arguments
        }
      }

      // Sem ferramentas nesta rodada (a última): o texto gerado É a resposta final.
      if (!useTools) {
        emit({ type: 'done' })
        return
      }

      if (toolCalls.length === 0) {
        // fallback: o modelo escreveu a chamada como texto em vez de usar tool calling
        const textual = assistantText ? extractTextualToolCalls(assistantText, mcp) : []
        if (textual.length === 0) {
          emit({ type: 'done' })
          return
        }
        toolCalls.push(...textual)
      }

      messages.push({
        role: 'assistant',
        content: assistantText || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.args }
        }))
      })

      for (const tc of toolCalls) {
        const entry = mcp.lookup(tc.name)
        const toolName = entry?.tool.name ?? tc.name
        const serverName = entry?.serverName ?? 'desconhecido'
        const explanation = explainToolCall(serverName, toolName, entry?.tool.description, tc.args)

        const decision = await requestPermission({
          callId: tc.id,
          fullName: tc.name,
          toolName,
          serverName,
          explanation
        })
        if (signal.aborted) {
          emit({ type: 'done' })
          return
        }

        if (decision === 'deny') {
          emit({
            type: 'tool-end',
            callId: tc.id,
            ok: false,
            denied: true,
            summary: 'Você não autorizou esta ação — sigo sem executá-la.'
          })
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content:
              'O usuário NEGOU a permissão para executar esta ferramenta. ' +
              'Não tente de novo; explique o que faria e pergunte como ele prefere prosseguir.'
          })
          continue
        }

        emit({ type: 'tool-start', callId: tc.id, toolName, serverName, explanation })

        let resultText: string
        let ok = true
        try {
          const args = tc.args ? (JSON.parse(tc.args) as Record<string, unknown>) : {}
          resultText = await mcp.callTool(tc.name, args)
        } catch (err) {
          ok = false
          resultText = err instanceof Error ? err.message : String(err)
        }

        emit({ type: 'tool-end', callId: tc.id, ok, summary: summarizeToolResult(ok, resultText) })

        // Uma falha NÃO aborta a geração: devolvemos o erro ao modelo para que ele
        // se corrija (caminho errado, arquivo inexistente…). Só depois de insistir
        // na MESMA ferramenta damos uma orientação mais firme para mudar de rumo.
        let guidance = ''
        if (ok) {
          toolFailures.delete(tc.name)
        } else {
          const failures = (toolFailures.get(tc.name) ?? 0) + 1
          toolFailures.set(tc.name, failures)
          guidance =
            failures >= MAX_TOOL_FAILURES
              ? `\nATENÇÃO: “${toolName}” já falhou ${failures} vezes seguidas. NÃO a chame de novo ` +
                'com os mesmos argumentos. Liste o diretório para confirmar o caminho/nome exato, ' +
                'use outra ferramenta, ou explique o problema ao usuário e pergunte como prosseguir.'
              : '\nDica: confira os argumentos (use caminho absoluto e o nome exato do arquivo); ' +
                'se não tiver certeza do nome, liste o diretório antes de tentar de novo.'
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: ok ? resultText : `Erro ao executar a ferramenta: ${resultText}${guidance}`
        })
      }
    }

    // Rede de segurança: a última rodada já roda sem ferramentas e retorna com
    // "done", então normalmente não chegamos aqui.
    emit({ type: 'done' })
  } catch (err) {
    // parada pedida pelo usuário (botão Parar) ou pela suspensão do computador
    if (signal.aborted) {
      emit({ type: 'done' })
      return
    }
    // silêncio prolongado do streaming: conexão morta (ex.: o computador dormiu)
    if (idleAbort?.signal.aborted) {
      emit({
        type: 'interrupted',
        message:
          'A resposta parou de chegar — o modelo pode estar sobrecarregado/muito lento, ou o ' +
          'computador suspendeu. Clique em Continuar para tentar de novo.'
      })
      return
    }
    emit({ type: 'error', message: friendlyError(err, provider) })
  }
}

/** Reescreve um texto técnico em linguagem simples, com streaming. */
export async function runSimplify(options: {
  provider: ProviderConfig
  text: string
  emit: (event: StreamEvent) => void
  signal: AbortSignal
}): Promise<void> {
  const { provider, text, emit, signal } = options
  const client = makeClient(provider)
  const idleAbort = new AbortController()
  try {
    const stream = await client.chat.completions.create(
      {
        model: provider.model,
        stream: true,
        messages: [
          { role: 'system', content: SIMPLIFY_SYSTEM_PROMPT },
          { role: 'user', content: text }
        ]
      },
      { signal: AbortSignal.any([signal, idleAbort.signal]) }
    )
    for await (const chunk of watchIdle(stream, idleAbort, FIRST_CHUNK_TIMEOUT_MS, IDLE_TIMEOUT_MS)) {
      const token = chunk.choices[0]?.delta?.content
      if (token) emit({ type: 'token', text: token })
    }
    emit({ type: 'done' })
  } catch (err) {
    if (signal.aborted) {
      emit({ type: 'done' })
      return
    }
    if (idleAbort.signal.aborted) {
      emit({ type: 'interrupted', message: 'A conexão caiu durante a simplificação. Tente de novo.' })
      return
    }
    emit({ type: 'error', message: friendlyError(err, provider) })
  }
}

export async function listModels(provider: ProviderConfig): Promise<string[]> {
  const client = makeClient(provider)
  const result = await client.models.list()
  return result.data.map((m) => m.id)
}

function friendlyError(err: unknown, provider: ProviderConfig): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/ECONNREFUSED|fetch failed|Connection error/i.test(raw)) {
    return (
      `Não consegui me conectar ao provedor “${provider.name}” (${provider.baseURL}). ` +
      'Verifique se o servidor do modelo está rodando — por exemplo, se o Ollama está aberto.'
    )
  }
  if (/404|model .* not found|does not exist/i.test(raw)) {
    return (
      `O modelo “${provider.model}” não foi encontrado no provedor “${provider.name}”. ` +
      'Confira o nome do modelo nas configurações.'
    )
  }
  if (/401|invalid api key|authentication/i.test(raw)) {
    return `A chave de API do provedor “${provider.name}” parece inválida ou está faltando.`
  }
  return `Ocorreu um erro ao falar com o modelo: ${raw}`
}
