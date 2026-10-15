import { readFileSync, readdirSync, statSync } from 'fs'
import { basename, extname, join, relative } from 'path'
import type { PickedAttachment } from '../shared/types'

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  'coverage',
  'vendor',
  '__pycache__'
])

const SECRET = /(^|[\\/])(\.env|.*\.pem|.*\.key|id_rsa|credentials\.json)$/i

function readTextFile(filePath: string, maxChars: number): string | null {
  const stat = statSync(filePath)
  if (!stat.isFile() || stat.size > 250_000) return null
  const buffer = readFileSync(filePath)
  if (buffer.subarray(0, 8000).includes(0)) return null
  const text = buffer.toString('utf8')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(cortado)` : text
}

export function readImageAttachment(filePath: string): PickedAttachment | null {
  const name = basename(filePath)
  const mime = IMAGE_MIME[extname(name).toLowerCase()]
  if (!mime) return null
  const stat = statSync(filePath)
  if (!stat.isFile() || stat.size > 20_000_000) return null
  const data = readFileSync(filePath).toString('base64')
  return { kind: 'image', name, dataUrl: `data:${mime};base64,${data}` }
}

export function readFileAttachment(filePath: string): PickedAttachment {
  const name = basename(filePath)
  if (SECRET.test(name)) {
    return {
      kind: 'file',
      name,
      text: `--- Arquivo anexado: ${name} ---\n(arquivo sensível, conteúdo não incluído)`
    }
  }
  const text = readTextFile(filePath, 80_000)
  if (text == null) {
    return {
      kind: 'file',
      name,
      text: `--- Arquivo anexado: ${name} ---\n(arquivo binário ou grande demais, conteúdo não incluído)`
    }
  }
  return { kind: 'file', name, text: `--- Arquivo anexado: ${name} ---\n\`\`\`\n${text}\n\`\`\`` }
}

/** Árvore e trechos de texto da pasta, com teto para não estourar a conversa. */
export function readFolderAttachment(folder: string): PickedAttachment {
  const name = basename(folder)
  const tree: string[] = []
  const bodies: string[] = []
  const skipped: string[] = []
  let total = 0
  let files = 0

  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue
      const abs = join(dir, entry.name)
      const rel = relative(folder, abs)
      const indent = '  '.repeat(depth)
      if (entry.isDirectory()) {
        tree.push(`${indent}${entry.name}/`)
        walk(abs, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      tree.push(`${indent}${entry.name}`)
      if (files >= 40 || SECRET.test(entry.name)) {
        skipped.push(rel)
        continue
      }
      const text = readTextFile(abs, 12_000)
      if (text == null) continue
      if (total + text.length > 48_000) {
        skipped.push(rel)
        continue
      }
      files += 1
      total += text.length
      bodies.push(`--- ${rel} ---\n${text}`)
    }
  }

  walk(folder, 0)
  const text = [
    `--- Pasta anexada: ${name} ---`,
    tree.join('\n'),
    bodies.length ? `\n${bodies.join('\n\n')}` : '',
    skipped.length ? `\nNão incluídos por limite ou por serem sensíveis: ${skipped.slice(0, 24).join(', ')}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  return { kind: 'folder', name, text }
}
