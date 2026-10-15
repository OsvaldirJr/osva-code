// Comandos de barra digitados no campo de mensagem:
//   /acao argumentos   → expande para o prompt da ação (.osvacode/actions/<acao>.md
//                        ou uma das ações embutidas abaixo)
//   /skill ...         → anexa a skill .osvacode/skills/<skill>.md nesta mensagem
// Skills e uma ação podem ser encadeadas: "/react /typescript /revisar src/App.tsx".

import { existsSync, readFileSync, readdirSync } from 'fs'
import { basename, join } from 'path'
import type { SlashCommand } from '../shared/types'

const DIR_NAME = '.osvacode'
const MAX_COMMAND_CHARS = 8000

/** Marcadores aceitos no corpo da ação para posicionar o texto digitado após o comando. */
const ARG_PLACEHOLDERS = ['$ARGUMENTOS', '$ARGUMENTS', '{{args}}']

interface CommandBody {
  description: string
  body: string
}

const BUILTIN_ACTIONS: Record<string, CommandBody> = {
  revisar: {
    description: 'Revisa código: bugs, segurança, legibilidade',
    body:
      'Faça uma revisão de código cuidadosa de: $ARGUMENTOS\n\n' +
      'Leia os arquivos envolvidos antes de opinar. Aponte, em ordem de gravidade: bugs, problemas de ' +
      'segurança, casos de borda não tratados, desempenho e legibilidade. Para cada ponto cite o arquivo/linha ' +
      'e proponha a correção. Não altere arquivos — apenas revise.'
  },
  explicar: {
    description: 'Explica um código ou conceito passo a passo',
    body:
      'Explique de forma clara e didática: $ARGUMENTOS\n\n' +
      'Se for código do projeto, leia os arquivos antes. Comece pelo propósito geral, depois o fluxo ' +
      'principal e por fim os detalhes que merecem atenção.'
  },
  testes: {
    description: 'Escreve testes automatizados',
    body:
      'Escreva testes automatizados para: $ARGUMENTOS\n\n' +
      'Use o framework de testes que o projeto já usa (verifique as dependências). Cubra o caminho feliz, ' +
      'casos de borda e erros. Nomeie os testes pelo comportamento esperado.'
  },
  corrigir: {
    description: 'Investiga e corrige um bug',
    body:
      'Investigue e corrija este problema: $ARGUMENTOS\n\n' +
      'Primeiro encontre a causa raiz lendo o código relevante; explique-a em poucas linhas. Depois aplique ' +
      'a menor correção correta, sem refatorações não relacionadas.'
  },
  refatorar: {
    description: 'Refatora mantendo o comportamento',
    body:
      'Refatore: $ARGUMENTOS\n\n' +
      'Mantenha exatamente o mesmo comportamento externo. Melhore nomes, reduza duplicação e complexidade, ' +
      'siga as convenções do projeto. Resuma no final o que mudou e por quê.'
  },
  commit: {
    description: 'Sugere mensagem de commit das alterações',
    body:
      'Escreva uma mensagem de commit (Conventional Commits, em português) para as alterações feitas nesta ' +
      'conversa. Linha de assunto com até 72 caracteres e, se útil, um corpo curto com o porquê. $ARGUMENTOS'
  }
}

/** Lê frontmatter simples (`chave: valor`) entre linhas `---`. */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!match) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx > 0) meta[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
  }
  return { meta, body: raw.slice(match[0].length) }
}

/** Skill marcada com `ativacao: manual` só entra quando chamada por /nome. */
export function isManualSkill(raw: string): boolean {
  const { meta } = parseFrontmatter(raw)
  return (meta['ativacao'] ?? meta['ativação'] ?? '').toLowerCase() === 'manual'
}

function readCommandDir(folder: string | null, sub: 'actions' | 'skills'): Map<string, CommandBody> {
  const result = new Map<string, CommandBody>()
  if (!folder) return result
  const dir = join(folder, DIR_NAME, sub)
  if (!existsSync(dir)) return result
  try {
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.md') || file.startsWith('_')) continue
      const raw = readFileSync(join(dir, file), 'utf-8')
      const { meta, body } = parseFrontmatter(raw)
      if (!body.trim()) continue
      result.set(basename(file, '.md').toLowerCase(), {
        description: meta['descricao'] ?? meta['descrição'] ?? meta['description'] ?? '',
        body: body.trim().slice(0, MAX_COMMAND_CHARS)
      })
    }
  } catch (err) {
    console.error(`Falha ao ler ${DIR_NAME}/${sub} de ${folder}:`, err)
  }
  return result
}

function loadActions(folder: string | null): Map<string, CommandBody & { source: 'project' | 'builtin' }> {
  const actions = new Map<string, CommandBody & { source: 'project' | 'builtin' }>()
  for (const [name, cmd] of Object.entries(BUILTIN_ACTIONS)) actions.set(name, { ...cmd, source: 'builtin' })
  // ações do projeto sobrescrevem as embutidas de mesmo nome
  for (const [name, cmd] of readCommandDir(folder, 'actions')) actions.set(name, { ...cmd, source: 'project' })
  return actions
}

/** Lista para o autocomplete do campo de mensagem. */
export function listSlashCommands(folder: string | null): SlashCommand[] {
  const actions = loadActions(folder)
  const list: SlashCommand[] = [...actions].map(([name, cmd]) => ({
    name,
    kind: 'action',
    description: cmd.description,
    source: cmd.source
  }))
  for (const [name, cmd] of readCommandDir(folder, 'skills')) {
    if (actions.has(name)) continue // ação tem prioridade no mesmo nome
    list.push({ name, kind: 'skill', description: cmd.description, source: 'project' })
  }
  return list.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Expande os comandos de barra no início da mensagem do usuário.
 * Retorna o texto original se não houver comando conhecido.
 */
export function expandSlashCommands(folder: string | null, text: string): string {
  if (!text.startsWith('/')) return text
  const actions = loadActions(folder)
  const skills = readCommandDir(folder, 'skills')

  let rest = text
  let action: { name: string; body: string } | null = null
  const usedSkills: { name: string; body: string }[] = []

  for (;;) {
    const match = rest.match(/^\/([a-z0-9][a-z0-9_-]*)(?=\s|$)/i)
    if (!match) break
    const name = match[1].toLowerCase()
    const asAction: CommandBody | undefined = !action ? actions.get(name) : undefined
    const asSkill: CommandBody | undefined = skills.get(name)
    if (asAction) action = { name, body: asAction.body }
    else if (asSkill && !usedSkills.some((s) => s.name === name)) usedSkills.push({ name, body: asSkill.body })
    else break
    rest = rest.slice(match[0].length).replace(/^[ \t]+/, '')
  }

  if (!action && usedSkills.length === 0) return text
  const args = rest.trim()
  const parts: string[] = []

  for (const skill of usedSkills) {
    parts.push(
      `[Skill “${skill.name}” ativada pelo usuário com /${skill.name} — siga estas instruções nesta tarefa]\n` +
        skill.body
    )
  }

  if (action) {
    let prompt = action.body
    const hasPlaceholder = ARG_PLACEHOLDERS.some((p) => prompt.includes(p))
    for (const p of ARG_PLACEHOLDERS) prompt = prompt.split(p).join(args || '(sem detalhes adicionais)')
    if (!hasPlaceholder && args) prompt += `\n\nDetalhes do usuário:\n${args}`
    parts.push(`[Ação /${action.name}]\n${prompt.trim()}`)
  } else if (args) {
    parts.push(args)
  }

  return parts.join('\n\n---\n\n')
}
