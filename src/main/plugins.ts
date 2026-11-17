import type { McpServerConfig, PluginCatalogResult, PluginItem } from '../shared/types'

function normalizeServerUrl(raw?: string): string {
  let url = (raw ?? '').trim()
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  return url.replace(/\/+$/, '')
}

function normalizePlugin(entry: unknown): PluginItem | null {
  if (!entry || typeof entry !== 'object') return null
  const obj = entry as Record<string, unknown>
  const id = typeof obj.id === 'string' ? obj.id.trim() : ''
  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  if (!id || !name) return null
  const description = typeof obj.description === 'string' ? obj.description.trim() : ''
  const version = typeof obj.version === 'string' && obj.version.trim() ? obj.version.trim() : '1.0.0'
  const author = typeof obj.author === 'string' && obj.author.trim() ? obj.author.trim() : undefined
  const category = typeof obj.category === 'string' && obj.category.trim() ? obj.category.trim() : undefined

  let mcp: PluginItem['mcp']
  if (obj.mcp && typeof obj.mcp === 'object') {
    const rawMcp = obj.mcp as Record<string, unknown>
    const command = typeof rawMcp.command === 'string' ? rawMcp.command.trim() : ''
    const args = Array.isArray(rawMcp.args)
      ? rawMcp.args.filter((item): item is string => typeof item === 'string')
      : []
    if (command) {
      mcp = { command, args }
    }
  }

  return {
    id,
    name,
    description,
    version,
    ...(author ? { author } : {}),
    ...(category ? { category } : {}),
    ...(mcp ? { mcp } : {})
  }
}

/**
 * Consulta o servidor de plugins configurado pelo usuário.
 * Aceita respostas no formato `{ plugins: [...] }` ou `[...]` em `/plugins`, `/plugins.json` ou na raiz da URL.
 */
export async function fetchPluginsCatalog(rawUrl?: string): Promise<PluginCatalogResult> {
  const base = normalizeServerUrl(rawUrl)
  if (!base) {
    return {
      online: false,
      message: 'Nenhum servidor de plugins configurado ainda. Informe a URL do servidor quando estiver no ar.',
      plugins: []
    }
  }

  const endpoints = [`${base}/plugins`, `${base}/plugins.json`, base]
  let lastError = ''

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000)
      })
      if (!response.ok) {
        lastError = `Servidor respondeu com status ${response.status}.`
        continue
      }
      const data = (await response.json()) as unknown
      const list = Array.isArray(data)
        ? data
        : data && typeof data === 'object' && Array.isArray((data as { plugins?: unknown }).plugins)
          ? (data as { plugins: unknown[] }).plugins
          : null
      if (!list) {
        lastError = 'Formato de catálogo inválido retornado pelo servidor.'
        continue
      }
      const plugins = list.map(normalizePlugin).filter((item): item is PluginItem => item !== null)
      return {
        online: true,
        message:
          plugins.length === 0
            ? 'Servidor conectado · nenhum plugin publicado no catálogo ainda.'
            : `Servidor conectado · ${plugins.length} plugin${plugins.length === 1 ? '' : 's'} disponível${plugins.length === 1 ? '' : 'is'}.`,
        plugins
      }
    } catch (err) {
      lastError =
        err instanceof Error
          ? err.message
          : 'Não foi possível conectar ao servidor de plugins.'
    }
  }

  return {
    online: false,
    message: `Não foi possível conectar ao servidor (${base}): ${lastError}`,
    plugins: []
  }
}

/** Converte plugins instalados e habilitados que possuem configuração MCP em servidores MCP ativos. */
export function pluginMcpServers(installed: PluginItem[] | undefined): McpServerConfig[] {
  if (!Array.isArray(installed)) return []
  return installed
    .filter((plugin) => plugin.enabled !== false && plugin.mcp?.command)
    .map((plugin) => ({
      id: `plugin-${plugin.id}`,
      name: `Plugin: ${plugin.name}`,
      command: plugin.mcp!.command,
      args: plugin.mcp!.args ?? [],
      ...(plugin.mcp!.env ? { env: plugin.mcp!.env } : {}),
      enabled: true
    }))
}
