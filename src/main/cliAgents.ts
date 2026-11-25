import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { StringDecoder } from 'string_decoder'
import type { ChatMessage, CliAgentId, CliAuthStatus, CliLimit, CliLimits, FileChange, StreamEvent, TerminalCliConfig } from '../shared/types'
import { CLI_AGENT_LABEL } from '../shared/types'
import { beginFileChange } from './changes'
import type { PermissionRequest } from './chat'
import { summarizeToolResult } from './humanizer'
import { findBinary, resolveShellPath, SESSION_ENV } from './terminal'

/**
 * Conduz os CLIs de agente (Claude, Cursor, Copilot, Gemini) sem terminal: cada um
 * roda em modo estruturado e vira os mesmos eventos de um modelo comum do chat.
 * - Claude: JSON por linha (`--output-format stream-json`).
 * - Os outros: Agent Client Protocol (JSON-RPC por linha).
 */

export interface CliRunOptions {
  agent: CliAgentId
  config?: TerminalCliConfig
  cwd: string
  /** Pasta da conversa; null quando o chat não tem pasta. */
  folder: string | null
  systemPrompt: string
  history: ChatMessage[]
  /** Sessão do CLI a continuar e quantas mensagens da conversa ela já conhece. */
  resume?: { sessionId: string; seen: number } | null
  allowFileWrites: boolean
  emit: (event: StreamEvent) => void
  requestPermission: (request: PermissionRequest) => Promise<'allow' | 'deny'>
  signal: AbortSignal
}

type Json = Record<string, unknown>

const running = new Map<CliAgentId, number>()

export function isCliAgentRunning(agent: CliAgentId): boolean {
  return (running.get(agent) ?? 0) > 0
}

export function findCliAgent(agent: CliAgentId, config?: TerminalCliConfig): string[] | null {
  const path = resolveShellPath()
  const custom =
    agent === 'claude' ? config?.claudeCommand?.trim() : agent === 'copilot' ? config?.copilotCommand?.trim() : ''
  if (custom) {
    if (existsSync(custom)) return [custom]
    const [name, ...args] = custom.split(/\s+/)
    const found = existsSync(name) ? name : findBinary(name, path)
    // "gh copilot" não fala o protocolo: nesse caso vale o binário próprio, abaixo.
    if (found && name !== 'gh') return [found, ...args]
  }
  if (agent === 'cursor') {
    const local = process.env.LOCALAPPDATA
    const windows = local ? join(local, 'cursor-agent', 'cursor-agent.cmd') : ''
    if (windows && existsSync(windows)) return [windows]
    const found = findBinary('cursor-agent', path) ?? findBinary('agent', path)
    return found ? [found] : null
  }
  const found = findBinary(agent, path)
  return found ? [found] : null
}

const INSTALL_HINT: Record<CliAgentId, string> = {
  claude: 'Instale com `npm i -g @anthropic-ai/claude-code`.',
  cursor: 'Instale o Cursor CLI (`cursor-agent`) pelo site do Cursor.',
  copilot: 'Instale com `npm i -g @github/copilot`.',
  gemini: 'Instale com `npm i -g @google/gemini-cli`.'
}

const LOGIN_HINT: Record<CliAgentId, string> = {
  claude: 'rode `claude auth login`',
  cursor: 'rode `cursor-agent login`',
  copilot: 'rode `copilot` e digite `/login`',
  gemini: 'rode `gemini` e faça o login'
}

function needsLogin(raw: string): boolean {
  return /authenticat|not logged in|unauthori[sz]ed|oauth|\/login|api key|-32000/i.test(raw)
}

function friendlyCliError(agent: CliAgentId, raw: string): string {
  const label = CLI_AGENT_LABEL[agent]
  if (needsLogin(raw)) {
    return `O ${label} precisa de login neste computador. Clique em Fazer login, ou ${LOGIN_HINT[agent]} num terminal, e envie a mensagem de novo.`
  }
  if (/rate.?limit|usage limit|quota|429/i.test(raw)) {
    return `O limite de uso do ${label} foi atingido. ${raw}`.trim()
  }
  return `O ${label} encerrou com erro: ${raw.trim().slice(-600) || 'sem detalhes'}`
}

