// Estrutura .osvacode/ dentro da pasta de trabalho do projeto
// (nos moldes de .claude / .gemini): configs e skills do projeto
// que são injetadas no modelo em todas as conversas daquela pasta.

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { detectSkills, SKILL_CATALOG } from './skillCatalog'

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '.cache',
  '.osvacode',
  'venv',
  '.venv',
  '__pycache__',
  'vendor'
])
const MAX_STRUCTURE_ENTRIES = 300
const MAX_STRUCTURE_DEPTH = 4
const MAX_STRUCTURE_CHARS = 4500
const MAX_NOTES_CHARS = 4000

const DIR_NAME = '.osvacode'
/** Marcador que identifica o template intocado (não é enviado ao modelo). */
const TEMPLATE_MARKER = '<!-- modelo: edite este arquivo -->'

const INSTRUCTIONS_TEMPLATE = `${TEMPLATE_MARKER}
# Instruções do projeto

Escreva aqui o que o modelo deve saber sobre este projeto — este arquivo é
enviado em TODAS as conversas que usam esta pasta de trabalho.

Sugestões do que documentar:
- Stack e versões (ex.: Angular 18 standalone, Node 20, PostgreSQL)
- Convenções de código do time
- O que NUNCA fazer (ex.: não usar bibliotecas X, não tocar na pasta Y)
- Comandos úteis (build, testes, lint)

Apague esta explicação e escreva as suas instruções.
`

const SKILL_TEMPLATE = `---
nome: _exemplo
descricao: Modelo de skill — duplique este arquivo para criar as suas
---

Uma skill é um bloco de instruções reutilizável, enviado ao modelo junto
com as instruções do projeto. Bons usos:

- Padrões de revisão de código do time
- Como escrever testes neste projeto
- Template de commit e de pull request

Arquivos que começam com "_" (como este) são ignorados. Para criar uma skill,
copie este arquivo com outro nome (ex.: testes.md) e escreva as instruções.
`

const CONFIG_TEMPLATE = { version: 1 }

const MAX_INSTRUCTIONS_CHARS = 6000
const MAX_SKILL_CHARS = 3000
const MAX_TOTAL_SKILLS_CHARS = 9000

export interface ProjectSkill {
  name: string
  content: string
}

export interface ProjectContext {
  instructions: string | null
  skills: ProjectSkill[]
  /** Árvore de arquivos gerada automaticamente pelo app a cada mensagem. */
  structure: string | null
  /** Memória que o próprio modelo mantém em .osvacode/notas.md. */
  notes: string | null
}

/**
 * Varre o projeto (com limites) e regenera .osvacode/estrutura.md.
 * Retorna a árvore em texto para injeção no prompt.
 */
export function generateStructure(folder: string): string {
  const lines: string[] = []
  let count = 0

  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > MAX_STRUCTURE_DEPTH || count >= MAX_STRUCTURE_ENTRIES) return
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const visible = entries
      .filter((e) => !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))

    for (const entry of visible) {
      if (count >= MAX_STRUCTURE_ENTRIES) {
        lines.push(`${prefix}… (listagem cortada em ${MAX_STRUCTURE_ENTRIES} itens)`)
        return
      }
      count++
      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`)
        walk(join(dir, entry.name), prefix + '  ', depth + 1)
      } else {
        lines.push(`${prefix}${entry.name}`)
      }
    }
  }

  walk(folder, '', 1)
  const tree = lines.join('\n')

  try {
    ensureProjectDir(folder)
    writeFileSync(
      join(folder, DIR_NAME, 'estrutura.md'),
      `<!-- gerado automaticamente pelo OsvaCode a cada mensagem — não edite -->\n` +
        `# Estrutura do projeto\n\nAtualizado em: ${new Date().toISOString()}\n\n\`\`\`\n${tree}\n\`\`\`\n`,
      'utf-8'
    )
  } catch {
    // sem permissão de escrita: segue só com a injeção no prompt
  }

  return truncate(tree, MAX_STRUCTURE_CHARS)
}

