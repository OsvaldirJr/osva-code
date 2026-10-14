import type { AppSettings, AuthUser, McpServerStatus, RemoteChatStub } from '../../../shared/types'
import { conversationKind, folderKey, folderLabel, type Conversation, type ConversationKind } from '../App'
import { Plus, Folder, Trash2, Plug, Settings, LogOut, MessageSquare, Code2, Globe, Download } from 'lucide-react'

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

interface ConversationGroup {
  key: string
  label: string
  title: string
  items: Conversation[]
}

/** No DevMode, agrupa pela pasta de trabalho. No Chat, uma lista só. */
function groupConversations(list: Conversation[], tab: ConversationKind): ConversationGroup[] {
  const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  if (tab !== 'dev') {
    return [{ key: 'all', label: '', title: '', items: sorted }]
  }

  const groups = new Map<string, ConversationGroup>()
  for (const conversation of sorted) {
    const key = conversation.folder ? folderKey(conversation.folder) : ''
    let group = groups.get(key)
    if (!group) {
      const label = conversation.folder ? folderLabel(conversation.folder) : 'Sem pasta'
      group = {
        key: key || 'none',
        label,
        title: conversation.folder ?? 'Sem pasta de trabalho',
        items: []
      }
      groups.set(key, group)
    }
    group.items.push(conversation)
  }

  const counts = new Map<string, number>()
  for (const group of groups.values()) counts.set(group.label, (counts.get(group.label) ?? 0) + 1)
  return [...groups.values()].map((group) => {
    if (!group.title || (counts.get(group.label) ?? 0) < 2) return group
    const parts = group.title.split('/').filter(Boolean)
    const parent = parts.length >= 2 ? parts[parts.length - 2] : ''
    return parent ? { ...group, label: `${parent}/${group.label}` } : group
  })
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
  remoteChats,
  onImportRemote,
  onSelect,
  onNew,
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
  remoteChats: RemoteChatStub[]
  onImportRemote: (remote: RemoteChatStub) => void
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onChangeProvider: (providerId: string) => void
  onOpenSettings: () => void
}): JSX.Element {
  const connectedTools = mcpStatus.reduce((sum, s) => sum + s.tools.length, 0)
  const visible = conversations.filter((c) => conversationKind(c) === tab)
  const groups = groupConversations(visible, tab)
  // conversas do Open WebUI que ainda não existem localmente (só na aba Chat)
  const importable = remoteChats.filter((r) => !conversations.some((c) => c.owuiId === r.id))

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

      <button className="new-chat" onClick={onNew} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Plus size={16} /> {tab === 'dev' ? 'Nova conversa (pasta)' : 'Nova conversa'}
      </button>

      <div className="conversation-list">
        {visible.length === 0 && (
          <p className="sidebar-empty">
            {tab === 'dev'
              ? 'Nenhuma conversa de DevMode ainda. Escolha a pasta: as desta mesma pasta ficam juntas.'
              : 'Nenhuma conversa ainda. Crie uma para começar.'}
          </p>
        )}
        {groups.map((group) => (
          <div key={group.key} className="conversation-group">
            {group.label && (
              <div className="conversation-group-title" title={group.title}>
                <Folder size={12} />
                <span className="conversation-group-label">{group.label}</span>
                <span className="conversation-group-count">{group.items.length}</span>
              </div>
            )}
            {group.items.map((c) => (
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
          </div>
        ))}

        {tab === 'chat' && settings.openWebUi?.enabled && importable.length > 0 && (
          <>
            <div className="remote-section-title">
              <Globe size={12} /> No Open WebUI
            </div>
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
                <span className="remote-import">
                  <Download size={14} />
                </span>
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
            <span className="user-name-text">{user.name}</span>
            {user.role === 'local' && <span className="user-mode">modo local</span>}
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
