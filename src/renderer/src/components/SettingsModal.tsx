import { useState } from 'react'
import type { AppSettings, McpServerConfig, McpServerStatus, ProviderConfig } from '../../../shared/types'
import { Plus, Brain, Plug, MessageSquare, Search, Key, Sparkles, X } from 'lucide-react'

type Tab = 'modelos' | 'mcp' | 'comportamento' | 'sync'

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/'

export function SettingsModal({
  settings,
  mcpStatus,
  onClose,
  onSave
}: {
  settings: AppSettings
  mcpStatus: McpServerStatus[]
  onClose: () => void
  onSave: (settings: AppSettings) => Promise<void>
}): JSX.Element {
  const [draft, setDraft] = useState<AppSettings>(() => structuredClone(settings))
  const [tab, setTab] = useState<Tab>('modelos')
  const [saving, setSaving] = useState(false)
  const [modelSuggestions, setModelSuggestions] = useState<Record<string, string[]>>({})

  const updateProvider = (id: string, patch: Partial<ProviderConfig>): void => {
    setDraft((d) => ({
      ...d,
      providers: d.providers.map((p) => (p.id === id ? { ...p, ...patch } : p))
    }))
  }

  const updateServer = (id: string, patch: Partial<McpServerConfig>): void => {
    setDraft((d) => ({
      ...d,
      mcpServers: d.mcpServers.map((s) => (s.id === id ? { ...s, ...patch } : s))
    }))
  }

  const addProvider = (): void => {
    const id = crypto.randomUUID()
    setDraft((d) => ({
      ...d,
      activeProviderId: d.activeProviderId ?? id,
      providers: [
        ...d.providers,
        { id, name: 'Novo provedor', baseURL: 'http://localhost:11434/v1', apiKey: '', model: '' }
      ]
    }))
  }

  const addGemini = (): void => {
    const proId = crypto.randomUUID()
    setDraft((d) => ({
      ...d,
      activeProviderId: d.activeProviderId ?? proId,
      providers: [
        ...d.providers,
        {
          id: proId,
          name: 'Gemini Pro (Google)',
          baseURL: GEMINI_BASE_URL,
          apiKey: '',
          model: 'gemini-2.5-pro'
        },
        {
          id: crypto.randomUUID(),
          name: 'Gemini Flash (Google)',
          baseURL: GEMINI_BASE_URL,
          apiKey: '',
          model: 'gemini-2.5-flash'
        }
      ]
    }))
  }

  const addServer = (): void => {
    setDraft((d) => ({
      ...d,
      mcpServers: [
        ...d.mcpServers,
        {
          id: crypto.randomUUID(),
          name: 'Novo servidor MCP',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users'],
          enabled: false
        }
      ]
    }))
  }

  const fetchModels = async (providerId: string): Promise<void> => {
    const models = await window.api.listModels(providerId)
    setModelSuggestions((prev) => ({ ...prev, [providerId]: models }))
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave(draft)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Configurações</h2>
          <button className="ghost" onClick={onClose} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={18} />
          </button>
        </div>

        <nav className="tabs">
          <button className={tab === 'modelos' ? 'active' : ''} onClick={() => setTab('modelos')} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Brain size={14} /> Modelos
          </button>
          <button className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Plug size={14} /> MCP e plugins
          </button>
          <button
            className={tab === 'comportamento' ? 'active' : ''}
            onClick={() => setTab('comportamento')}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <MessageSquare size={14} /> Comportamento
          </button>
          <button
            className={tab === 'sync' ? 'active' : ''}
            onClick={() => setTab('sync')}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            🌐 Sincronizar
          </button>
        </nav>

        <div className="modal-body">
          {tab === 'modelos' && (
            <>
              <p className="help">
                Qualquer endpoint compatível com a API da OpenAI funciona: Ollama local
                (http://localhost:11434/v1), vLLM, LM Studio, OpenRouter, OpenAI, etc.
              </p>
              {draft.providers.map((p) => (
                <div className="card" key={p.id}>
                  <div className="card-row">
                    <label>
                      Nome
                      <input
                        value={p.name}
                        onChange={(e) => updateProvider(p.id, { name: e.target.value })}
                      />
                    </label>
                    <label>
                      Modelo
                      <input
                        value={p.model}
                        list={`models-${p.id}`}
                        placeholder="ex.: meu-modelo"
                        onChange={(e) => updateProvider(p.id, { model: e.target.value })}
                      />
                      <datalist id={`models-${p.id}`}>
                        {(modelSuggestions[p.id] ?? []).map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    </label>
                  </div>
                  <div className="card-row">
                    <label>
                      URL base
                      <input
                        value={p.baseURL}
                        onChange={(e) => updateProvider(p.id, { baseURL: e.target.value })}
                      />
                    </label>
                    <label>
                      Chave de API (opcional para servidores locais)
                      <input
                        type="password"
                        value={p.apiKey}
                        onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })}
                      />
                    </label>
                  </div>
                  {p.baseURL.includes('generativelanguage.googleapis.com') && (
                    <p className="help">
                      <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><Key size={14} /> Crie a chave</strong> gratuitamente com a sua conta Google em{' '}
                      <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                        aistudio.google.com/apikey
                      </a>{' '}
                      e cole no campo acima. Depois use <em>Buscar modelos disponíveis</em> para
                      listar os Gemini liberados para a sua conta.
                    </p>
                  )}
                  <div className="card-actions">
                    <label className="radio">
                      <input
                        type="radio"
                        name="active-provider"
                        checked={draft.activeProviderId === p.id}
                        onChange={() => setDraft((d) => ({ ...d, activeProviderId: p.id }))}
                      />
                      Usar este modelo
                    </label>
                    <button className="ghost" onClick={() => void fetchModels(p.id)} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Search size={14} /> Buscar modelos disponíveis
                    </button>
                    <button
                      className="danger"
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          providers: d.providers.filter((x) => x.id !== p.id),
                          activeProviderId:
                            d.activeProviderId === p.id
                              ? (d.providers.find((x) => x.id !== p.id)?.id ?? null)
                              : d.activeProviderId
                        }))
                      }
                    >
                      Remover
                    </button>
                  </div>
                  {modelSuggestions[p.id]?.length === 0 && (
                    <p className="help warn">
                      Nenhum modelo encontrado — verifique se o servidor está rodando nessa URL.
                    </p>
                  )}
                </div>
              ))}
              <div className="add-row">
                <button className="add" onClick={addProvider} style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }}>
                  <Plus size={16} /> Adicionar provedor
                </button>
                <button className="add" onClick={addGemini} style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }}>
                  <Sparkles size={16} /> Adicionar Gemini Pro + Flash (Google)
                </button>
              </div>
            </>
          )}

          {tab === 'mcp' && (
            <>
              <p className="help">
                Servidores MCP dão ferramentas ao modelo (arquivos, web, bancos de dados…). Informe
                o comando que inicia o servidor — por exemplo,{' '}
                <code>npx -y @modelcontextprotocol/server-filesystem /Users/voce</code>.
              </p>
              {draft.mcpServers.map((s) => {
                const status = mcpStatus.find((st) => st.id === s.id)
                return (
                  <div className="card" key={s.id}>
                    <div className="card-row">
                      <label>
                        Nome
                        <input
                          value={s.name}
                          onChange={(e) => updateServer(s.id, { name: e.target.value })}
                        />
                      </label>
                      <label>
                        Comando
                        <input
                          value={s.command}
                          onChange={(e) => updateServer(s.id, { command: e.target.value })}
                        />
                      </label>
                    </div>
                    <label>
                      Argumentos (separados por espaço)
                      <input
                        value={s.args.join(' ')}
                        onChange={(e) =>
                          updateServer(s.id, {
                            args: e.target.value.split(' ').filter(Boolean)
                          })
                        }
                      />
                    </label>
                    <div className="card-actions">
                      <label className="radio">
                        <input
                          type="checkbox"
                          checked={s.enabled}
                          onChange={(e) => updateServer(s.id, { enabled: e.target.checked })}
                        />
                        Habilitado
                      </label>
                      {status?.connected && (
                        <span className="status ok">
                          ● conectado · {status.tools.length} ferramenta
                          {status.tools.length === 1 ? '' : 's'}
                        </span>
                      )}
                      {status?.error && <span className="status err">● erro: {status.error}</span>}
                      <button
                        className="danger"
                        onClick={() =>
                          setDraft((d) => ({
                            ...d,
                            mcpServers: d.mcpServers.filter((x) => x.id !== s.id)
                          }))
                        }
                      >
                        Remover
                      </button>
                    </div>
                    {status && status.tools.length > 0 && (
                      <p className="help">
                        Ferramentas: {status.tools.map((t) => t.name).join(', ')}
                      </p>
                    )}
                  </div>
                )
              })}
              <button className="add" onClick={addServer} style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }}>
                <Plus size={16} /> Adicionar servidor MCP
              </button>

              {Object.keys(draft.toolPermissions).length > 0 && (
                <div className="card">
                  <strong>Permissões sempre concedidas</strong>
                  <p className="help">
                    Estas ferramentas rodam sem pedir confirmação. Revogue para voltar a ser
                    perguntado.
                  </p>
                  {Object.keys(draft.toolPermissions).map((toolKey) => (
                    <div className="perm-row" key={toolKey}>
                      <code>{toolKey.replace('__', ' → ')}</code>
                      <button
                        className="danger"
                        onClick={() =>
                          setDraft((d) => {
                            const next = { ...d.toolPermissions }
                            delete next[toolKey]
                            return { ...d, toolPermissions: next }
                          })
                        }
                      >
                        Revogar
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'comportamento' && (
            <>
              <div className="card">
                <label>
                  Seu nome (exibido no menu lateral)
                  <input
                    value={draft.userName}
                    onChange={(e) => setDraft((d) => ({ ...d, userName: e.target.value }))}
                  />
                </label>
              </div>
              <p className="help">
                Instruções que acompanham toda conversa. É aqui que você define o tom “humanizado”
                das respostas do modelo.
              </p>
              <textarea
                className="system-prompt"
                rows={10}
                value={draft.systemPrompt}
                onChange={(e) => setDraft((d) => ({ ...d, systemPrompt: e.target.value }))}
              />
            </>
          )}

          {tab === 'sync' && (
            <>
              <p className="help">
                Sincroniza suas conversas com o Open WebUI: ao terminar cada resposta, a conversa é
                enviada para lá, e as conversas do servidor aparecem no menu lateral para importar.
              </p>
              <div className="card">
                <label className="radio">
                  <input
                    type="checkbox"
                    checked={draft.openWebUi.enabled}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        openWebUi: { ...d.openWebUi, enabled: e.target.checked }
                      }))
                    }
                  />
                  Ativar sincronização
                </label>
                <label>
                  URL do Open WebUI
                  <input
                    value={draft.openWebUi.url}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, openWebUi: { ...d.openWebUi, url: e.target.value } }))
                    }
                  />
                </label>
                <label>
                  Chave de API
                  <input
                    type="password"
                    value={draft.openWebUi.apiKey}
                    placeholder="sk-…"
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        openWebUi: { ...d.openWebUi, apiKey: e.target.value }
                      }))
                    }
                  />
                </label>
                <p className="help">
                  🔑 Para gerar a chave: no Open WebUI, clique no seu nome (canto inferior esquerdo)
                  → <em>Configurações</em> → <em>Conta</em> → <em>Chaves de API</em> →{' '}
                  <em>Criar nova chave secreta</em>, e cole aqui.
                </p>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="send" onClick={() => void save()} disabled={saving}>
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  )
}
