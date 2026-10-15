import { useEffect, useRef } from 'react'
import { FileText, Zap } from 'lucide-react'
import type { SlashCommand } from '../../../shared/types'

/**
 * Detecta se o usuário está digitando um comando de barra no início da mensagem.
 * Aceita encadeamento ("/react /rev") — sempre o último token sem espaço depois.
 */
export function slashQuery(input: string): { prefix: string; query: string } | null {
  const match = input.match(/^((?:\/[a-z0-9_-]+[ \t]+)*)\/([a-z0-9_-]*)$/i)
  if (!match) return null
  return { prefix: match[1], query: match[2].toLowerCase() }
}

/** Comandos que combinam com o que foi digitado (nome começa com > nome contém > descrição). */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) return commands
  const starts = commands.filter((c) => c.name.startsWith(query))
  const contains = commands.filter((c) => !c.name.startsWith(query) && c.name.includes(query))
  const inDescription = commands.filter(
    (c) => !c.name.includes(query) && c.description.toLowerCase().includes(query)
  )
  return [...starts, ...contains, ...inDescription]
}

export function SlashMenu({
  items,
  selectedIndex,
  onHover,
  onPick
}: {
  items: SlashCommand[]
  selectedIndex: number
  onHover: (index: number) => void
  onPick: (command: SlashCommand) => void
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  return (
    <div className="slash-menu" role="listbox" ref={listRef}>
      <div className="slash-menu-hint">
        <span>Comandos</span>
        <span>↑↓ navegar · Tab/Enter escolher · Esc fechar</span>
      </div>
      {items.map((command, index) => (
        <button
          type="button"
          key={`${command.kind}-${command.name}`}
          data-index={index}
          role="option"
          aria-selected={index === selectedIndex}
          className={`slash-item ${index === selectedIndex ? 'active' : ''}`}
          onMouseEnter={() => onHover(index)}
          // mousedown para não tirar o foco do campo antes de aplicar
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(command)
          }}
        >
          {command.kind === 'action' ? <Zap size={14} /> : <FileText size={14} />}
          <span className="slash-item-name">/{command.name}</span>
          <span className="slash-item-desc">{command.description}</span>
          <span className={`slash-item-kind ${command.kind}`}>
            {command.kind === 'action' ? (command.source === 'builtin' ? 'ação · app' : 'ação') : 'skill'}
          </span>
        </button>
      ))}
    </div>
  )
}