function launch(command: string[], cwd: string): ChildProcessWithoutNullStreams {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (SESSION_ENV.test(key) || key === 'ELECTRON_RUN_AS_NODE' || key.toLowerCase() === 'path') continue
    env[key] = value
  }
  env.PATH = resolveShellPath()
  env.NO_COLOR = '1'
  const [file, ...args] = command
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    // Arquivos .cmd só rodam pelo shell. Os argumentos são fixos, sem texto do usuário.
    const line = [file, ...args].map((part) => `"${part}"`).join(' ')
    return spawn(line, { cwd, env, shell: true, windowsHide: true })
  }
  return spawn(file, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32' })
}

function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {})
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

/** Pergunta ao CLI se há login. Só o Claude e o Cursor informam isso. */
export async function cliAuthStatus(agent: CliAgentId, config?: TerminalCliConfig): Promise<CliAuthStatus> {
  const command = findCliAgent(agent, config)
  if (!command) return { agent, installed: false, loggedIn: null }
  const args = agent === 'claude' ? ['auth', 'status'] : agent === 'cursor' ? ['status'] : null
  if (!args) return { agent, installed: true, loggedIn: null }
  const output = await new Promise<string>((resolve) => {
    const child = launch([...command, ...args], tmpdir())
    let text = ''
    const timer = setTimeout(() => killTree(child), 10_000)
    child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
    child.on('error', () => resolve(''))
    child.on('close', () => {
      clearTimeout(timer)
      resolve(text)
    })
  })
  let loggedIn: boolean | null = null
  if (/"loggedIn":\s*false|not (logged in|authenticated)/i.test(output)) loggedIn = false
  else if (/"loggedIn":\s*true|logged in/i.test(output)) loggedIn = true
  return { agent, installed: true, loggedIn }
}

/** Uma leitura vale por este tempo; um pedido explícito aceita uma mais recente. */
const LIMITS_TTL_MS = 55_000
const LIMITS_MIN_GAP_MS = 10_000
let limitsCache: CliLimits = { agent: 'claude', limits: [], updatedAt: 0 }
let limitsTriedAt = 0
let limitsPending: Promise<CliLimits> | null = null

function limitLabel(kind: string, scope: unknown): string {
  if (kind === 'session') return 'Sessão'
  if (kind === 'weekly_all') return 'Semana'
  const item = obj(scope)
  const model = obj(item.model)
  const name = str(scope) || str(model.display_name) || str(model.name) || str(item.display_name) || str(item.model)
  return `Semana · ${name || kind.replace(/^weekly_/, '')}`
}

function limitsFromText(text: string): CliLimit[] {
  return [...text.matchAll(/^Current (session|week)(?: \(([^)]*)\))?: (\d+)% used/gm)].map((match) => ({
    kind: match[1],
    label: match[1] === 'session' ? 'Sessão' : !match[2] || match[2] === 'all models' ? 'Semana' : `Semana · ${match[2]}`,
    percent: Number(match[3]),
    resetsAt: null
  }))
}

