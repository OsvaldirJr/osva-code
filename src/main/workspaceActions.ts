import { spawn } from 'child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path'
import { changeBetween } from './changes'
import type { FileChange, WorkspaceDocument, WorkspaceFileContent } from '../shared/types'

const SKIP = new Set([
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
  'vendor',
  '__pycache__'
])
const MAX_MATCHES = 40
const MAX_FILE_BYTES = 300_000
const MAX_LIST_ENTRIES = 500
const MAX_LIST_DEPTH = 5

const VSCODE_CLI_PATHS = [
  '/usr/local/bin/code',
  '/opt/homebrew/bin/code',
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
]

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

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
const EDIT_LIMIT = 2_000_000

function imageMime(ext: string): string {
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'svg') return 'image/svg+xml'
  return `image/${ext}`
}

export function readWorkspaceFile(folder: string, filePath: string): WorkspaceFileContent {
  const root = resolve(folder)
  const abs = resolveInside(root, filePath.trim())
  if (!abs || !existsSync(abs)) throw new Error('Documento não encontrado na pasta de trabalho.')
  const info = statSync(abs)
  if (!info.isFile()) throw new Error('Isso é uma pasta. Abra um arquivo.')
  const name = basename(abs)
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  const path = relativePath(root, abs)
  if (IMAGE_EXT.has(ext)) {
    if (info.size > 4_000_000) {
      return { path, name, kind: 'binary', message: 'Esta imagem é grande demais para abrir aqui.' }
    }
    const dataUrl = `data:${imageMime(ext)};base64,${readFileSync(abs).toString('base64')}`
    return { path, name, kind: 'image', dataUrl }
  }
  if (info.size > EDIT_LIMIT) {
    const raw = Buffer.alloc(MAX_FILE_BYTES)
    const fd = openSync(abs, 'r')
    try {
      readSync(fd, raw, 0, MAX_FILE_BYTES, 0)
    } finally {
      closeSync(fd)
    }
    if (raw.includes(0)) {
      return { path, name, kind: 'binary', message: 'Este arquivo não é texto e não dá para ler aqui.' }
    }
    return {
      path,
      name,
      kind: ext === 'md' || ext === 'mdx' ? 'markdown' : 'text',
      text: raw.toString('utf8'),
      truncated: true
    }
  }
  const raw = readFileSync(abs)
  if (raw.includes(0)) {
    return { path, name, kind: 'binary', message: 'Este arquivo não é texto e não dá para ler aqui.' }
  }
  return {
    path,
    name,
    kind: ext === 'md' || ext === 'mdx' ? 'markdown' : 'text',
    text: raw.toString('utf8')
  }
}

export function writeWorkspaceFile(folder: string, filePath: string, text: string): void {
  const root = resolve(folder)
  const abs = resolveInside(root, filePath.trim())
  if (!abs || !existsSync(abs)) throw new Error('Documento não encontrado na pasta de trabalho.')
  const info = statSync(abs)
  if (!info.isFile()) throw new Error('Isso é uma pasta.')
  if (text.length > EDIT_LIMIT) throw new Error('O texto ficou grande demais para salvar por aqui.')
  writeFileSync(abs, text, 'utf8')
}

export function listWorkspaceFiles(folder: string): WorkspaceDocument[] {
  if (!folder || !existsSync(folder)) return []
  const items: WorkspaceDocument[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_LIST_DEPTH || items.length >= MAX_LIST_ENTRIES) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    const sorted = entries
      .filter((name) => !name.startsWith('.') && !SKIP.has(name))
      .sort((a, b) => a.localeCompare(b))

    const dirs: string[] = []
    const files: string[] = []
    for (const name of sorted) {
      const abs = resolve(dir, name)
      try {
        const info = statSync(abs)
        if (info.isDirectory()) dirs.push(name)
        else if (info.isFile()) files.push(name)
      } catch {
        // ignora entradas inacessíveis
      }
    }

    for (const name of dirs) {
      if (items.length >= MAX_LIST_ENTRIES) return
      const abs = resolve(dir, name)
      try {
        const info = statSync(abs)
        items.push({
          path: relativePath(folder, abs),
          name,
          kind: 'folder',
          size: 0,
          updatedAt: info.mtimeMs
        })
        walk(abs, depth + 1)
      } catch {
        // ignora
      }
    }

    for (const name of files) {
      if (items.length >= MAX_LIST_ENTRIES) return
      const abs = resolve(dir, name)
      try {
        const info = statSync(abs)
        items.push({
          path: relativePath(folder, abs),
          name,
          kind: 'file',
          size: info.size,
          updatedAt: info.mtimeMs
        })
      } catch {
        // ignora
      }
    }
  }

  walk(folder, 1)
  return items
}

export function openInVscode(
  folder: string,
  filePath?: string
): Promise<{ ok: boolean; error?: string }> {
  const root = resolve(folder)
  if (!existsSync(root)) {
    return Promise.resolve({ ok: false, error: 'Pasta de trabalho não encontrada.' })
  }
  const target = filePath?.trim() ? resolveInside(root, filePath.trim()) : root
  if (!target || !existsSync(target)) {
    return Promise.resolve({ ok: false, error: 'Documento não encontrado na pasta de trabalho.' })
  }

  const cliBin = VSCODE_CLI_PATHS.find((candidate) => existsSync(candidate))
  if (cliBin) {
    const args = target === root ? [root] : [root, target]
    return new Promise((resolvePromise) => {
      const child = spawn(cliBin, args, { detached: true, stdio: 'ignore' })
      child.on('error', (err) => resolvePromise({ ok: false, error: err.message }))
      child.unref()
      resolvePromise({ ok: true })
    })
  }

  if (process.platform === 'darwin') {
    return new Promise((resolvePromise) => {
      const args =
        target === root
          ? ['-a', 'Visual Studio Code', root]
          : ['-a', 'Visual Studio Code', target]
      const child = spawn('open', args)
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('close', (code) => {
        if (code === 0) {
          resolvePromise({ ok: true })
          return
        }
        const fallback = spawn('code', target === root ? [root] : [root, target], {
          shell: true,
          detached: true,
          stdio: 'ignore'
        })
        fallback.on('error', () => {
          resolvePromise({
            ok: false,
            error:
              stderr.trim() ||
              'Não foi possível abrir o VS Code. Verifique se o Visual Studio Code está instalado.'
          })
        })
        fallback.unref()
        resolvePromise({ ok: true })
      })
      child.on('error', (err) => resolvePromise({ ok: false, error: err.message }))
    })
  }

  return new Promise((resolvePromise) => {
    const child = spawn('code', target === root ? [root] : [root, target], {
      shell: true,
      detached: true,
      stdio: 'ignore'
    })
    child.on('error', (err) => resolvePromise({ ok: false, error: err.message }))
    child.unref()
    resolvePromise({ ok: true })
  })
}
