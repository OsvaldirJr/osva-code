import { spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import { changeBetween } from './changes'
import type { FileChange } from '../shared/types'

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'coverage', 'vendor', '__pycache__'])
const MAX_MATCHES = 40
const MAX_FILE_BYTES = 300_000

export interface HunkEdit {
  removed: string[]
  added: string[]
  after: string | null
}

export function resolveInside(folder: string, input: string): string | null {
  const abs = resolve(folder, input)
  const rel = relative(folder, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

function relativePath(folder: string, abs: string): string {
  return relative(folder, abs).split(sep).join('/')
}

export function restoreWorkspaceFile(folder: string, filePath: string, previous: string | null): FileChange | null {
  const abs = resolveInside(folder, filePath)
  if (!abs) throw new Error('Caminho fora da pasta de trabalho.')
  if (previous === null) {
    if (existsSync(abs)) unlinkSync(abs)
    return null
  }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, previous, 'utf8')
  return null
}

export function rejectWorkspaceHunk(
  folder: string,
  filePath: string,
  previous: string | null,
  hunk: HunkEdit
): FileChange | null {
  const abs = resolveInside(folder, filePath)
  if (!abs || !existsSync(abs)) throw new Error('Arquivo não encontrado na pasta de trabalho.')
  let text = readFileSync(abs, 'utf8')
  const added = hunk.added.join('\n')
  const removed = hunk.removed.join('\n')
  if (hunk.added.length > 0) {
    const index = text.indexOf(added)
    if (index < 0) throw new Error('Não encontrei esse trecho no arquivo.')
    text = text.slice(0, index) + removed + text.slice(index + added.length)
  } else if (hunk.removed.length > 0) {
    const anchor = hunk.after?.trim() ? hunk.after : ''
    const at = anchor ? text.indexOf(anchor) : -1
    text = at >= 0 ? `${text.slice(0, at)}${removed}\n${text.slice(at)}` : `${text.replace(/\n?$/, '\n')}${removed}\n`
  } else {
    throw new Error('Esse trecho não tem linhas para recusar.')
  }
  writeFileSync(abs, text, 'utf8')
  const rel = relativePath(folder, abs)
  if (previous !== null && text === previous) return null
  if (previous === null && text === '') return null
  return changeBetween(rel, previous, text)
}

export function searchWorkspace(folder: string, query: string, subpath?: string): string {
  const needle = query.trim().toLowerCase()
  if (needle.length < 2) throw new Error('A busca precisa de pelo menos 2 caracteres.')
  const root = subpath?.trim() ? resolveInside(folder, subpath.trim()) : folder
  if (!root || !existsSync(root)) throw new Error('Pasta de busca não encontrada.')
  const hits: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (hits.length >= MAX_MATCHES || depth > 6) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (hits.length >= MAX_MATCHES) return
      if (SKIP.has(name)) continue
      const abs = resolve(dir, name)
      let info: ReturnType<typeof statSync>
      try {
        info = statSync(abs)
      } catch {
        continue
      }
      const rel = relativePath(folder, abs)
      if (info.isDirectory()) {
        walk(abs, depth + 1)
        continue
      }
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
      if (name.toLowerCase().includes(needle)) hits.push(`${rel} · nome`)
      let raw: Buffer
      try {
        raw = readFileSync(abs)
      } catch {
        continue
      }
      if (raw.includes(0)) continue
      const lines = raw.toString('utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length && hits.length < MAX_MATCHES; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 180)}`)
        }
      }
    }
  }
  walk(root, 0)
  if (hits.length === 0) return 'Nenhuma ocorrência.'
  const more = hits.length >= MAX_MATCHES ? '\n… busca interrompida no limite de resultados.' : ''
  return `${hits.join('\n')}${more}`
}

export function runInFolder(
  folder: string,
  command: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; output: string }> {
  const text = command.trim()
  if (!text) throw new Error('Comando vazio.')
  if (text.length > 400) throw new Error('Comando longo demais.')
  if (/^\s*sudo\b/.test(text)) throw new Error('Não executo comandos com sudo.')
  return new Promise((resolvePromise) => {
    const child = spawn(text, { cwd: folder, shell: true, env: process.env })
    let output = ''
    const push = (chunk: Buffer): void => {
      if (output.length >= 12_000) return
      output += chunk.toString('utf8').slice(0, 12_000 - output.length)
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
    const stop = (): void => {
      child.kill('SIGTERM')
    }
    signal?.addEventListener('abort', stop)
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      const body = output.trim() || '(sem saída)'
      resolvePromise({ ok: code === 0, output: `código ${code ?? 'interrompido'}\n${body}` })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ ok: false, output: err.message })
    })
  })
}