/** `/usage` é respondido pelo próprio CLI: não chama o modelo nem gasta tokens. */
async function fetchClaudeLimits(config?: TerminalCliConfig): Promise<CliLimits> {
  const command = findCliAgent('claude', config)
  if (!command) return { agent: 'claude', limits: [], updatedAt: 0, problem: 'unsupported' }
  const temp = mkdtempSync(join(tmpdir(), 'osvacode-'))
  const settingsFile = join(temp, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify({ disableAllHooks: true }))
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--settings', settingsFile
  ]
  try {
    return await new Promise<CliLimits>((resolve) => {
      const child = launch([...command, ...args], temp)
      live.add(child)
      let limits: CliLimit[] = []
      let text = ''
      const timer = setTimeout(() => killTree(child), 20_000)
      const finish = (): void => {
        clearTimeout(timer)
        live.delete(child)
        if (limits.length === 0) limits = limitsFromText(text)
        resolve(
          limits.length > 0
            ? { agent: 'claude', limits, updatedAt: Date.now() }
            : { agent: 'claude', limits: [], updatedAt: 0, problem: 'failed' }
        )
      }
      child.on('error', finish)
      child.on('close', finish)
      child.stdin.on('error', () => {})
      child.stderr.resume()
      readLines(child, (message) => {
        const rates = obj(obj(message.usage_report).rate_limits)
        const found = list(rates.limits).filter((item) => typeof item.percent === 'number')
        if (found.length > 0) {
          limits = found.map((item) => ({
            kind: str(item.kind),
            label: limitLabel(str(item.kind), item.scope),
            percent: num(item.percent),
            resetsAt: str(item.resets_at) || null
          }))
        }
        if (message.type === 'result') text = str(message.result)
      })
      writeLine(child, {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '/usage' }] }
      })
      child.stdin.end()
    })
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

/**
 * Cursor, Copilot e Gemini não informam o uso do plano pela linha de comando;
 * por isso só o Claude traz números.
 */
export async function readCliLimits(config: TerminalCliConfig | undefined, fresh: boolean): Promise<CliLimits[]> {
  const age = Date.now() - limitsTriedAt
  if (!limitsPending && age > (fresh ? LIMITS_MIN_GAP_MS : LIMITS_TTL_MS)) {
    limitsTriedAt = Date.now()
    limitsPending = (async () => {
      const read = await fetchClaudeLimits(config).catch(
        (): CliLimits => ({ agent: 'claude', limits: [], updatedAt: 0, problem: 'failed' })
      )
      if (read.problem === 'failed') {
        const auth = await cliAuthStatus('claude', config)
        // sem login os números antigos podem ser de outra conta
        if (auth.loggedIn === false) return { ...read, problem: 'login' as const }
        return { ...limitsCache, problem: 'failed' as const }
      }
      return read
    })().finally(() => {
      limitsPending = null
    })
  }
  if (limitsPending) limitsCache = await limitsPending
  return [limitsCache]
}

const live = new Set<ChildProcessWithoutNullStreams>()

/** Encerra os CLIs em andamento quando o app fecha. */
export function closeAllCliAgents(): void {
  for (const child of live) killTree(child)
}

function readLines(child: ChildProcessWithoutNullStreams, onMessage: (message: Json) => void): void {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk)
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue // aviso solto do CLI
      }
      if (message && typeof message === 'object') onMessage(message as Json)
    }
  })
}

function writeLine(child: ChildProcessWithoutNullStreams, message: Json): void {
  if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`)
}

function obj(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(obj) : []
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n')
  const item = obj(value)
  return str(item.text) || (item.content ? textOf(item.content) : '')
}

function isCliCommand(text: string): boolean {
  return /^\/[\w:-]+(\s|$)/.test(text)
}

/** Saída de comando vem em colunas simples: mantém uma linha por linha no Markdown. */
function commandText(text: string): string {
  return /^#|^\||^[-*] /m.test(text) ? text : text.replace(/\n/g, '  \n')
}

/** Só o que a sessão ainda não viu; numa sessão nova, a conversa inteira. */
function buildPrompt(history: ChatMessage[], seen: number): { text: string; images: { mime: string; data: string }[] } {
  const last = history[history.length - 1]
  const start = Math.min(Math.max(0, seen), Math.max(0, history.length - 1))
  const request = last?.content ?? ''
  // Comando do CLI (/usage, /context…) só vale sozinho, no começo da mensagem.
  const prior = isCliCommand(request) ? [] : history.slice(start, -1).filter((message) => message.content.trim())
  const text = prior.length
    ? 'Contexto desta conversa até aqui:\n\n' +
      prior.map((m) => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.content}`).join('\n\n') +
      `\n\n---\nMensagem atual do usuário:\n${request}`
    : request
  const images: { mime: string; data: string }[] = []
  for (const image of last?.images ?? []) {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(image.dataUrl)
    if (match) images.push({ mime: match[1], data: match[2] })
  }
  return { text, images }
}

