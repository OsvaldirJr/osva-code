import { useEffect, useState } from 'react'
import { BookOpen, Brain, FileText, Plus, Search, Trash2 } from 'lucide-react'
import { shortPath } from '../App'

type Selected = { type: 'instructions' } | { type: 'notes' } | { type: 'skill'; name: string }

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
  const [catalog, setCatalog] = useState<
    { id: string; label: string; description: string; installed: boolean; detected: boolean }[]
  >([])
  const [selected, setSelected] = useState<Selected>({ type: 'instructions' })
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [newSkillName, setNewSkillName] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    void window.api.projectRead(folder).then((data) => {
      setInstructions(data.instructions)
      setNotes(data.notes)
      setSkills(data.skills)
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
    } else {
      setDraft(skills.find((s) => s.name === next.name)?.content ?? '')
    }
  }

  const save = async (): Promise<void> => {
    if (selected.type === 'instructions') {
      await window.api.projectSaveInstructions(folder, draft)
      setInstructions(draft)
    } else if (selected.type === 'notes') {
      await window.api.projectSaveNotes(folder, draft)
      setNotes(draft)
    } else {
      const savedName = await window.api.projectSaveSkill(folder, selected.name, draft)
      setSkills((prev) => {
        const others = prev.filter((s) => s.name !== selected.name)
        return [...others, { name: savedName, content: draft }].sort((a, b) =>
          a.name.localeCompare(b.name)
        )
      })
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
      setSkills((prev) =>
        [...prev.filter((s) => s.name !== savedName), { name: savedName, content: '' }].sort(
          (a, b) => a.name.localeCompare(b.name)
        )
      )
      setNewSkillName('')
      setSelected({ type: 'skill', name: savedName })
      setDraft('')
      setDirty(false)
      setStatus(null)
    } catch {
      setStatus('Nome de skill inválido — use letras, números e hífens.')
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
                  : `Skill “${selected.name}” — instruções reutilizáveis enviadas junto com as do projeto.`}
            </p>
            <textarea
              value={draft}
              spellCheck={false}
              placeholder={
                selected.type === 'instructions'
                  ? 'Ex.: Projeto Angular 18 com standalone components. Sempre use signals…'
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
