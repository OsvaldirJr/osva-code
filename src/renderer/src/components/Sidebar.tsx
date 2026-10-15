import { useState } from 'react'
import type { AppSettings, AuthUser, McpServerStatus, RemoteChatStub } from '../../../shared/types'
import { conversationKind, folderKey, folderLabel, shortPath, type Conversation, type ConversationKind } from '../App'
import { SquarePen, Search, Clock, Folder, Trash2, Plug, Settings, LogOut, MessageSquare, Code2, Globe, Download, PanelLeftClose, PanelLeftOpen, ChevronDown, ChevronRight, Palette } from 'lucide-react'

const SIDEBAR_COLLAPSED_KEY = 'osvacode.sidebar.collapsed'
const GROUP_COLLAPSED_KEY = 'osvacode.sidebar.groupCollapsed'

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function readCollapsedGroups(): string[] {
  try {
    const raw = localStorage.getItem(GROUP_COLLAPSED_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

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
  path: string
  items: Conversation[]
}

/** Junta as conversas da mesma pasta. Sem nenhuma pasta, a lista continua solta. */
function groupConversations(list: Conversation[]): ConversationGroup[] {
  const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  if (!sorted.some((conversation) => conversation.folder)) {
    return [{ key: 'all', label: '', title: '', path: '', items: sorted }]
  }

  const groups = new Map<string, ConversationGroup>()
  for (const conversation of sorted) {
    const key = conversation.folder ? folderKey(conversation.folder) : ''
    let group = groups.get(key)
    if (!group) {
      const label = conversation.folder ? folderLabel(conversation.folder) : 'Sem pasta'
      const path = conversation.folder ? shortPath(conversation.folder) : ''
      group = {
        key: key || 'none',
        label,
        title: conversation.folder ?? 'Sem pasta de trabalho',
        path: path !== label ? path : '',
        items: []
      }
      groups.set(key, group)
    }
    group.items.push(conversation)
  }

  const counts = new Map<string, number>()
  for (const group of groups.values()) counts.set(group.label, (counts.get(group.label) ?? 0) + 1)
  return [...groups.values()]
    .map((group) => {
      if (!group.title || (counts.get(group.label) ?? 0) < 2) return group
      const parts = group.title.split('/').filter(Boolean)
      const parent = parts.length >= 2 ? parts[parts.length - 2] : ''
      return parent ? { ...group, label: `${parent}/${group.label}` } : group
    })
    .sort((a, b) => {
      if (a.key === 'none') return 1
      if (b.key === 'none') return -1
      return (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0)
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
  onOpenSettings,
  section,
  onSectionChange
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
  section: 'chats' | 'automations' | 'design'
  onSectionChange: (section: 'chats' | 'automations' | 'design') => void
}): JSX.Element {
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed)
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(readCollapsedGroups)

  const setCollapsedPersisted = (next: boolean): void => {
    setCollapsed(next)
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0')
    } catch {
      // a preferência só não persiste se o armazenamento estiver indisponível
    }
  }
  const connectedTools = mcpStatus.reduce((sum, s) => sum + s.tools.length, 0)
  const needle = query.trim().toLowerCase()
  const visible = conversations.filter((c) => {
    if (conversationKind(c) !== tab) return false
    if (!needle) return true
    const folder = (c.folder ?? '').toLowerCase()
    return c.title.toLowerCase().includes(needle) || folder.includes(needle)
  })
  const groups = groupConversations(visible)

  const toggleGroup = (key: string): void => {
    setCollapsedGroups((prev) => {
      const next = prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]
      try {
        localStorage.setItem(GROUP_COLLAPSED_KEY, JSON.stringify(next))
      } catch {
        // a preferência só não persiste se o armazenamento estiver indisponível
      }
      return next
    })
  }
  // conversas do Open WebUI que ainda não existem localmente (só na aba Chat)
  const importable = remoteChats.filter((r) => {
    if (conversations.some((c) => c.owuiId === r.id)) return false
    if (!needle) return true
    return r.title.toLowerCase().includes(needle)
  })

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-brand">
        <span className="brand-mark">
          <span className="brand-dot" />
          <span className="brand-name">OsvaCode</span>
        </span>
        <button
          type="button"
          className="ghost icon sidebar-collapse"
          title={collapsed ? 'Expandir menu' : 'Minimizar menu'}
          aria-label={collapsed ? 'Expandir menu' : 'Minimizar menu'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsedPersisted(!collapsed)}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <nav className="sidebar-nav">
        <button
          type="button"
          title="Nova conversa"
          onClick={() => {
            onSectionChange('chats')
            onNew()
          }}
        >
          <SquarePen size={16} /> <span>Nova conversa</span>
        </button>
        <button
          type="button"
          title="Pesquisa"
          className={searching ? 'active' : ''}
          onClick={() => {
            onSectionChange('chats')
            if (collapsed) {
              setCollapsedPersisted(false)
              setSearching(true)
              return
            }
            setSearching((open) => {
              if (open) setQuery('')
              return !open
            })
          }}
        >
          <Search size={16} /> <span>Pesquisa</span>
        </button>
        <button
          type="button"
          title="Automatização"
          className={section === 'automations' ? 'active' : ''}
          onClick={() => onSectionChange(section === 'automations' ? 'chats' : 'automations')}
        >
          <Clock size={16} /> <span>Automatização</span>
        </button>
        <button
          type="button"
          title="Design"
          className={section === 'design' ? 'active' : ''}
          onClick={() => onSectionChange(section === 'design' ? 'chats' : 'design')}
        >
          <Palette size={16} /> <span>Design</span>
        </button>
      </nav>

      {searching && (
        <input
          autoFocus
          className="sidebar-search"
          value={query}
          placeholder="Pesquisar conversas…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setQuery('')
              setSearching(false)
            }
          }}
        />
      )}

      <div className="sidebar-tabs">
        <button
          className={tab === 'chat' ? 'active' : ''}
          title="Chat"
          onClick={() => onTabChange('chat')}
        >
          <MessageSquare size={14} /> <span>Chat</span>
        </button>
        <button
          className={tab === 'dev' ? 'active' : ''}
          title="DevMode"
          onClick={() => onTabChange('dev')}
        >
          <Code2 size={14} /> <span>DevMode</span>
        </button>
      </div>

      <div className="conversation-list">
        {visible.length === 0 && (
          <p className="sidebar-empty">
            {needle
              ? 'Nenhuma conversa com esse texto.'
              : tab === 'dev'
                ? 'Nenhuma conversa de DevMode ainda. Escolha a pasta: as desta mesma pasta ficam juntas.'
                : 'Nenhuma conversa ainda. Crie uma para começar.'}
          </p>
        )}
        {groups.map((group) => {
          const folded = Boolean(group.label) && !needle && collapsedGroups.includes(group.key)
          return (
          <div key={group.key} className={`conversation-group${group.label ? ' grouped' : ''}`}>
            {group.label && (
              <button
                type="button"
                className="conversation-group-title"
                title={group.title}
                aria-expanded={!folded}
                onClick={() => toggleGroup(group.key)}
              >
                {folded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <Folder size={12} />
                <span className="conversation-group-text">
                  <span className="conversation-group-label">{group.label}</span>
                  {group.path && <span className="conversation-group-path">{group.path}</span>}
                </span>
                <span className="conversation-group-count">{group.items.length}</span>
              </button>
            )}
            {!folded && group.items.map((c) => (
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
          )
        })}

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
          title={
            mcpStatus.length
              ? `${connectedTools} ferramenta${connectedTools === 1 ? '' : 's'} MCP · ${mcpStatus.map((s) => s.name).join(', ')}`
              : 'Nenhum servidor MCP'
          }
        >
          <Plug size={12} />
          <span className="mcp-badge-count">{connectedTools}</span>
          <span className="mcp-badge-label">ferramenta{connectedTools === 1 ? '' : 's'} MCP</span>
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