const TOOL_LABEL: Record<string, string> = {
  Bash: 'Rodar comando',
  Read: 'Ler arquivo',
  Write: 'Criar arquivo',
  Edit: 'Editar arquivo',
  MultiEdit: 'Editar arquivo',
  NotebookEdit: 'Editar notebook',
  Glob: 'Procurar arquivos',
  Grep: 'Buscar no código',
  WebFetch: 'Abrir página',
  WebSearch: 'Pesquisar na web',
  Task: 'Delegar etapa',
  Agent: 'Delegar etapa',
  TodoWrite: 'Organizar tarefas',
  Skill: 'Usar skill'
}

const KIND_LABEL: Record<string, string> = {
  read: 'Ler arquivo',
  edit: 'Editar arquivo',
  delete: 'Apagar arquivo',
  move: 'Mover arquivo',
  search: 'Buscar no código',
  execute: 'Rodar comando',
  fetch: 'Abrir página',
  think: 'Pensar'
}

function explainInput(name: string, input: Json): string {
  const detail =
    str(input.command) || str(input.file_path) || str(input.path) || str(input.pattern) || str(input.query) || str(input.url)
  const description = str(input.description)
  const lines = [description, detail].filter(Boolean)
  if (lines.length === 0) {
    const raw = JSON.stringify(input)
    if (raw !== '{}') lines.push(raw.length > 300 ? `${raw.slice(0, 300)}…` : raw)
  }
  return lines.join('\n') || name
}

class ToolCards {
  private open = new Set<string>()
  private denied = new Set<string>()
  private finishers = new Map<string, () => FileChange[]>()

  constructor(private options: CliRunOptions) {}

  start(callId: string, toolName: string, explanation: string): void {
    this.open.add(callId)
    this.options.emit({ type: 'tool-start', callId, toolName, serverName: this.label(), explanation })
  }

  /** Guarda o arquivo antes da escrita para montar o diff depois. */
  watch(callId: string, path: string): void {
    if (!path || this.finishers.has(callId)) return
    const finish = beginFileChange(this.options.folder, true, 'write_file', { path })
    if (finish) this.finishers.set(callId, finish)
  }

  async ask(callId: string, permissionKey: string, toolName: string, explanation: string): Promise<boolean> {
    const decision = await this.options.requestPermission({
      callId,
      fullName: `cli:${this.options.agent}:${permissionKey}`,
      toolName,
      serverName: this.label(),
      explanation
    })
    this.open.add(callId)
    if (decision === 'allow') {
      this.start(callId, toolName, explanation)
      return true
    }
    this.denied.add(callId)
    this.end(callId, false, '')
    return false
  }

  end(callId: string, ok: boolean, text: string): void {
    if (!this.open.delete(callId)) return
    const finish = this.finishers.get(callId)
    this.finishers.delete(callId)
    if (this.denied.has(callId)) {
      this.options.emit({
        type: 'tool-end',
        callId,
        ok: false,
        denied: true,
        summary: 'Você não autorizou esta ação — sigo sem executá-la.'
      })
      return
    }
    if (ok && finish) for (const change of finish()) this.options.emit({ type: 'file-change', change })
    this.options.emit({
      type: 'tool-end',
      callId,
      ok,
      summary: ok && !text.trim() ? 'Pronto.' : summarizeToolResult(ok, text)
    })
  }

  closeAll(): void {
    for (const callId of [...this.open]) this.end(callId, false, 'a resposta terminou antes desta etapa.')
  }

  private label(): string {
    return CLI_AGENT_LABEL[this.options.agent]
  }
}

class StaleSession extends Error {}

