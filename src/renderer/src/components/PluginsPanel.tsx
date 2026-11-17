import { useEffect, useState } from 'react'
import { Check, Download, Plug, RefreshCw, Search, Server, Trash2 } from 'lucide-react'
import type { PluginItem, PluginsConfig } from '../../../shared/types'

export function PluginsPanel({
  config,
  onSaveConfig
}: {
  config: PluginsConfig
  onSaveConfig: (next: PluginsConfig) => void
}): JSX.Element {
  const [serverUrl, setServerUrl] = useState(config.serverUrl ?? '')
  const [tab, setTab] = useState<'catalog' | 'installed'>('catalog')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [catalog, setCatalog] = useState<PluginItem[]>([])
  const [statusMessage, setStatusMessage] = useState<string>(
    config.serverUrl?.trim()
      ? ''
      : 'Por enquanto não temos nenhum plugin disponível. Quando o servidor de plugins estiver no ar, informe o endereço abaixo.'
  )
  const [online, setOnline] = useState<boolean | null>(null)

  useEffect(() => {
    setServerUrl(config.serverUrl ?? '')
  }, [config.serverUrl])

  const syncCatalog = async (urlToFetch?: string): Promise<void> => {
    const targetUrl = (urlToFetch ?? serverUrl).trim()
    if (targetUrl !== (config.serverUrl ?? '')) {
      onSaveConfig({ ...config, serverUrl: targetUrl })
    }
    if (!targetUrl) {
      setCatalog([])
      setOnline(null)
      setStatusMessage(
        'Por enquanto não temos nenhum plugin disponível. Quando o servidor de plugins estiver no ar, informe o endereço acima.'
      )
      return
    }
    setLoading(true)
    try {
      const result = await window.api.fetchPluginsCatalog(targetUrl)
      setCatalog(result.plugins)
      setOnline(result.online)
      setStatusMessage(result.message)
    } catch (err) {
      setOnline(false)
      setStatusMessage(err instanceof Error ? err.message : 'Erro ao consultar o servidor de plugins.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (config.serverUrl?.trim()) {
      void syncCatalog(config.serverUrl)
    }
  }, [])

  const installed = config.installed ?? []
  const installedIds = new Set(installed.map((item) => item.id))

  const installPlugin = (plugin: PluginItem): void => {
    if (installedIds.has(plugin.id)) return
    onSaveConfig({
      ...config,
      serverUrl: serverUrl.trim(),
      installed: [...installed, { ...plugin, enabled: true }]
    })
  }

  const togglePlugin = (id: string): void => {
    onSaveConfig({
      ...config,
      installed: installed.map((item) =>
        item.id === id ? { ...item, enabled: item.enabled === false ? true : false } : item
      )
    })
  }

  const removePlugin = (id: string): void => {
    onSaveConfig({
      ...config,
      installed: installed.filter((item) => item.id !== id)
    })
  }

  const query = search.trim().toLowerCase()
  const filterItem = (item: PluginItem): boolean => {
    if (!query) return true
    return (
      item.name.toLowerCase().includes(query) ||
      item.description.toLowerCase().includes(query) ||
      (item.category?.toLowerCase().includes(query) ?? false) ||
      (item.author?.toLowerCase().includes(query) ?? false)
    )
  }

  const visibleCatalog = catalog.filter(filterItem)
  const visibleInstalled = installed.filter(filterItem)

  return (
    <div className="automations plugins-panel">
      <div className="auto-list-header">
        <div>
          <h1>Plugins</h1>
          <p>
            Estenda o OsvaCode com plugins e ferramentas externas. Conecte o servidor de plugins quando ele estiver no ar.
          </p>
        </div>
      </div>

      <div className="card plugins-server-card">
        <div className="plugins-server-head">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
            <Server size={15} /> Servidor de plugins
          </span>
          {online !== null && (
            <span className={`status ${online ? 'ok' : 'err'}`}>
              ● {online ? 'conectado' : 'indisponível'}
            </span>
          )}
        </div>
        <div className="plugins-server-row">
          <input
            value={serverUrl}
            placeholder="https://plugins.seudominio.com (futuro servidor de plugins)"
            onChange={(e) => setServerUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void syncCatalog()
            }}
          />
          <button
            type="button"
            className="ghost"
            disabled={loading}
            onClick={() => void syncCatalog()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            {loading ? 'Consultando…' : 'Sincronizar catálogo'}
          </button>
        </div>
        {statusMessage && <p className="help">{statusMessage}</p>}
      </div>

      <div className="plugins-toolbar">
        <div className="auto-tabs">
          <button
            type="button"
            className={tab === 'catalog' ? 'active' : ''}
            onClick={() => setTab('catalog')}
          >
            Catálogo ({catalog.length})
          </button>
          <button
            type="button"
            className={tab === 'installed' ? 'active' : ''}
            onClick={() => setTab('installed')}
          >
            Instalados ({installed.length})
          </button>
        </div>

        <div className="project-search plugins-search">
          <Search size={13} />
          <input
            value={search}
            placeholder="Pesquisar plugins…"
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button type="button" className="project-search-clear" onClick={() => setSearch('')}>
              ✕
            </button>
          )}
        </div>
      </div>

      {tab === 'catalog' ? (
        visibleCatalog.length === 0 ? (
          <div className="plugins-empty-box">
            <Plug size={28} />
            <strong>Nenhum plugin disponível por enquanto</strong>
            <p>
              {query
                ? 'Nenhum plugin do catálogo corresponde à sua busca.'
                : 'Ainda não temos plugins publicados. No futuro, quando o servidor de plugins subir, informe a URL acima e clique em Sincronizar catálogo para listar e instalar plugins.'}
            </p>
          </div>
        ) : (
          <ul className="auto-list">
            {visibleCatalog.map((plugin) => {
              const isInstalled = installedIds.has(plugin.id)
              return (
                <li key={plugin.id} className="plugin-item">
                  <div className="auto-list-open">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <strong>{plugin.name}</strong>
                      <span className="plugin-badge">v{plugin.version}</span>
                      {plugin.category && <span className="plugin-badge">{plugin.category}</span>}
                      {plugin.mcp && <span className="plugin-badge accent">MCP</span>}
                    </div>
                    <span>{plugin.description || 'Sem descrição.'}</span>
                    {plugin.author && <span className="plugin-author">Por {plugin.author}</span>}
                  </div>
                  {isInstalled ? (
                    <span className="plugin-installed-pill">
                      <Check size={14} /> Instalado
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => installPlugin(plugin)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}
                    >
                      <Download size={14} /> Instalar
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )
      ) : visibleInstalled.length === 0 ? (
        <div className="plugins-empty-box">
          <Plug size={28} />
          <strong>Nenhum plugin instalado</strong>
          <p>
            {query
              ? 'Nenhum plugin instalado corresponde à sua busca.'
              : 'Por enquanto você não tem nenhum plugin instalado. Assim que o servidor de plugins estiver disponível, instale pelo Catálogo.'}
          </p>
        </div>
      ) : (
        <ul className="auto-list">
          {visibleInstalled.map((plugin) => {
            const on = plugin.enabled !== false
            return (
              <li key={plugin.id} className="plugin-item">
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  title={on ? 'Plugin ativo' : 'Plugin desativado'}
                  className={`auto-switch ${on ? 'on' : ''}`}
                  onClick={() => togglePlugin(plugin.id)}
                >
                  <span />
                </button>
                <div className="auto-list-open">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <strong>{plugin.name}</strong>
                    <span className="plugin-badge">v{plugin.version}</span>
                    {plugin.mcp && <span className="plugin-badge accent">MCP</span>}
                  </div>
                  <span>{plugin.description || 'Sem descrição.'}</span>
                </div>
                <button
                  type="button"
                  className="ghost icon"
                  title="Remover plugin"
                  onClick={() => removePlugin(plugin.id)}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
