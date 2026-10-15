import { useEffect, useState } from 'react'
import { BookOpen, Brain, FileText, Plus, Search, Trash2, Zap } from 'lucide-react'
import { shortPath } from '../App'

type Selected =
  | { type: 'instructions' }
  | { type: 'notes' }
  | { type: 'skill'; name: string }
  | { type: 'action'; name: string }

const NEW_ACTION_TEMPLATE = (name: string): string => `---
descricao: O que esta ação faz (aparece no menu ao digitar /)
---

Escreva aqui o prompt que será enviado quando alguém digitar /${name}.

Use $ARGUMENTOS onde deve entrar o texto digitado depois do comando.
Ex.: "/${name} src/app.ts" → $ARGUMENTOS vira "src/app.ts".
`

export function ProjectPanel({
  folder,
  onClose
}: {
  folder: string
  onClose: () => void
}): JSX.Element {
  const [instructions, setInstructions] = useState('')
  const [notes, setNotes] = useState('')
  const [skills, setSkills] = useState<{ name: string; content: string }[]>([])
  const [actions, setActions] = useState<{ name: string; content: string }[]>([])
  const [catalog, setCatalog] = useState<
    { id: string; label: string; description: string; installed: boolean; detected: boolean }[]
  >([])
  const [selected, setSelected] = useState<Selected>({ type: 'instructions' })
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [newSkillName, setNewSkillName] = useState('')
  const [newActionName, setNewActionName] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    void window.api.projectRead(folder).then((data) => {
      setInstructions(data.instructions)
      setNotes(data.notes)
      setSkills(data.skills)
      setActions(data.actions)
      setDraft(data.instructions)
    })
    void window.api.projectCatalog(folder).then(setCatalog)
  }, [folder])

  const installFromCatalog = async (id: string): Promise<void> => {
    await window.api.projectInstallCatalogSkill(folder, id)
    const [data, cat] = await Promise.all([
      window.api.projectRead(folder),
      window.api.projectCatalog(folder)
    ])
    setSkills(data.skills)
    setCatalog(cat)
    setSelected({ type: 'skill', name: id })
    setDraft(data.skills.find((s) => s.name === id)?.content ?? '')
    setDirty(false)
  }

  const select = (next: Selected): void => {
    if (dirty && !window.confirm('Descartar as alterações não salvas?')) return
    setSelected(next)
    setDirty(false)
    setStatus(null)
    if (next.type === 'instructions') {
      setDraft(instructions)
    } else if (next.type === 'notes') {
      setDraft(notes)
    } else if (next.type === 'action') {
      setDraft(actions.find((a) => a.name === next.name)?.content ?? '')
    } else {
      setDraft(skills.find((s) => s.name === next.name)?.content ?? '')
    }
  }

  const upsert = (
    list: { name: string; content: string }[],
    oldName: string,
    name: string,
    content: string
  ): { name: string; content: string }[] =>
    [...list.filter((s) => s.name !== oldName && s.name !== name), { name, content }].sort((a, b) =>
      a.name.localeCompare(b.name)
    )

  const save = async (): Promise<void> => {
    if (selected.type === 'instructions') {
      await window.api.projectSaveInstructions(folder, draft)
      setInstructions(draft)
    } else if (selected.type === 'notes') {
      await window.api.projectSaveNotes(folder, draft)
      setNotes(draft)
    } else if (selected.type === 'action') {
      const savedName = await window.api.projectSaveAction(folder, selected.name, draft)
      setActions((prev) => upsert(prev, selected.name, savedName, draft))
      if (savedName !== selected.name) setSelected({ type: 'action', name: savedName })
    } else {
      const savedName = await window.api.projectSaveSkill(folder, selected.name, draft)
      setSkills((prev) => upsert(prev, selected.name, savedName, draft))
      if (savedName !== selected.name) setSelected({ type: 'skill', name: savedName })
    }
    setDirty(false)
    setStatus('Salvo ✓ — vale a partir da próxima mensagem.')
  }

  const createSkill = async (): Promise<void> => {
    const name = newSkillName.trim()
    if (!name) return
    try {
      const savedName = await window.api.projectSaveSkill(folder, name, '')
      setSkills((prev) => upsert(prev, savedName, savedName, ''))
      setNewSkillName('')
      setSelected({ type: 'skill', name: savedName })
      setDraft('')
      setDirty(false)
      setStatus(null)
    } catch {
      setStatus('Nome de skill inválido — use letras, números e hífens.')
    }
  }

  const createAction = async (): Promise<void> => {
    const name = newActionName.trim().replace(/^\/+/, '')
    if (!name) return
    try {
      // salva primeiro com o nome bruto para obter o nome normalizado e então grava o modelo
      const savedName = await window.api.projectSaveAction(folder, name, '')
      const content = NEW_ACTION_TEMPLATE(savedName)
      await window.api.projectSaveAction(folder, savedName, content)
      setActions((prev) => upsert(prev, savedName, savedName, content))
      setNewActionName('')
      setSelected({ type: 'action', name: savedName })
      setDraft(content)
      setDirty(false)
      setStatus(null)
    } catch {
      setStatus('Nome de ação inválido — use letras, números e hífens.')
    }
  }

  const removeSkill = async (name: string): Promise<void> => {
    if (!window.confirm(`Apagar a skill “${name}”?`)) return
    await window.api.projectDeleteSkill(folder, name)
    setSkills((prev) => prev.filter((s) => s.name !== name))
    if (selected.type === 'skill' && selected.name === name) {
      setSelected({ type: 'instructions' })
      setDraft(instructions)
      setDirty(false)
    }
  }

  const removeAction = async (name: string): Promise<void> => {
    if (!window.confirm(`Apagar a ação “/${name}”?`)) return
    await window.api.projectDeleteAction(folder, name)
    setActions((prev) => prev.filter((a) => a.name !== name))
    if (selected.type === 'action' && selected.name === name) {
      setSelected({ type: 'instructions' })
      setDraft(instructions)
      setDirty(false)
    }
  }

  const query = search.trim().toLowerCase()
  const visibleSkills = query
    ? skills.filter(
        (s) => s.name.toLowerCase().includes(query) || s.content.toLowerCase().includes(query)
      )
    : skills
  const visibleCatalog = catalog.filter(
    (c) =>
      !c.installed &&
      (!query ||
        c.label.toLowerCase().includes(query) ||
        c.id.includes(query) ||
        c.description.toLowerCase().includes(query))
  )

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal project-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            Projeto <span className="project-path">📁 {shortPath(folder)}/.osvacode</span>
          </h2>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="project-body">
          <aside className="project-list">
            <button
              className={`project-item ${selected.type === 'instructions' ? 'active' : ''}`}
              onClick={() => select({ type: 'instructions' })}
            >
              <BookOpen size={14} /> Instruções
            </button>
            <button
              className={`project-item ${selected.type === 'notes' ? 'active' : ''}`}
              onClick={() => select({ type: 'notes' })}
            >
              <Brain size={14} /> Memória da IA
            </button>

            <div className="project-list-title">Ações (/comando)</div>
            {actions.map((a) => (
              <div
                key={a.name}
                className={`project-item skill ${
                  selected.type === 'action' && selected.name === a.name ? 'active' : ''
                }`}
                onClick={() => select({ type: 'action', name: a.name })}
              >
                <Zap size={14} />
                <span className="project-item-name">/{a.name}</span>
                <button
                  className="project-item-delete"
                  title="Apagar ação"
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeAction(a.name)
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <div className="project-new-skill">
              <input
                value={newActionName}
                placeholder="nova-acao"
                onChange={(e) => setNewActionName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void createAction()}
              />
              <button className="ghost icon" title="Criar ação" onClick={() => void createAction()}>
                <Plus size={15} />
              </button>
            </div>

            <div className="project-list-title">Skills</div>
            <div className="project-search">
              <Search size={13} />
              <input
                value={search}
                placeholder="Pesquisar skill…"
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button className="project-search-clear" onClick={() => setSearch('')}>
                  ✕
                </button>
              )}
            </div>
            {visibleSkills.length === 0 && visibleCatalog.length === 0 && search && (
              <p className="sidebar-empty">Nenhuma skill encontrada.</p>
            )}
            {visibleSkills.map((s) => (
              <div
                key={s.name}
                className={`project-item skill ${
                  selected.type === 'skill' && selected.name === s.name ? 'active' : ''
                }`}
                onClick={() => select({ type: 'skill', name: s.name })}
              >
                <FileText size={14} />
                <span className="project-item-name">{s.name}</span>
                <button
                  className="project-item-delete"
                  title="Apagar skill"
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeSkill(s.name)
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}

            <div className="project-new-skill">
              <input
                value={newSkillName}
                placeholder="nova-skill"
                onChange={(e) => setNewSkillName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void createSkill()}
              />
              <button className="ghost icon" title="Criar skill" onClick={() => void createSkill()}>
                <Plus size={15} />
              </button>
            </div>

            {visibleCatalog.length > 0 && (
              <>
                <div className="project-list-title">Skills prontas</div>
                {visibleCatalog.map((c) => (
                    <button
                      key={c.id}
                      className="project-item catalog"
                      title={c.description}
                      onClick={() => void installFromCatalog(c.id)}
                    >
                      <Plus size={14} />
                      <span className="project-item-name">{c.label}</span>
                      {c.detected && <span className="catalog-detected">detectada</span>}
                    </button>
                  ))}
              </>
            )}
          </aside>

          <div className="project-editor">
            <p className="help">
              {selected.type === 'instructions'
                ? 'Contexto enviado ao modelo em toda conversa desta pasta: stack, convenções, o que evitar…'
                : selected.type === 'notes'
                  ? 'Memória que a própria IA mantém (notas.md): descobertas, decisões e comandos. Ela lê e reescreve sozinha, mas você pode corrigir aqui.'
                  : selected.type === 'action'
                    ? `Ação /${selected.name} — digite /${selected.name} no chat para enviar este prompt. $ARGUMENTOS recebe o que vier depois do comando.`
                    : `Skill “${selected.name}” — enviada junto com as do projeto e também chamável com /${selected.name}. Com "ativacao: manual" no cabeçalho, só entra quando chamada por /.`}
            </p>
            <textarea
              value={draft}
              spellCheck={false}
              placeholder={
                selected.type === 'instructions'
                  ? 'Ex.: Projeto Angular 18 com standalone components. Sempre use signals…'
                  : selected.type === 'action'
                    ? 'Ex.: Gere a documentação JSDoc de $ARGUMENTOS seguindo o padrão do projeto…'
                    : 'Ex.: Ao escrever testes, use vitest e Testing Library; nunca teste implementação…'
              }
              onChange={(e) => {
                setDraft(e.target.value)
                setDirty(true)
                setStatus(null)
              }}
            />
            <div className="project-editor-footer">
              <span className="project-status">{status ?? (dirty ? 'Alterações não salvas' : '')}</span>
              <button className="send" onClick={() => void save()} disabled={!dirty}>
                Salvar
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
