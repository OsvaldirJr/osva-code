import { createServer, type Server } from 'http'
import type { AppSettings, AutomationHookEvent, AutomationHookSource } from '../shared/types'
import { AUTOMATION_HOOK_PORT } from '../shared/types'

const MAX_BODY = 48_000

function summarize(source: AutomationHookSource, raw: string): string {
  let data: unknown = null
  try {
    data = JSON.parse(raw)
  } catch {
    data = null
  }
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  let title = ''
  if (source === 'github' && record) {
    const repo = record.repository as Record<string, unknown> | undefined
    const pr = record.pull_request as Record<string, unknown> | undefined
    const issue = record.issue as Record<string, unknown> | undefined
    title = [text(record.action), text(repo?.full_name), text(pr?.title || issue?.title)].filter(Boolean).join(' · ')
  } else if (source === 'slack' && record) {
    const event = record.event as Record<string, unknown> | undefined
    title = [text(event?.type || record.type), text(event?.text)].filter(Boolean).join(' · ')
  } else if (source === 'sentry' && record) {
    const issue = (record.data as Record<string, unknown> | undefined)?.issue as Record<string, unknown> | undefined
    title = [text(record.action), text(issue?.title)].filter(Boolean).join(' · ')
  } else if (source === 'linear' && record) {
    const payload = record.data as Record<string, unknown> | undefined
    title = [text(record.action || record.type), text(payload?.title)].filter(Boolean).join(' · ')
  } else if (source === 'pagerduty' && record) {
    const incident = (record.event as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined
    title = [text(record.event_type), text((incident?.incident as Record<string, unknown> | undefined)?.title)].filter(Boolean).join(' · ')
  } else if (source === 'teams' && record) {
    title = text(record.text || record.summary)
  }
  const clipped = raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw
  return title ? `${title}\n\n${clipped}` : clipped
}

export function startAutomationHooks(
  getSettings: () => AppSettings,
  emit: (event: AutomationHookEvent) => void
): Promise<number> {
  const server: Server = createServer((request, response) => {
    const finish = (status: number, body: Record<string, unknown>): void => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.method !== 'POST') {
      finish(405, { ok: false })
      return
    }
    const token = (request.url ?? '').split('?')[0].replace(/^\/hooks\//, '').replace(/\/$/, '')
    if (!token || token.includes('/')) {
      finish(404, { ok: false })
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_BODY) chunks.push(chunk)
    })
    request.on('end', () => {
      const settings = getSettings()
      const found = (settings.automations ?? []).flatMap((automation) =>
        (automation.triggers ?? [])
          .filter((trigger) => trigger.kind === 'hook' && trigger.token === token && trigger.source)
          .map((trigger) => ({ automation, trigger }))
      )[0]
      if (!found?.trigger.source) {
        finish(404, { ok: false })
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      if (found.trigger.source === 'slack') {
        try {
          const parsed = JSON.parse(raw) as { type?: string; challenge?: string }
          if (parsed.type === 'url_verification' && typeof parsed.challenge === 'string') {
            finish(200, { challenge: parsed.challenge })
            return
          }
        } catch {
          // corpo comum segue para a automatização
        }
      }
      if (found.trigger.source === 'github' && request.headers['x-github-event'] === 'ping') {
        finish(200, { ok: true })
        return
      }
      if (found.automation.enabled === false) {
        finish(409, { ok: false, error: 'Automatização inativa' })
        return
      }
      const body = raw.slice(0, 2000)
      emit({
        automationId: found.automation.id,
        triggerId: found.trigger.id,
        source: found.trigger.source,
        summary: summarize(found.trigger.source, body || '(sem corpo)')
      })
      finish(200, { ok: true })
    })
  })

  return new Promise((resolve, reject) => {
    const tryListen = (port: number): void => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && port < AUTOMATION_HOOK_PORT + 10) {
          tryListen(port + 1)
          return
        }
        reject(error)
      })
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error')
        resolve(port)
      })
    }
    tryListen(AUTOMATION_HOOK_PORT)
  })
}