/** Cria a estrutura .osvacode/ no projeto, sem nunca sobrescrever o que existe. */
export function ensureProjectDir(folder: string): void {
  try {
    const dir = join(folder, DIR_NAME)
    if (!existsSync(dir)) mkdirSync(dir)
    const skillsDir = join(dir, 'skills')
    if (!existsSync(skillsDir)) mkdirSync(skillsDir)

    const instructions = join(dir, 'instructions.md')
    if (!existsSync(instructions)) writeFileSync(instructions, INSTRUCTIONS_TEMPLATE, 'utf-8')

    const config = join(dir, 'config.json')
    if (!existsSync(config)) {
      writeFileSync(config, JSON.stringify(CONFIG_TEMPLATE, null, 2), 'utf-8')
    }

    const exampleSkill = join(skillsDir, '_exemplo.md')
    if (!existsSync(exampleSkill)) writeFileSync(exampleSkill, SKILL_TEMPLATE, 'utf-8')
  } catch (err) {
    console.error(`Não foi possível criar ${DIR_NAME} em ${folder}:`, err)
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '\n[…conteúdo cortado por tamanho…]' : text
}

/** Lê instruções e skills do projeto para injetar no prompt de sistema. */
export function loadProjectContext(folder: string): ProjectContext {
  const context: ProjectContext = { instructions: null, skills: [], structure: null, notes: null }
  const dir = join(folder, DIR_NAME)

  context.structure = generateStructure(folder) || null

  try {
    const notesPath = join(dir, 'notas.md')
    if (existsSync(notesPath)) {
      const notes = readFileSync(notesPath, 'utf-8').trim()
      if (notes) context.notes = truncate(notes, MAX_NOTES_CHARS)
    }
  } catch {
    // sem notas ainda
  }

  try {
    const instructionsPath = join(dir, 'instructions.md')
    if (existsSync(instructionsPath)) {
      const content = readFileSync(instructionsPath, 'utf-8').trim()
      if (content && !content.includes(TEMPLATE_MARKER)) {
        context.instructions = truncate(content, MAX_INSTRUCTIONS_CHARS)
      }
    }

    const skillsDir = join(dir, 'skills')
    if (existsSync(skillsDir)) {
      let total = 0
      for (const file of readdirSync(skillsDir).sort()) {
        if (!file.endsWith('.md') || file.startsWith('_')) continue
        if (total >= MAX_TOTAL_SKILLS_CHARS) break
        const content = readFileSync(join(skillsDir, file), 'utf-8').trim()
        if (!content) continue
        const truncated = truncate(content, MAX_SKILL_CHARS)
        total += truncated.length
        context.skills.push({ name: basename(file, '.md'), content: truncated })
      }
    }
  } catch (err) {
    console.error(`Falha ao ler ${DIR_NAME} de ${folder}:`, err)
  }

  return context
}

// ---------- catálogo de skills prontas ----------

interface ProjectConfig {
  version: number
  /** Skills do catálogo já instaladas automaticamente (não reinstalar se o usuário apagar). */
  autoSkillsInstalled?: string[]
}

function readConfig(folder: string): ProjectConfig {
  try {
    return JSON.parse(readFileSync(join(folder, DIR_NAME, 'config.json'), 'utf-8')) as ProjectConfig
  } catch {
    return { version: 1 }
  }
}

function writeConfig(folder: string, config: ProjectConfig): void {
  writeFileSync(join(folder, DIR_NAME, 'config.json'), JSON.stringify(config, null, 2), 'utf-8')
}

/**
 * Detecta a stack do projeto e instala as skills do catálogo que faltam.
 * Cada skill é auto-instalada uma única vez por projeto.
 */
export function autoInstallSkills(folder: string): string[] {
  ensureProjectDir(folder)
  const config = readConfig(folder)
  const installed = new Set(config.autoSkillsInstalled ?? [])
  const added: string[] = []

  for (const id of detectSkills(folder)) {
    if (installed.has(id)) continue
    const skill = SKILL_CATALOG.find((s) => s.id === id)
    if (!skill) continue
    const path = join(folder, DIR_NAME, 'skills', `${id}.md`)
    if (!existsSync(path)) {
      writeFileSync(path, skill.content, 'utf-8')
      added.push(id)
    }
    installed.add(id)
  }

  if (installed.size !== (config.autoSkillsInstalled ?? []).length) {
    writeConfig(folder, { ...config, autoSkillsInstalled: [...installed].sort() })
  }
  return added
}

export interface CatalogEntry {
  id: string
  label: string
  description: string
  installed: boolean
  detected: boolean
}

/** Estado do catálogo para exibir no painel do projeto. */
export function catalogStatus(folder: string): CatalogEntry[] {
  const detected = new Set(detectSkills(folder))
  return SKILL_CATALOG.map((skill) => ({
    id: skill.id,
    label: skill.label,
    description: skill.description,
    installed: existsSync(join(folder, DIR_NAME, 'skills', `${skill.id}.md`)),
    detected: detected.has(skill.id)
  }))
}

/** Instala uma skill do catálogo manualmente (ação explícita do usuário). */
export function installCatalogSkill(folder: string, id: string): void {
  const skill = SKILL_CATALOG.find((s) => s.id === id)
  if (!skill) throw new Error(`Skill desconhecida no catálogo: ${id}`)
  ensureProjectDir(folder)
  writeFileSync(join(folder, DIR_NAME, 'skills', `${id}.md`), skill.content, 'utf-8')
  const config = readConfig(folder)
  const installed = new Set(config.autoSkillsInstalled ?? [])
  installed.add(id)
  writeConfig(folder, { ...config, autoSkillsInstalled: [...installed].sort() })
}

// ---------- edição via app ----------

export interface ProjectFiles {
  instructions: string
  skills: ProjectSkill[]
  notes: string
}

/** Nome de arquivo seguro para uma skill (sem path traversal, sem prefixo reservado). */
function skillFileName(name: string): string {
  const clean = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[-_.]+|[-.]+$/g, '')
  if (!clean) throw new Error('Nome de skill inválido.')
  return `${clean}.md`
}

