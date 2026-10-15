import { existsSync, readFileSync, statSync } from 'fs'
import { basename } from 'path'
import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions'
import type { ChatMessage, FileChange, ProviderConfig, StreamEvent } from '../shared/types'
import { normalizeDesign, type DesignContext } from '../shared/design'
import type { McpManager } from './mcp'
import { beginFileChange } from './changes'
import { applyWorkspaceEdit, normalizeWorkspacePath } from './fileEdit'
import { runInFolder, searchWorkspace } from './workspaceActions'
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

const contextCache = new Map<string, number | null>()

/** Janela de contexto do modelo, via Ollama (`/api/show`). Null se o servidor não informar. */
async function modelContextTokens(provider: ProviderConfig): Promise<number | null> {
  const key = `${provider.baseURL}\n${provider.model}`
  const cached = contextCache.get(key)
  if (cached !== undefined) return cached
  let value: number | null = null
  if (/11434|ollama/i.test(provider.baseURL)) {
    try {
      const root = new URL(provider.baseURL)
      root.pathname = root.pathname.replace(/\/v1\/?$/, '')
      root.search = ''
      root.hash = ''
      const response = await fetch(`${root.toString().replace(/\/$/, '')}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: provider.model }),
        signal: AbortSignal.timeout(2000)
      })
      if (response.ok) {
        const data = (await response.json()) as {
          parameters?: string
          model_info?: Record<string, unknown>
        }
        const params = typeof data.parameters === 'string' ? data.parameters : ''
        const numCtx = params.match(/(?:^|\n)\s*num_ctx\s+(\d+)/)
        if (numCtx) value = Number(numCtx[1])
        if (value == null && data.model_info) {
          for (const [name, entry] of Object.entries(data.model_info)) {
            if (name.endsWith('context_length') && typeof entry === 'number' && entry > 0) {
              value = entry
              break
            }
          }
        }
      }
    } catch {
      value = null
    }
  }
  contextCache.set(key, value)
  return value
}

function toCompletionMessage(message: ChatMessage): ChatCompletionMessageParam {
  if (message.role !== 'user' || !message.images?.length) {
    return { role: message.role, content: message.content }
  }
  const text = message.content.trim()
  return {
    role: 'user',
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...message.images.map((image) => ({
        type: 'image_url' as const,
        image_url: { url: image.dataUrl }
      }))
    ]
  }
}

function makeClient(provider: ProviderConfig): OpenAI {
  return new OpenAI({
    baseURL: provider.baseURL,
    // Ollama e afins ignoram a chave, mas o SDK exige um valor.
    apiKey: provider.apiKey || 'sem-chave'
  })
}

/** Ferramentas da pasta que um modelo pequeno só repete em vez de usar. */
const WORKSPACE_SKIP = new Set([
  'list_directory_with_sizes',
  'directory_tree',
  'list_allowed_directories',
  'read_media_file',
  'read_multiple_files',
  'get_file_info'
])

const WORKSPACE_DESCRIPTION: Record<string, string> = {
  list_directory: 'Lista arquivos e pastas. Parâmetro path: caminho absoluto.',
  read_text_file: 'Lê o texto de um arquivo. Parâmetro path: caminho absoluto.',
  read_file: 'Lê o texto de um arquivo. Parâmetro path: caminho absoluto.',
  write_file: 'Cria ou substitui um arquivo. Parâmetros path (absoluto) e content (texto completo).',
  edit_file:
    'Altera trechos de um arquivo existente. Parâmetros path (absoluto) e edits: lista de {oldText, newText}. oldText é o trecho atual copiado do arquivo.',
  create_directory: 'Cria uma pasta. Parâmetro path: caminho absoluto.',
  move_file: 'Move ou renomeia. Parâmetros source e destination, caminhos absolutos.',
  search_files: 'Procura arquivos pelo nome. Parâmetros path e pattern.'
}

const SEARCH_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'search_in_files',
    description: 'Busca texto e nomes de arquivo na pasta de trabalho. Parâmetro query. path é opcional e relativo à pasta.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string' }
      },
      required: ['query']
    }
  }
}

const RUN_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'run_command',
    description: 'Roda um comando dentro da pasta de trabalho, por exemplo testes ou o servidor. Parâmetro command. Pede permissão.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command']
    }
  }
}

const DESIGN_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'design_canvas',
    description:
      'Desenha o design aberto no canvas. Envie title e frames. Cada frame tem name, width, height, background e elements.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        kind: { type: 'string' },
        frames: { type: 'array', items: { type: 'object' } }
      },
      required: ['frames']
    }
  }
}

function buildTools(mcp: McpManager, design: boolean): ChatCompletionTool[] {
  const all = mcp.listNamespacedTools()
  const hasReadText = all.some(
    (entry) => entry.serverId === '__workspace' && entry.tool.name === 'read_text_file'
  )
  const tools = all.flatMap((entry) => {
    const workspace = entry.serverId === '__workspace'
    if (workspace && (WORKSPACE_SKIP.has(entry.tool.name) || (hasReadText && entry.tool.name === 'read_file'))) {
      return []
    }
    const rawDescription =
      entry.tool.description ?? `Ferramenta ${entry.tool.name} do servidor ${entry.serverName}`
    return [
      {
        type: 'function' as const,
        function: {
          name: entry.fullName,
          description: workspace
            ? (WORKSPACE_DESCRIPTION[entry.tool.name] ?? firstSentence(rawDescription))
            : rawDescription,
          parameters: workspace
            ? slimSchema(entry.tool.inputSchema as Record<string, unknown> | undefined)
            : ((entry.tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} })
        }
      }
    ]
  })
  const extra: ChatCompletionTool[] = []
  if (design) extra.push(DESIGN_TOOL)
  if (mcp.workspaceFolder()) extra.push(SEARCH_TOOL, RUN_TOOL)
  return [...extra, ...tools]
}

function firstSentence(text: string): string {
  const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.slice(0, 180) || 'Ferramenta de arquivo.'
}

/** Tira descrições e exemplos do schema. Modelos pequenos copiam esse texto em vez de chamar a ferramenta. */
function slimSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema) return { type: 'object', properties: {} }
  const clone = JSON.parse(JSON.stringify(schema)) as unknown
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    const obj = node as Record<string, unknown>
    delete obj.description
    delete obj.title
    delete obj.examples
    delete obj.$schema
    for (const value of Object.values(obj)) walk(value)
  }
  walk(clone)
  return clone as Record<string, unknown>
}

/** Último arquivo citado pelo usuário em qualquer mensagem, não só na última. */
function intendedFileName(history: ChatMessage[]): string | null {
  const text = history
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n')
  const matches = [...text.matchAll(/\b([\w.-]+\.(?:html?|css|jsx?|tsx?|md|json|py|txt))\b/gi)]
  if (matches.length > 0) return basename(matches[matches.length - 1][1])
  if (/html|p[aá]gina/i.test(text)) return 'index.html'
  return null
}

function userAskedForFile(basenameName: string, history: ChatMessage[]): boolean {
  const text = history
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n')
  return text.toLowerCase().includes(basenameName.toLowerCase())
}

function pathInside(folder: string, input: string): string | null {
  return normalizeWorkspacePath(folder, input)
}

function isDirectory(abs: string): boolean {
  try {
    return existsSync(abs) && statSync(abs).isDirectory()
  } catch {
    return false
  }
}

function fenceContent(text: string): string | null {
  const match = text.match(/```[^\n]*\n([\s\S]*?)```/)
  const body = match?.[1]?.trim()
  return body || null
}

/** O llama local manda os argumentos dentro de parameters, não no topo do JSON. */
function nestedArgs(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      return nestedArgs(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}

function flattenToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const nested = nestedArgs(args.parameters) ?? nestedArgs(args.arguments) ?? nestedArgs(args.function)
  if (!nested) return { ...args }
  const functionArgs = nestedArgs(nested.arguments) ?? nestedArgs(nested.parameters)
  return { ...args, ...nested, ...(functionArgs ?? {}) }
}

/**
 * O modelo local às vezes chama write_file com path vazio ou apontando para a
 * pasta. O servidor recusa com "not a regular file". Aqui o caminho vira o
 * arquivo que o usuário pediu, e o conteúdo pode vir de um bloco de código.
 */
function repairWorkspaceArgs(
  toolName: string,
  args: Record<string, unknown>,
  folder: string,
  history: ChatMessage[],
  assistantText: string
): Record<string, unknown> {
  const fileTools = new Set(['write_file', 'edit_file', 'read_file', 'read_text_file', 'move_file'])
  if (!fileTools.has(toolName)) return args
  const copy = flattenToolArgs(args)
  if (toolName === 'move_file') return copy
  const raw = typeof copy.path === 'string' ? copy.path : typeof copy.file_path === 'string' ? copy.file_path : ''
  let abs = raw.trim() ? pathInside(folder, raw.trim()) : null
  const remembered = intendedFileName(history)
  const inventedTxt = !!abs && basename(abs).toLowerCase() === 'index.txt' && !userAskedForFile('index.txt', history)
  if (!abs || isDirectory(abs) || inventedTxt) {
    if (remembered) abs = pathInside(folder, remembered)
  }
  if (abs) {
    copy.path = abs
    delete copy.file_path
  }
  // head/tail 0 faz a leitura “funcionar” sem devolver nenhuma linha.
  for (const key of ['head', 'tail'] as const) {
    const value = copy[key]
    const count = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    if (!Number.isFinite(count) || count <= 0) delete copy[key]
  }
  if (toolName === 'write_file') {
    let content = typeof copy.content === 'string' ? copy.content : ''
    if (!content.trim()) {
      const fromText = fenceContent(assistantText)
      if (fromText && !isPlaceholderContent(fromText)) content = fromText
    }
    return { path: copy.path, content }
  }
  return copy
}

function isPlaceholderContent(content: string): boolean {
  const compact = content.replace(/\s+/g, ' ').trim().toLowerCase()
  return (
    compact === 'texto completo do arquivo' ||
    compact === 'conteúdo completo' ||
    compact === 'conteudo completo' ||
    compact === '<html></html>' ||
    compact === '<html>...</html>' ||
    compact === '<html><body></body></html>'
  )
}

function invalidWrite(args: Record<string, unknown>): string | null {
  const path = typeof args.path === 'string' ? args.path : ''
  const content = typeof args.content === 'string' ? args.content : ''
  if (!path || isDirectory(path)) {
    return 'O caminho enviado foi a pasta, não um arquivo. write_file precisa de um arquivo, como index.html.'
  }
  if (!content.trim() || isPlaceholderContent(content)) {
    return `write_file não foi gravado em ${path || 'arquivo indefinido'}: o conteúdo veio vazio ou era só um texto de exemplo. Use o arquivo que o usuário já citou e coloque nele o texto real do pedido.`
  }
  return destructiveRewrite(path, content)
}

/**
 * Num pedido de alteração o modelo pequeno manda write_file só com o trecho
 * novo ("Bem-vindo") e o HTML inteiro some. Recusa e pede o arquivo completo.
 */
function destructiveRewrite(path: string, content: string): string | null {
  const before = currentText(path)
  if (!before || before.trim().length < 200) return null
  const wasDocument = /<!doctype|<html|<body/i.test(before)
  const losesMarkup = wasDocument && !/<[a-z!][^>]*>/i.test(content)
  const tiny = content.trim().length < before.trim().length * 0.25 && !content.includes('\n')
  if (!losesMarkup && !tiny) return null
  return (
    `write_file não foi gravado: ${path} tem ${before.length} caracteres e o conteúdo novo só ${content.length}, ` +
    'o que apagaria o resto do arquivo. Para alterar um arquivo, mande em content o arquivo INTEIRO já modificado, ' +
    'partindo do conteúdo atual, ou use edit_file com o trecho exato.'
  )
}

const MAX_CONTEXT_FILE_CHARS = 20_000

function currentText(abs: string): string | null {
  try {
    if (!existsSync(abs) || !statSync(abs).isFile() || statSync(abs).size > MAX_CONTEXT_FILE_CHARS * 2) return null
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/**
 * O histórico só leva o texto das mensagens, não o resultado das ferramentas.
 * Num pedido de alteração o modelo não sabia o que havia no arquivo e chutava
 * o oldText ou regravava só o trecho novo. Aqui vai o conteúdo atual junto.
 */
function currentFileBlock(folder: string, history: ChatMessage[]): string {
  const name = intendedFileName(history)
  if (!name) return ''
  const abs = pathInside(folder, name)
  if (!abs) return ''
  const text = currentText(abs)
  if (text == null || text.length > MAX_CONTEXT_FILE_CHARS) return ''
  const lang = name.split('.').pop() ?? ''
  return (
    `\n\nO arquivo ${abs} já existe. Conteúdo atual:\n\`\`\`${lang}\n${text}\n\`\`\`\n` +
    'Para alterá-lo, chame write_file com este mesmo path e o arquivo inteiro já modificado, ' +
    'ou edit_file com oldText copiado exatamente deste conteúdo.'
  )
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
        function?: unknown
        arguments?: unknown
        parameters?: unknown
      }
      // O llama pequeno também escreve {"type":"function","function":{"name":...,"parameters":...}}
      // ou {"function":"nome","parameters":...}.
      const fn = obj.function
      const inner = fn && typeof fn === 'object' && !Array.isArray(fn) ? (fn as Record<string, unknown>) : null
      const name = typeof obj.name === 'string' ? obj.name : typeof fn === 'string' ? fn : inner?.name
      // aceita nome completo (servidor__ferramenta) ou o nome "cru" (ex.: "read_file")
      const entry = typeof name === 'string' ? mcp.resolveTool(name) : undefined
      const local = typeof name === 'string' && (name === 'search_in_files' || name === 'run_command')
      if (!entry && !local) continue
      const rawArgs = obj.arguments ?? obj.parameters ?? inner?.arguments ?? inner?.parameters ?? {}
      const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)
      const callName = entry?.fullName ?? (typeof name === 'string' ? name : '')
      if (callName && !calls.some((c) => c.name === callName && c.args === args)) {
        calls.push({ id: `textcall_${Date.now()}_${calls.length}`, name: callName, args })
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

export interface ChatRunResult {
  ok: boolean
  text: string
}

function designPayloadFromText(text: string): Record<string, unknown> | null {
  const fence = text.match(/```design\s*\n([\s\S]*?)```/)
  const candidates = fence?.[1] ? [fence[1]] : []
  candidates.push(...findJsonObjects(text))
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (Array.isArray(parsed.frames)) return parsed
      const nested = parsed.arguments ?? parsed.parameters
      const name = parsed.name ?? parsed.function
      if (
        nested &&
        typeof nested === 'object' &&
        !Array.isArray(nested) &&
        Array.isArray((nested as Record<string, unknown>).frames) &&
        (name === 'design_canvas' || name === undefined)
      ) {
        return nested as Record<string, unknown>
      }
    } catch {
      // o próximo candidato pode ser o desenho
    }
  }
  return null
}

