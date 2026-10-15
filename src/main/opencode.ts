import type { OpenCodeConfig, OpenCodeFileDiff, OpenCodeModel, OpenCodeNotice, OpenCodePermission } from '../shared/types'

let streamAbort: AbortController | null = null
let streamGeneration = 0

function rootUrl(config: OpenCodeConfig): string {
  return config.url.trim().replace(/\/+$/, '')
}

function authHeaders(config: OpenCodeConfig): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (!config.password) return headers
  const token = Buffer.from(`${config.username || 'opencode'}:${config.password}`, 'utf8').toString('base64')
  headers.authorization = `Basic ${token}`
  return headers
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const data = record.data
    if (data && typeof data === 'object' && typeof (data as Record<string, unknown>).message === 'string') {
      return (data as Record<string, unknown>).message as string
    }
    if (typeof record.message === 'string') return record.message
  }
  if (status === 401) return 'O OpenCode recusou o acesso. Confira usuário e senha.'
  return `O OpenCode respondeu ${status}.`
}

async function request(config: OpenCodeConfig, path: string, init?: RequestInit): Promise<unknown> {
  const url = `${rootUrl(config)}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        ...authHeaders(config),
        'content-type': 'application/json',
        ...(init?.headers ?? {})
      }
    })
  } catch {
    throw new Error(`Não consegui falar com o OpenCode em ${rootUrl(config)}. Ele está rodando?`)
  }
  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = text
    }
  }
  if (!response.ok) throw new Error(errorMessage(body, response.status))
  return body
}

function dataOf(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {}
  const record = body as Record<string, unknown>
  if (record.data && typeof record.data === 'object') return record.data as Record<string, unknown>
  return record
}

export async function openCodeStatus(config: OpenCodeConfig): Promise<{ online: boolean; message: string }> {
  if (!config.url.trim()) return { online: false, message: 'Informe o endereço do OpenCode.' }
  try {
    const body = await request(config, '/api/info')
    const data = dataOf(body)
    const version = typeof data.version === 'string' ? data.version : ''
    return { online: true, message: version ? `Conectado · ${version}` : 'Conectado.' }
  } catch (err) {
    return { online: false, message: err instanceof Error ? err.message : String(err) }
  }
}

function modelFrom(raw: unknown): OpenCodeModel | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const id = typeof item.id === 'string' ? item.id : ''
  const providerID = typeof item.providerID === 'string' ? item.providerID : ''
  if (!id || !providerID) return null
  const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id
  return { id, providerID, name }
}

export async function listOpenCodeModels(
  config: OpenCodeConfig
): Promise<{ models: OpenCodeModel[]; defaultModel: OpenCodeModel | null }> {
  const body = await request(config, '/api/model')
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const list = Array.isArray(record.data) ? record.data : Array.isArray(body) ? body : []
  const models = list.flatMap((item) => {
    const model = modelFrom(item)
    return model ? [model] : []
  })
  let defaultModel: OpenCodeModel | null = null
  try {
    const fallback = await request(config, '/api/model/default')
    const fallbackRecord = fallback && typeof fallback === 'object' ? (fallback as Record<string, unknown>) : {}
    defaultModel = modelFrom(fallbackRecord.data ?? fallback)
  } catch {
    defaultModel = models[0] ?? null
  }
  return { models, defaultModel }
}

export async function switchOpenCodeModel(
  config: OpenCodeConfig,
  sessionID: string,
  model: OpenCodeModel
): Promise<void> {
  await request(config, `/api/session/${encodeURIComponent(sessionID)}/model`, {
    method: 'POST',
    body: JSON.stringify({ model: { id: model.id, providerID: model.providerID } })
  })
}

export async function ensureOpenCodeSession(
  config: OpenCodeConfig,
  input: { sessionID: string | null; directory: string; title: string; model?: OpenCodeModel | null }
): Promise<string> {
  if (input.sessionID) return input.sessionID
  const body = await request(config, '/api/session', {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      location: { directory: input.directory },
      ...(input.model ? { model: { id: input.model.id, providerID: input.model.providerID } } : {})
    })
  })
  const id = dataOf(body).id
  if (typeof id !== 'string' || !id) throw new Error('O OpenCode não devolveu o id da sessão.')
  return id
}

export async function promptOpenCode(config: OpenCodeConfig, sessionID: string, text: string): Promise<void> {
  await request(config, `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ text })
  })
}

export async function interruptOpenCode(config: OpenCodeConfig, sessionID: string): Promise<void> {
  await request(config, `/api/session/${encodeURIComponent(sessionID)}/interrupt`, {
    method: 'POST',
    body: '{}'
  })
}

