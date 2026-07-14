// Sincronização de conversas com o Open WebUI via API REST.
// O Open WebUI guarda cada chat como um JSON com lista linear (messages)
// e uma árvore (history.messages) encadeada por parentId.

import { randomUUID } from 'crypto'
import type { RemoteChatStub, SyncMessage, SyncPushPayload } from '../shared/types'

/** Credenciais para falar com o Open WebUI: token JWT da sessão ou chave de API. */
export interface OwuiAuth {
  url: string
  token: string
}

function base(cfg: OwuiAuth): string {
  return cfg.url.replace(/\/+$/, '')
}

function headers(cfg: OwuiAuth): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.token}`
  }
}

async function request(cfg: OwuiAuth, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${base(cfg)}${path}`, { ...init, headers: headers(cfg) })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Open WebUI respondeu ${response.status} em ${path}: ${body.slice(0, 200)}`)
  }
  return response.json()
}

export async function owuiListChats(cfg: OwuiAuth): Promise<RemoteChatStub[]> {
  const data = (await request(cfg, '/api/v1/chats/')) as Array<{
    id: string
    title: string
    updated_at: number
  }>
  return data.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updated_at }))
}

export async function owuiPullChat(
  cfg: OwuiAuth,
  id: string
): Promise<{ title: string; messages: SyncMessage[] }> {
  const data = (await request(cfg, `/api/v1/chats/${id}`)) as {
    title?: string
    chat?: {
      title?: string
      messages?: Array<{ role?: string; content?: unknown }>
    }
  }
  const messages = (data.chat?.messages ?? [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }))
  return { title: data.chat?.title ?? data.title ?? 'Conversa importada', messages }
}

export async function owuiDeleteChat(cfg: OwuiAuth, id: string): Promise<void> {
  await request(cfg, `/api/v1/chats/${id}`, { method: 'DELETE' })
}

/** Cria ou atualiza um chat no Open WebUI; retorna o id remoto. */
export async function owuiPushChat(cfg: OwuiAuth, payload: SyncPushPayload): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const ids = payload.messages.map(() => randomUUID())

  const historyMessages: Record<string, unknown> = {}
  const linear: unknown[] = []
  payload.messages.forEach((m, i) => {
    const entry = {
      id: ids[i],
      parentId: i > 0 ? ids[i - 1] : null,
      childrenIds: i < ids.length - 1 ? [ids[i + 1]] : [],
      role: m.role,
      content: m.content,
      timestamp: now,
      ...(m.role === 'assistant'
        ? { model: payload.model, modelName: payload.model, done: true }
        : { models: [payload.model] })
    }
    historyMessages[ids[i]] = entry
    linear.push(entry)
  })

  const chat = {
    title: payload.title,
    models: [payload.model],
    messages: linear,
    history: { messages: historyMessages, currentId: ids[ids.length - 1] ?? null }
  }

  if (payload.owuiId) {
    await request(cfg, `/api/v1/chats/${payload.owuiId}`, {
      method: 'POST',
      body: JSON.stringify({ chat })
    })
    return payload.owuiId
  }

  const created = (await request(cfg, '/api/v1/chats/new', {
    method: 'POST',
    body: JSON.stringify({ chat })
  })) as { id: string }
  return created.id
}