/** Conteúdo bruto dos arquivos do projeto, para edição no app. */
export function readProjectFiles(folder: string): ProjectFiles {
  ensureProjectDir(folder)
  const dir = join(folder, DIR_NAME)
  let instructions = ''
  try {
    instructions = readFileSync(join(dir, 'instructions.md'), 'utf-8')
      .split('\n')
      .filter((line) => !line.includes(TEMPLATE_MARKER))
      .join('\n')
      .trimStart()
  } catch {
    instructions = ''
  }

  const skills: ProjectSkill[] = []
  try {
    const skillsDir = join(dir, 'skills')
    for (const file of readdirSync(skillsDir).sort()) {
      if (!file.endsWith('.md') || file.startsWith('_')) continue
      skills.push({ name: basename(file, '.md'), content: readFileSync(join(skillsDir, file), 'utf-8') })
    }
  } catch {
    // sem skills
  }

  let notes = ''
  try {
    const notesPath = join(dir, 'notas.md')
    if (existsSync(notesPath)) notes = readFileSync(notesPath, 'utf-8')
  } catch {
    // sem notas
  }
  return { instructions, skills, notes }
}

export function saveProjectNotes(folder: string, content: string): void {
  ensureProjectDir(folder)
  writeFileSync(join(folder, DIR_NAME, 'notas.md'), content, 'utf-8')
}

export function saveProjectInstructions(folder: string, content: string): void {
  ensureProjectDir(folder)
  writeFileSync(join(folder, DIR_NAME, 'instructions.md'), content, 'utf-8')
}

/** Salva/cria uma skill; retorna o nome normalizado usado no arquivo. */
export function saveProjectSkill(folder: string, name: string, content: string): string {
  ensureProjectDir(folder)
  const file = skillFileName(name)
  writeFileSync(join(folder, DIR_NAME, 'skills', file), content, 'utf-8')
  return basename(file, '.md')
}

export function deleteProjectSkill(folder: string, name: string): void {
  const file = skillFileName(name)
  const path = join(folder, DIR_NAME, 'skills', file)
  if (existsSync(path)) unlinkSync(path)
}

/** Bloco de texto do projeto a anexar no prompt de sistema. */
export function projectPromptBlock(folder: string, context: ProjectContext): string {
  const parts: string[] = []
  if (context.instructions) {
    parts.push(`INSTRUÇÕES DO PROJETO (definidas em .osvacode/instructions.md):\n${context.instructions}`)
  }
  for (const skill of context.skills) {
    parts.push(`SKILL DO PROJETO “${skill.name}” (.osvacode/skills/${skill.name}.md):\n${skill.content}`)
  }
  if (context.structure) {
    parts.push(
      'ESTRUTURA DE PASTAS DO PROJETO (gerada automaticamente pelo app a cada mensagem — ' +
        'está sempre atualizada; NÃO use ferramentas para listar diretórios, monte os caminhos a partir daqui):\n' +
        context.structure
    )
  }
  if (context.notes) {
    parts.push(`SUA MEMÓRIA DO PROJETO (você escreveu em .osvacode/notas.md):\n${context.notes}`)
  }
  parts.push(
    'REGRAS DE MEMÓRIA: sempre que descobrir algo importante e duradouro sobre o projeto ' +
      '(arquitetura, comandos de build/teste, decisões, para que serve cada parte) ou criar arquivos relevantes, ' +
      `atualize o arquivo ${folder}/.osvacode/notas.md com sua ferramenta de escrita: ` +
      'leia o que já existe, mescle com o novo aprendizado e reescreva o arquivo completo, curto e organizado. ' +
      'Não anote trivialidades nem conteúdo de conversa.'
  )
  return '\n\n' + parts.join('\n\n')
}