export async function replyOpenCodePermission(
  config: OpenCodeConfig,
  sessionID: string,
  requestID: string,
  decision: 'once' | 'always' | 'reject'
): Promise<void> {
  await request(
    config,
    `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`,
    {
      method: 'POST',
      body: JSON.stringify({ decision })
    }
  )
}

function fileDiff(raw: unknown): OpenCodeFileDiff | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const file = typeof item.file === 'string' ? item.file : ''
  if (!file) return null
  const status = item.status === 'added' || item.status === 'deleted' || item.status === 'modified' ? item.status : undefined
  return {
    file,
    patch: typeof item.patch === 'string' ? item.patch.slice(0, 20_000) : '',
    additions: typeof item.additions === 'number' ? item.additions : 0,
    deletions: typeof item.deletions === 'number' ? item.deletions : 0,
    ...(status ? { status } : {})
  }
}

export async function openCodeDiff(config: OpenCodeConfig, sessionID: string): Promise<OpenCodeFileDiff[]> {
  const body = await request(config, `/api/session/${encodeURIComponent(sessionID)}/diff`)
  const data = dataOf(body)
  const list = Array.isArray(data.files)
    ? data.files
    : Array.isArray(data.diff)
      ? data.diff
      : Array.isArray(body)
        ? body
        : []
  return list.flatMap((item) => {
    const file = fileDiff(item)
    return file ? [file] : []
  })
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const text = (item as Record<string, unknown>).text
      return typeof text === 'string' ? text : ''
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, 12_000)
}

function noticesFromPayload(payload: unknown): OpenCodeNotice[] {
  if (!payload || typeof payload !== 'object') return []
  const event = payload as Record<string, unknown>
  const type = typeof event.type === 'string' ? event.type : ''
  const properties =
    event.properties && typeof event.properties === 'object' ? (event.properties as Record<string, unknown>) : {}
  const sessionID = typeof properties.sessionID === 'string' ? properties.sessionID : ''

  if (type === 'session.next.text.delta' && sessionID && typeof properties.delta === 'string') {
    return [{ type: 'text-delta', sessionID, delta: properties.delta }]
  }
  if (type === 'message.part.delta' && sessionID && properties.field === 'text' && typeof properties.delta === 'string') {
    return [{ type: 'text-delta', sessionID, delta: properties.delta }]
  }
  if (type === 'session.next.text.ended' && sessionID && typeof properties.text === 'string') {
    return [{ type: 'text-ended', sessionID, text: properties.text }]
  }
  if (type === 'session.next.tool.called' && sessionID) {
    const callID = typeof properties.callID === 'string' ? properties.callID : crypto.randomUUID()
    const name = typeof properties.tool === 'string' ? properties.tool : 'ferramenta'
    return [{ type: 'tool', sessionID, callID, name, state: 'start', detail: '' }]
  }
  if ((type === 'session.next.tool.success' || type === 'session.next.tool.failed') && sessionID) {
    const callID = typeof properties.callID === 'string' ? properties.callID : ''
    const error = properties.error && typeof properties.error === 'object' ? (properties.error as Record<string, unknown>).message : ''
    return [
      {
        type: 'tool',
        sessionID,
        callID,
        name: '',
        state: type.endsWith('success') ? 'ok' : 'fail',
        detail: type.endsWith('success') ? textOf(properties.content) : typeof error === 'string' ? error : 'A ferramenta falhou.'
      }
    ]
  }
  if (type === 'session.next.shell.started' && sessionID) {
    return [
      {
        type: 'shell',
        sessionID,
        callID: typeof properties.callID === 'string' ? properties.callID : crypto.randomUUID(),
        command: typeof properties.command === 'string' ? properties.command : '',
        output: '',
        done: false
      }
    ]
  }
  if (type === 'session.next.shell.ended' && sessionID) {
    return [
      {
        type: 'shell',
        sessionID,
        callID: typeof properties.callID === 'string' ? properties.callID : '',
        command: '',
        output: typeof properties.output === 'string' ? properties.output.slice(0, 12_000) : '',
        done: true
      }
    ]
  }
  if (type === 'permission.asked') {
    const request = properties.id ? properties : null
    const source = request ?? properties
    const id = typeof source.id === 'string' ? source.id : ''
    const owner = typeof source.sessionID === 'string' ? source.sessionID : sessionID
    if (!id || !owner) return []
    const permission = typeof source.permission === 'string' ? source.permission : 'permissão'
    const patterns = Array.isArray(source.patterns) ? source.patterns.filter((item) => typeof item === 'string') : []
    const asked: OpenCodePermission = { id, sessionID: owner, permission, patterns }
    return [{ type: 'permission', request: asked }]
  }
  if (type === 'permission.replied' && sessionID && typeof properties.requestID === 'string') {
    return [{ type: 'permission-cleared', sessionID, requestID: properties.requestID }]
  }
  if (type === 'session.diff' && sessionID && Array.isArray(properties.diff)) {
    return [{ type: 'diff', sessionID, files: properties.diff.flatMap((item) => {
      const file = fileDiff(item)
      return file ? [file] : []
    }) }]
  }
  if (type === 'session.status' && sessionID && properties.status && typeof properties.status === 'object') {
    const status = (properties.status as Record<string, unknown>).type
    if (status === 'idle') return [{ type: 'idle', sessionID }]
    if (status === 'busy') return [{ type: 'busy', sessionID }]
  }
  if (type === 'session.idle' && sessionID) return [{ type: 'idle', sessionID }]
  if (type === 'session.next.step.ended' && sessionID && properties.tokens && typeof properties.tokens === 'object') {
    const tokens = properties.tokens as Record<string, unknown>
    const input = typeof tokens.input === 'number' ? tokens.input : 0
    const output = typeof tokens.output === 'number' ? tokens.output : 0
    return [{ type: 'usage', sessionID, input, output }]
  }
  if (type === 'session.next.step.failed' && sessionID) {
    const error = properties.error && typeof properties.error === 'object' ? (properties.error as Record<string, unknown>).message : ''
    return [{ type: 'error', sessionID, message: typeof error === 'string' && error ? error : 'O OpenCode interrompeu este passo.' }]
  }
  if (type === 'session.error') {
    const error = properties.error && typeof properties.error === 'object' ? (properties.error as Record<string, unknown>) : null
    const data = error?.data && typeof error.data === 'object' ? (error.data as Record<string, unknown>) : null
    const message = typeof data?.message === 'string' ? data.message : 'O OpenCode encontrou um erro.'
    return [{ type: 'error', sessionID, message }]
  }
  return []
}

