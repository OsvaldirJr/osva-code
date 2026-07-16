import { useState } from 'react'
import type { AppSettings, AuthUser, McpServerStatus, RemoteChatStub } from '../../../shared/types'
import { shortPath, conversationKind, type Conversation, type ConversationKind } from '../App'
import { Plus, Folder, Trash2, Plug, Settings, X, LogOut, MessageSquare, Code2 } from 'lucide-react'

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  const first = parts[0]?.[0] ?? '?'
  const last = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return (first + last).toUpperCase()
}

function formatWhen(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  if (sameDay) {
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

export function Sidebar({
  user,
  onLogout,
  settings,
  mcpStatus,
  conversations,
  activeId,
  generatingId,
  tab,
  onTabChange,
  naming,
  namingFolder,
  remoteChats,
  onImportRemote,
  onSelect,
  onNew,
  onConfirmNew,
  onCancelNew,
  onDelete,
  onChangeProvider,
  onOpenSettings
}: {
  user: AuthUser
  onLogout: () => void
  settings: AppSettings
  mcpStatus: McpServerStatus[]
  conversations: Conversation[]
  activeId: string | null
  generatingId: string | null
  tab: ConversationKind
  onTabChange: (tab: ConversationKind) => void
  naming: boolean
  namingFolder: string | null
  remoteChats: RemoteChatStub[]
  onImportRemote: (remote: RemoteChatStub) => void
  onSelect: (id: string) => void
  onNew: () => void
  onConfirmNew: (name: string) => void
  onCancelNew: () => void
  onDelete: (id: string) => void
  onChangeProvider: (providerId: string) => void
  onOpenSettings: () => void
}): JSX.Element {
  const [newName, setNewName] = useState('')
  const connectedTools = mcpStatus.reduce((sum, s) => sum + s.tools.length, 0)
  // só as conversas da aba atual
  const sorted = conversations
    .filter((c) => conversationKind(c) === tab)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  // conversas do Open WebUI que ainda não existem localmente (só na aba Chat)
  const importable = remoteChats.filter((r) => !conversations.some((c) => c.owuiId === r.id))

  const confirm = (): void => {
    onConfirmNew(newName)
    setNewName('')
  }
  const cancel = (): void => {
    onCancelNew()
    setNewName('')
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-dot" />
        OsvaCode
      </div>

      <div className="sidebar-tabs">
        <button
          className={tab === 'chat' ? 'active' : ''}
          onClick={() => onTabChange('chat')}
        >
          <MessageSquare size={14} /> Chat
        </button>
        <button
          className={tab === 'dev' ? 'active' : ''}
          onClick={() => onTabChange('dev')}
        >
          <Code2 size={14} /> DevMode
        </button>
      </div>

      <button className="new-chat" onClick={onNew} disabled={naming} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Plus size={16} /> {tab === 'dev' ? 'Nova conversa (pasta)' : 'Nova conversa'}
      </button>

      {naming && (
        <div className="naming-box">
          {namingFolder && (
            <span className="naming-folder" title={namingFolder} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Folder size={12} /> {shortPath(namingFolder)}
            </span>
          )}
          <input
            autoFocus
            value={newName}
            placeholder="Nome da conversa…"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm()
              if (e.key === 'Escape') cancel()
            }}
          />
          <div className="naming-actions">
            <button className="naming-create" onClick={confirm}>
              Criar
            </button>
            <button className="ghost icon" title="Cancelar" onClick={cancel} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      <div className="conversation-list">
        {sorted.length === 0 && (
          <p className="sidebar-empty">
            {tab === 'dev'
              ? 'Nenhuma conversa de DevMode ainda. Crie uma e escolha a pasta.'
              : 'Nenhuma conversa ainda. Crie uma para começar.'}
          </p>
        )}
        {sorted.map((c) => (
          <div
            key={c.id}
            className={`conversation-item ${c.id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(c.id)}
          >
            <div className="conversation-text">
              <span className="conversation-title">
                {c.id === generatingId && <span className="generating-dot" />}
                {c.title}
              </span>
              <span className="conversation-when">{formatWhen(c.updatedAt)}</span>
            </div>
            <button
              className="conversation-delete"
              title="Apagar conversa"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(c.id)
              }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}

        {tab === 'chat' && settings.openWebUi?.enabled && importable.length > 0 && (
          <>
            <div className="remote-section-title">🌐 No Open WebUI</div>
            {importable.map((r) => (
              <div
                key={r.id}
                className="conversation-item remote"
                title="Clique para importar esta conversa do Open WebUI"
                onClick={() => onImportRemote(r)}
              >
                <div className="conversation-text">
                  <span className="conversation-title">{r.title}</span>
                  <span className="conversation-when">{formatWhen(r.updatedAt * 1000)}</span>
                </div>
                <span className="remote-import">⬇</span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <label className="sidebar-label">
          Modelo ativo
          <select
            className="provider-select"
            value={settings.activeProviderId ?? ''}
            onChange={(e) => onChangeProvider(e.target.value)}
          >
            {settings.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.model}
              </option>
            ))}
          </select>
        </label>

        <span
          className="mcp-badge"
          title={mcpStatus.map((s) => s.name).join(', ') || 'Nenhum servidor MCP'}
          style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
        >
          <Plug size={12} /> {connectedTools} ferramenta{connectedTools === 1 ? '' : 's'} MCP
        </span>

        <div className="user-row">
          <span className="avatar">{initials(user.name)}</span>
          <span className="user-name" title={user.email || user.name}>
            {user.name}
            {user.role === 'local' && <span className="user-mode"> · local</span>}
          </span>
          <button className="ghost icon" title="Configurações" onClick={onOpenSettings} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Settings size={18} />
          </button>
          <button
            className="ghost icon"
            title="Sair da conta"
            onClick={onLogout}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <LogOut size={18} />
          </button>
        </div>
      </div>
    </aside>
  )
}