export async function runChat(options: {
  provider: ProviderConfig
  systemPrompt: string
  history: ChatMessage[]
  mcp: McpManager
  emit: (event: StreamEvent) => void
  requestPermission: (request: PermissionRequest) => Promise<'allow' | 'deny'>
  signal: AbortSignal
  design?: DesignContext
  /** No modo propor o modelo não deve ser cobrado a gravar arquivo. */
  allowFileWrites?: boolean
  /** Etapas intermediárias de uma equipe não escrevem no chat; só devolvem o texto. */
  emitTokens?: boolean
  /** A última etapa emite done. As anteriores deixam a equipe decidir quando encerrar. */
  emitDone?: boolean
}): Promise<ChatRunResult> {
  const { provider, systemPrompt, history, mcp, emit, requestPermission, signal } = options
  const emitTokens = options.emitTokens !== false
  const emitDone = options.emitDone !== false
  const succeed = (text: string): ChatRunResult => {
    if (emitDone) emit({ type: 'done' })
    return { ok: true, text }
  }
  const client = makeClient(provider)
  const contextTokensPromise = modelContextTokens(provider)
  const tools = buildTools(mcp, Boolean(options.design))
  let designApplied = false
  const publishDesignText = (text: string): void => {
    if (!options.design || designApplied) return
    const payload = designPayloadFromText(text)
    if (!payload) return
    try {
      emit({ type: 'design-update', design: normalizeDesign(payload, options.design) })
      designApplied = true
    } catch {
      // o texto não era um desenho válido; a resposta segue em texto
    }
  }

  const folder = mcp.workspaceFolder()
  const allowFileWrites = options.allowFileWrites !== false && !!folder
  const toolRules =
    tools.length > 0
      ? '\n\nQuando o usuário pedir para criar ou alterar um arquivo, chame write_file com o path absoluto desse arquivo e o conteúdo real. ' +
        'Se ele pedir para editar algo que já existe, use o mesmo path. Não invente outro arquivo. ' +
        'Para achar um texto na pasta, use search_in_files. Para rodar testes ou um comando, use run_command. ' +
        'Se ele só fizer uma pergunta, responda em texto e não chame ferramenta.'
      : ''
  const fileContext = allowFileWrites && folder && tools.length > 0 ? currentFileBlock(folder, history) : ''

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt + toolRules + fileContext },
    ...history.map(toCompletionMessage)
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
      const request = {
        model: provider.model,
        messages,
        stream: true as const,
        ...(useTools ? { tools } : {})
      }
      const streamSignal = AbortSignal.any([signal, idleAbort.signal])
      let stream: Awaited<ReturnType<typeof client.chat.completions.create>>
      try {
        stream = await client.chat.completions.create(
          { ...request, stream_options: { include_usage: true } },
          { signal: streamSignal }
        )
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err)
        if (!/stream_options|unknown field|unrecognized|unexpected/i.test(raw)) throw err
        stream = await client.chat.completions.create(request, { signal: streamSignal })
      }

      let assistantText = ''
      const toolCalls: PendingToolCall[] = []
      let roundUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null

      for await (const chunk of watchIdle(stream, idleAbort, FIRST_CHUNK_TIMEOUT_MS, IDLE_TIMEOUT_MS)) {
        const counted = chunk.usage
        if (counted && typeof counted.prompt_tokens === 'number') {
          const completionTokens = counted.completion_tokens ?? 0
          roundUsage = {
            promptTokens: counted.prompt_tokens,
            completionTokens,
            totalTokens: counted.total_tokens ?? counted.prompt_tokens + completionTokens
          }
        }
        const delta = chunk.choices[0]?.delta
        if (!delta) continue
        if (delta.content) {
          assistantText += delta.content
          if (emitTokens) emit({ type: 'token', text: delta.content })
        }
        for (const tc of delta.tool_calls ?? []) {
          const slot = (toolCalls[tc.index] ??= { id: '', name: '', args: '' })
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name += tc.function.name
          if (tc.function?.arguments) slot.args += tc.function.arguments
        }
      }

      if (roundUsage) {
        emit({
          type: 'usage',
          usage: { ...roundUsage, contextTokens: await contextTokensPromise }
        })
      }

      // Sem ferramentas nesta rodada (a última): o texto gerado É a resposta final.
      if (!useTools) {
        publishDesignText(assistantText)
        return succeed(assistantText)
      }

      if (toolCalls.length === 0) {
        // fallback: o modelo escreveu a chamada como texto em vez de usar tool calling
        const textual = assistantText ? extractTextualToolCalls(assistantText, mcp) : []
        if (textual.length === 0) {
          publishDesignText(assistantText)
          return succeed(assistantText)
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
        if (options.design && (tc.name === 'design_canvas' || tc.name.endsWith('__design_canvas'))) {
          emit({
            type: 'tool-start',
            callId: tc.id,
            toolName: 'design_canvas',
            serverName: 'Design',
            explanation: 'Desenhar no canvas.'
          })
          let resultText = ''
          let ok = true
          try {
            const parsed = tc.args ? (JSON.parse(tc.args) as Record<string, unknown>) : {}
            const doc = normalizeDesign(flattenToolArgs(parsed), options.design)
            emit({ type: 'design-update', design: doc })
            designApplied = true
            resultText = `Canvas atualizado: “${doc.title}”, ${doc.frames.length} quadro(s).`
          } catch (err) {
            ok = false
            resultText = err instanceof Error ? err.message : String(err)
          }
          emit({
            type: 'tool-end',
            callId: tc.id,
            ok,
            summary: ok ? 'O canvas foi atualizado.' : resultText
          })
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: ok ? resultText : `Erro ao executar a ferramenta: ${resultText}`
          })
          continue
        }
        const localName =
          tc.name === 'search_in_files' || tc.name === 'run_command'
            ? tc.name
            : tc.name.endsWith('__search_in_files')
              ? 'search_in_files'
              : tc.name.endsWith('__run_command')
                ? 'run_command'
                : null
        if (localName) {
          let parsed: Record<string, unknown> = {}
          try {
            parsed = flattenToolArgs(tc.args ? (JSON.parse(tc.args) as Record<string, unknown>) : {})
          } catch {
            parsed = {}
          }
          const command = typeof parsed.command === 'string' ? parsed.command : ''
          const query = typeof parsed.query === 'string' ? parsed.query : ''
          const explanation =
            localName === 'run_command'
              ? `Vou rodar este comando na pasta de trabalho:\n${command || '(vazio)'}`
              : `Vou buscar “${query || '(vazio)'}” nos arquivos da pasta.`
          const decision = await requestPermission({
            callId: tc.id,
            fullName: localName,
            toolName: localName,
            serverName: 'Pasta de trabalho',
            explanation
          })
          if (signal.aborted) {
            emit({ type: 'done' })
            return { ok: false, text: assistantText }
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
              content: 'O usuário NEGOU a permissão. Não tente de novo; pergunte como ele prefere prosseguir.'
            })
            continue
          }
          emit({
            type: 'tool-start',
            callId: tc.id,
            toolName: localName,
            serverName: 'Pasta de trabalho',
            explanation
          })
          let resultText = ''
          let ok = true
          try {
            if (!folder) throw new Error('Nenhuma pasta de trabalho definida.')
            if (localName === 'search_in_files') {
              resultText = searchWorkspace(folder, query, typeof parsed.path === 'string' ? parsed.path : undefined)
            } else {
              const ran = await runInFolder(folder, command, signal)
              resultText = ran.output
              ok = ran.ok
              emit({ type: 'command-output', command, output: ran.output, ok: ran.ok })
            }
          } catch (err) {
            ok = false
            resultText = err instanceof Error ? err.message : String(err)
          }
          emit({
            type: 'tool-end',
            callId: tc.id,
            ok,
            summary: ok ? resultText.slice(0, 180) : resultText.slice(0, 200)
          })
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: localName === 'run_command' ? resultText : ok ? resultText : `Erro ao executar a ferramenta: ${resultText}`
          })
          continue
        }
        const entry = mcp.lookup(tc.name)
        const toolName = entry?.tool.name ?? tc.name
        const serverName = entry?.serverName ?? 'desconhecido'
        if (entry?.serverId === '__workspace' && folder) {
          let parsed: Record<string, unknown> = {}
          try {
            parsed = tc.args ? (JSON.parse(tc.args) as Record<string, unknown>) : {}
          } catch {
            parsed = {}
          }
          const repaired = repairWorkspaceArgs(toolName, parsed, folder, history, assistantText)
          tc.args = JSON.stringify(repaired)
        }
        const shownDescription =
          entry?.serverId === '__workspace'
            ? WORKSPACE_DESCRIPTION[toolName]
            : entry?.tool.description
        const explanation = explainToolCall(serverName, toolName, shownDescription, tc.args)

        const decision = await requestPermission({
          callId: tc.id,
          fullName: tc.name,
          toolName,
          serverName,
          explanation
        })
        if (signal.aborted) {
          emit({ type: 'done' })
          return { ok: false, text: assistantText }
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
        let finishChange: (() => FileChange[]) | null = null
        try {
          const args = tc.args ? (JSON.parse(tc.args) as Record<string, unknown>) : {}
          const workspaceWrite =
            entry?.serverId === '__workspace' && (toolName === 'write_file' || toolName === 'edit_file')
          if (workspaceWrite && !allowFileWrites) {
            throw new Error('Modo apenas propor: não grave arquivos. Mostre o código na resposta.')
          }
          if (toolName === 'write_file' && entry?.serverId === '__workspace') {
            const problem = invalidWrite(args)
            if (problem) throw new Error(problem)
          }
          finishChange = beginFileChange(
            mcp.workspaceFolder(),
            entry?.serverId === '__workspace',
            toolName,
            args
          )
          // edit_file roda aqui, e não no MCP: o servidor exige match exato e
          // falha mesmo depois que o usuário autorizou a edição.
          if (toolName === 'edit_file' && entry?.serverId === '__workspace') {
            if (!folder) throw new Error('Nenhuma pasta de trabalho definida para editar o arquivo.')
            resultText = applyWorkspaceEdit(folder, args)
          } else {
            resultText = await mcp.callTool(tc.name, args)
          }
        } catch (err) {
          ok = false
          finishChange = null
          resultText = err instanceof Error ? err.message : String(err)
        }

        if (ok && finishChange) {
          for (const change of finishChange()) emit({ type: 'file-change', change })
        }

        const summary =
          ok && toolName === 'edit_file'
            ? 'Pronto — o trecho foi alterado no arquivo.'
            : ok && toolName === 'write_file'
              ? 'Pronto — o arquivo foi gravado.'
              : summarizeToolResult(ok, resultText)
        emit({ type: 'tool-end', callId: tc.id, ok, summary })

        // Uma falha NÃO aborta a geração: devolvemos o erro ao modelo para que ele
        // se corrija (caminho errado, arquivo inexistente…). Só depois de insistir
        // na MESMA ferramenta damos uma orientação mais firme para mudar de rumo.
        let guidance = ''
        if (ok) {
          toolFailures.delete(tc.name)
        } else {
          const failures = (toolFailures.get(tc.name) ?? 0) + 1
          toolFailures.set(tc.name, failures)
          const editHint =
            toolName === 'edit_file'
              ? ' Leia o arquivo com read_text_file e copie o trecho, ou use write_file com o conteúdo completo.'
              : ''
          guidance =
            failures >= MAX_TOOL_FAILURES
              ? `\nATENÇÃO: “${toolName}” já falhou ${failures} vezes seguidas. NÃO a chame de novo ` +
                'com os mesmos argumentos. Liste o diretório para confirmar o caminho/nome exato, ' +
                'use outra ferramenta, ou explique o problema ao usuário e pergunte como prosseguir.' +
                editHint
              : '\nDica: confira os argumentos (use caminho absoluto e o nome exato do arquivo); ' +
                'se não tiver certeza do nome, liste o diretório antes de tentar de novo.' +
                editHint
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
    return succeed('')
  } catch (err) {
    // parada pedida pelo usuário (botão Parar) ou pela suspensão do computador
    if (signal.aborted) {
      emit({ type: 'done' })
      return { ok: false, text: '' }
    }
    // silêncio prolongado do streaming: conexão morta (ex.: o computador dormiu)
    if (idleAbort?.signal.aborted) {
      emit({
        type: 'interrupted',
        message:
          'A resposta parou de chegar — o modelo pode estar sobrecarregado/muito lento, ou o ' +
          'computador suspendeu. Clique em Continuar para tentar de novo.'
      })
      return { ok: false, text: '' }
    }
    emit({ type: 'error', message: friendlyError(err, provider) })
    return { ok: false, text: '' }
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