function blocksToNotices(chunk: string): { notices: OpenCodeNotice[]; rest: string } {
  const normalized = chunk.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const rest = parts.pop() ?? ''
  const notices: OpenCodeNotice[] = []
  for (const part of parts) {
    const data = part
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')
    if (!data) continue
    try {
      notices.push(...noticesFromPayload(JSON.parse(data) as unknown))
    } catch {
      // um bloco incompleto ou de outro formato não derruba o fluxo
    }
  }
  return { notices, rest }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

/** Mantém o fluxo de eventos do OpenCode e reconecta se a ligação cair. */
export function startOpenCodeStream(config: OpenCodeConfig, onNotice: (notice: OpenCodeNotice) => void): void {
  streamAbort?.abort()
  const generation = ++streamGeneration
  const controller = new AbortController()
  streamAbort = controller
  if (!config.url.trim()) {
    onNotice({ type: 'status', online: false, message: 'Informe o endereço do OpenCode.' })
    return
  }
  void (async () => {
    let delay = 1000
    while (!controller.signal.aborted && generation === streamGeneration) {
      try {
        const response = await fetch(`${rootUrl(config)}/api/event`, {
          headers: { ...authHeaders(config), accept: 'text/event-stream' },
          signal: controller.signal
        })
        if (response.status === 401) {
          onNotice({ type: 'status', online: false, message: 'O OpenCode recusou o acesso. Confira usuário e senha.' })
          await sleep(15_000, controller.signal)
          continue
        }
        if (!response.ok || !response.body) {
          throw new Error(`O fluxo de eventos respondeu ${response.status}.`)
        }
        onNotice({ type: 'status', online: true, message: 'Conectado.' })
        delay = 1000
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let pending = ''
        while (!controller.signal.aborted) {
          const read = await reader.read()
          if (read.done) break
          pending += decoder.decode(read.value, { stream: true })
          const parsed = blocksToNotices(pending)
          pending = parsed.rest
          for (const notice of parsed.notices) onNotice(notice)
        }
      } catch (err) {
        if (controller.signal.aborted || generation !== streamGeneration) return
        const message = err instanceof Error ? err.message : String(err)
        onNotice({
          type: 'status',
          online: false,
          message: message.includes('fetch') ? `Não consegui falar com o OpenCode em ${rootUrl(config)}.` : message
        })
      }
      await sleep(delay, controller.signal)
      delay = Math.min(delay * 2, 15_000)
    }
  })()
}

export function stopOpenCodeStream(): void {
  streamAbort?.abort()
  streamAbort = null
}