export async function runCliAgent(options: CliRunOptions): Promise<void> {
  const { agent, emit, signal } = options
  const command = findCliAgent(agent, options.config)
  if (!command) {
    emit({
      type: 'error',
      message: `O ${CLI_AGENT_LABEL[agent]} não está instalado neste computador. ${INSTALL_HINT[agent]}`
    })
    return
  }
  // O login abre o navegador e espera no terminal: não funciona no modo estruturado.
  if (/^\/login(\s|$)/.test(options.history[options.history.length - 1]?.content ?? '')) {
    emit({ type: 'cli-login', agent })
    emit({ type: 'error', message: friendlyCliError(agent, '/login') })
    return
  }
  const cards = new ToolCards(options)
  running.set(agent, (running.get(agent) ?? 0) + 1)
  const attempt = (resume: CliRunOptions['resume']): Promise<void> =>
    agent === 'claude'
      ? runClaude(command, { ...options, resume }, cards)
      : runAcp(command, { ...options, resume }, cards)
  try {
    try {
      await attempt(options.resume)
    } catch (err) {
      // A sessão guardada sumiu (outra pasta, outro computador): recomeça com a conversa inteira.
      if (!(err instanceof StaleSession) || signal.aborted) throw err
      await attempt(null)
    }
    cards.closeAll()
    emit({ type: 'done' })
  } catch (err) {
    cards.closeAll()
    if (signal.aborted) emit({ type: 'done' })
    else {
      const raw = err instanceof Error ? err.message : String(err)
      if (needsLogin(raw)) emit({ type: 'cli-login', agent })
      emit({ type: 'error', message: friendlyCliError(agent, raw) })
    }
  } finally {
    running.set(agent, Math.max(0, (running.get(agent) ?? 1) - 1))
  }
}

/**
 * Ciclo de vida comum: lança o processo, resolve quando `finish` é chamado e
 * rejeita se o processo morrer antes.
 */
function drive(
  command: string[],
  options: CliRunOptions,
  onAbort: (child: ChildProcessWithoutNullStreams) => void,
  body: (child: ChildProcessWithoutNullStreams, finish: (err?: Error) => void, stderr: () => string) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new Error('cancelado'))
      return
    }
    const child = launch(command, options.cwd)
    live.add(child)
    let errText = ''
    let settled = false
    const abort = (): void => {
      onAbort(child)
      finish(new Error('cancelado'))
    }
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      options.signal.removeEventListener('abort', abort)
      child.stdin.end()
      setTimeout(() => killTree(child), 1500)
      if (err) reject(err)
      else resolve()
    }
    options.signal.addEventListener('abort', abort, { once: true })
    child.stdin.on('error', () => {})
    child.stderr.on('data', (chunk: Buffer) => {
      errText = (errText + chunk.toString('utf8')).slice(-4000)
    })
    child.on('error', (err) => {
      live.delete(child)
      finish(err)
    })
    child.on('close', (code) => {
      live.delete(child)
      finish(new Error(errText || `o processo terminou (código ${code ?? '?'}) sem responder.`))
    })
    body(child, finish, () => errText)
  })
}

// ---------- Claude: stream-json ----------

async function runClaude(command: string[], options: CliRunOptions, cards: ToolCards): Promise<void> {
  const { emit, resume } = options
  const temp = mkdtempSync(join(tmpdir(), 'osvacode-'))
  const promptFile = join(temp, 'system.md')
  writeFileSync(promptFile, options.systemPrompt, { encoding: 'utf8', mode: 0o600 })

  // Perguntas e planos dependem da tela do CLI; aqui ele pergunta em texto.
  const blocked = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']
  if (!options.allowFileWrites) blocked.push('Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash')
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
    '--append-system-prompt-file', promptFile,
    '--disallowedTools', blocked.join(',')
  ]
  if (resume && /^[\w-]+$/.test(resume.sessionId)) args.push('--resume', resume.sessionId)

  try {
    await drive([...command, ...args], options, killTree, (child, finish, stderr) => {
      let streamed = false
      let answered = false
      let needsBreak = false
      let lastUsage: Json = {}
      const writeText = (text: string): void => {
        if (!text) return
        answered = true
        emit({ type: 'token', text: needsBreak ? `\n\n${text}` : text })
        needsBreak = false
      }

      readLines(child, (message) => {
        if (options.signal.aborted) return
        const nested = Boolean(message.parent_tool_use_id)
        switch (message.type) {
          case 'stream_event': {
            if (nested) break
            const event = obj(message.event)
            if (event.type === 'message_start') streamed = false
            if (event.type === 'content_block_delta') {
              const delta = obj(event.delta)
              if (delta.type === 'text_delta') {
                streamed = true
                writeText(str(delta.text))
              }
            }
            if (event.type === 'content_block_stop' && streamed) needsBreak = true
            break
          }
          case 'assistant': {
            const body = obj(message.message)
            if (!nested && body.usage) lastUsage = obj(body.usage)
            for (const block of list(body.content)) {
              // Erros de API também chegam como texto; esses saem pelo resultado.
              const apiError = message.is_api_error_message === true || Boolean(message.error)
              if (block.type === 'text' && !nested && !streamed && !apiError) {
                const local = Boolean(message.local_command_source)
                writeText(local ? commandText(str(block.text)) : str(block.text))
              }
              if (block.type === 'tool_use') {
                const name = str(block.name)
                if (name === 'ToolSearch') continue
                const input = obj(block.input)
                if (/^(Edit|Write|MultiEdit)$/.test(name)) cards.watch(str(block.id), str(input.file_path))
                cards.start(str(block.id), TOOL_LABEL[name] ?? name, explainInput(name, input))
                needsBreak = false // o cartão já separa os textos
              }
            }
            break
          }
          case 'user':
            for (const block of list(obj(message.message).content)) {
              if (block.type === 'tool_result') {
                cards.end(str(block.tool_use_id), block.is_error !== true, textOf(block.content))
              }
            }
            break
          case 'control_request': {
            const request = obj(message.request)
            const reply = (response: Json): void =>
              writeLine(child, {
                type: 'control_response',
                response: { subtype: 'success', request_id: message.request_id, response }
              })
            if (request.subtype !== 'can_use_tool') {
              writeLine(child, {
                type: 'control_response',
                response: { subtype: 'error', request_id: message.request_id, error: 'Não suportado.' }
              })
              break
            }
            const name = str(request.tool_name)
            const input = obj(request.input)
            const callId = str(request.tool_use_id) || randomUUID()
            void cards
              .ask(callId, name, TOOL_LABEL[name] ?? name, explainInput(name, input))
              .then((allowed) =>
                reply(
                  allowed
                    ? { behavior: 'allow', updatedInput: input }
                    : {
                        behavior: 'deny',
                        message: 'O usuário negou a permissão. Não tente de novo; pergunte como ele prefere prosseguir.'
                      }
                )
              )
            break
          }
          case 'result': {
            const errors = Array.isArray(message.errors) ? message.errors.map(String).join('\n') : ''
            const failure = errors || str(message.result) || str(message.subtype)
            if (message.is_error === true) {
              finish(
                resume && /no conversation found/i.test(failure) ? new StaleSession(failure) : new Error(failure)
              )
              break
            }
            const sessionId = str(message.session_id)
            // Rede de segurança: nunca terminar em silêncio se o CLI respondeu algo.
            if (!answered) writeText(commandText(str(message.result)) || 'O Claude terminou sem escrever uma resposta.')
            // Um comando não leva o contexto pendente; a sessão só avança se não havia nenhum.
            const last = options.history[options.history.length - 1]?.content ?? ''
            const pendingContext = (resume?.seen ?? 0) < options.history.length - 1
            if (sessionId && !(isCliCommand(last) && pendingContext)) emit({ type: 'cli-session', agent: 'claude', sessionId })
            const totals = obj(message.usage)
            const promptTokens =
              num(lastUsage.input_tokens) +
              num(lastUsage.cache_creation_input_tokens) +
              num(lastUsage.cache_read_input_tokens)
            const completionTokens = num(totals.output_tokens)
            const windows = Object.values(obj(message.modelUsage)).map((item) => num(obj(item).contextWindow))
            if (promptTokens > 0) {
              emit({
                type: 'usage',
                usage: {
                  promptTokens,
                  completionTokens,
                  totalTokens: promptTokens + completionTokens,
                  contextTokens: Math.max(0, ...windows) || null
                }
              })
            }
            finish()
            break
          }
        }
      })
      // Sessão inexistente pode sair só pelo stderr, sem resultado.
      child.prependListener('close', () => {
        if (resume && /no conversation found/i.test(stderr())) finish(new StaleSession(stderr()))
      })

      const prompt = buildPrompt(options.history, resume?.seen ?? 0)
      writeLine(child, {
        type: 'user',
        message: {
          role: 'user',
          content: [
            ...prompt.images.map((image) => ({
              type: 'image',
              source: { type: 'base64', media_type: image.mime, data: image.data }
            })),
            { type: 'text', text: prompt.text || 'Veja o anexo.' }
          ]
        }
      })
    })
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

// ---------- Cursor, Copilot e Gemini: Agent Client Protocol ----------

const ACP_ARGS: Record<Exclude<CliAgentId, 'claude'>, string[]> = {
  cursor: ['acp'],
  copilot: ['--acp'],
  gemini: ['--experimental-acp']
}

const WRITE_KINDS = new Set(['edit', 'delete', 'move', 'execute'])

async function runAcp(command: string[], options: CliRunOptions, cards: ToolCards): Promise<void> {
  const { agent, emit, resume, signal } = options
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (err: Error) => void }>()
  let nextId = 1
  let sessionId = ''
  let replaying = false
  let cancel = (): void => {}

  await drive(
    [...command, ...ACP_ARGS[agent as Exclude<CliAgentId, 'claude'>]],
    options,
    (child) => {
      cancel()
      setTimeout(() => killTree(child), 800)
    },
    (child, finish) => {
      const call = (method: string, params: Json): Promise<Json> =>
        new Promise((resolve, reject) => {
          const id = nextId++
          pending.set(id, { resolve, reject })
          writeLine(child, { jsonrpc: '2.0', id, method, params })
        })
      cancel = () => {
        if (sessionId) writeLine(child, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
      }

      const toolName = (tool: Json): string => KIND_LABEL[str(tool.kind)] ?? (str(tool.title) || 'Ferramenta')
      const explain = (tool: Json): string => {
        const title = str(tool.title)
        const input = obj(tool.rawInput)
        const detail = Object.keys(input).length > 0 ? explainInput(title, input) : ''
        return [title, detail !== title ? detail : ''].filter(Boolean).join('\n') || toolName(tool)
      }
      const watch = (tool: Json): void => {
        if (!WRITE_KINDS.has(str(tool.kind))) return
        const path =
          str(list(tool.locations)[0]?.path) || str(list(tool.content).find((item) => item.type === 'diff')?.path)
        cards.watch(str(tool.toolCallId), path)
      }
      const settle = (tool: Json): void => {
        if (tool.status === 'completed' || tool.status === 'failed') {
          cards.end(str(tool.toolCallId), tool.status === 'completed', textOf(tool.content))
        }
      }

      const onPermission = async (id: unknown, params: Json): Promise<void> => {
        const tool = obj(params.toolCall)
        const choices = list(params.options)
        const pick = (prefix: string): string =>
          str((choices.find((o) => o.kind === `${prefix}_once`) ?? choices.find((o) => str(o.kind).startsWith(prefix)))?.optionId)
        const callId = str(tool.toolCallId) || randomUUID()
        watch(tool)
        const allowed =
          !options.allowFileWrites && WRITE_KINDS.has(str(tool.kind))
            ? false
            : await cards.ask(callId, str(tool.kind) || str(tool.title) || 'other', toolName(tool), explain(tool))
        const optionId = pick(allowed ? 'allow' : 'reject')
        writeLine(child, {
          jsonrpc: '2.0',
          id,
          result: { outcome: optionId && !signal.aborted ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } }
        })
      }

      readLines(child, (message) => {
        const id = message.id
        if (typeof message.method !== 'string') {
          const waiter = typeof id === 'number' ? pending.get(id) : undefined
          if (!waiter) return
          pending.delete(id as number)
          const error = message.error ? obj(message.error) : null
          if (error) waiter.reject(new Error(`${str(error.message)} ${textOf(error.data)} (${num(error.code)})`))
          else waiter.resolve(obj(message.result))
          return
        }
        const params = obj(message.params)
        if (message.method === 'session/request_permission') {
          void onPermission(id, params)
          return
        }
        if (id !== undefined) {
          writeLine(child, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Método não suportado.' } })
          return
        }
        if (message.method !== 'session/update' || replaying || signal.aborted) return
        const update = obj(params.update)
        if (update.sessionUpdate === 'agent_message_chunk') {
          const text = textOf(update.content)
          if (text) emit({ type: 'token', text })
        } else if (update.sessionUpdate === 'tool_call') {
          watch(update)
          cards.start(str(update.toolCallId), toolName(update), explain(update))
          settle(update)
        } else if (update.sessionUpdate === 'tool_call_update') {
          watch(update)
          settle(update)
        }
      })

      const talk = async (): Promise<void> => {
        const init = await call('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
        })
        const capabilities = obj(init.agentCapabilities)
        const canLoad = capabilities.loadSession === true
        const openSession = async (): Promise<Json> => {
          if (resume && canLoad) {
            replaying = true // o CLI repete a conversa antiga, que já está na tela
            try {
              const loaded = await call('session/load', { sessionId: resume.sessionId, cwd: options.cwd, mcpServers: [] })
              sessionId = resume.sessionId
              return loaded
            } catch (err) {
              if (/auth|-32000/i.test(String(err))) throw err
              throw new StaleSession(String(err))
            } finally {
              replaying = false
            }
          }
          const created = await call('session/new', { cwd: options.cwd, mcpServers: [] })
          sessionId = str(created.sessionId)
          return created
        }
        let opened: Json
        try {
          opened = await openSession()
        } catch (err) {
          const method = list(init.authMethods).find((item) => str(item.id) === 'cursor_login')
          if (!method || err instanceof StaleSession || !/auth|-32000/i.test(String(err))) throw err
          await call('authenticate', { methodId: str(method.id) })
          opened = await openSession()
        }

        if (!options.allowFileWrites) {
          const readOnly = list(obj(opened.modes).availableModes).find((mode) => /(^|[#/])(ask|plan)$/i.test(str(mode.id)))
          if (readOnly) await call('session/set_mode', { sessionId, modeId: str(readOnly.id) })
        }

        const continuing = Boolean(resume && canLoad)
        const prompt = buildPrompt(options.history, continuing ? resume!.seen : 0)
        const rules = options.allowFileWrites
          ? ''
          : 'Modo apenas propor: não altere arquivos nem rode comandos que modifiquem algo.\n\n'
        const text = continuing
          ? `${rules}${prompt.text}`
          : `Instruções do aplicativo:\n${options.systemPrompt}\n\n---\n${prompt.text}`
        const imageOk = obj(capabilities.promptCapabilities).image === true
        const reply = await call('session/prompt', {
          sessionId,
          prompt: [
            ...(imageOk ? prompt.images.map((image) => ({ type: 'image', mimeType: image.mime, data: image.data })) : []),
            { type: 'text', text }
          ]
        })
        if (canLoad) emit({ type: 'cli-session', agent, sessionId })
        if (reply.stopReason === 'refusal') throw new Error('o agente recusou este pedido.')
      }
      talk().then(() => finish(), finish)
    }
  )
}
