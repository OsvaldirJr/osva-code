import { existsSync, readFileSync, statSync } from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'
import type { DiffLine, FileChange } from '../shared/types'

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'move_file'])
const PREVIEW_EXT = new Set(['html', 'htm', 'svg', 'md', 'markdown'])
const MAX_BYTES = 1_000_000
const PREVIEW_CHARS = 200_000
const CONTEXT = 3
const LCS_LINE_CAP = 400
const LCS_CELL_CAP = 250_000
const MAX_DIFF_LINES = 1_500

type ReadResult = { status: 'missing' } | { status: 'skip' } | { status: 'text'; text: string }

interface Snapshot {
  abs: string
  rel: string
  before: ReadResult
}

/**
 * Lê os arquivos antes de uma ferramenta de escrita da pasta de trabalho.
 * O retorno só deve ser chamado depois que a ferramenta terminou com sucesso.
 */
export function beginFileChange(
  folder: string | null,
  workspaceTool: boolean,
  toolName: string,
  args: Record<string, unknown>
): (() => FileChange[]) | null {
  if (!folder || !workspaceTool || !WRITE_TOOLS.has(toolName)) return null

  const rawPaths: string[] = []
  if (toolName === 'move_file') {
    const source = stringArg(args, ['source', 'from', 'old_path', 'path'])
    const destination = stringArg(args, ['destination', 'to', 'new_path'])
    if (source) rawPaths.push(source)
    if (destination) rawPaths.push(destination)
  } else {
    const path = stringArg(args, ['path', 'file_path', 'filename'])
    if (path) rawPaths.push(path)
  }
  if (rawPaths.length === 0) return null

  const snaps: Snapshot[] = []
  for (const raw of rawPaths) {
    const abs = insideFolder(folder, raw)
    if (!abs) continue
    snaps.push({ abs, rel: toRel(folder, abs), before: readText(abs) })
  }
  if (snaps.length === 0) return null

  return () => {
    const changes: FileChange[] = []
    for (const snap of snaps) {
      const change = buildChange(snap.rel, snap.before, readText(snap.abs))
      if (change) changes.push(change)
    }
    return changes
  }
}

function stringArg(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function insideFolder(folder: string, input: string): string | null {
  const abs = resolve(folder, input)
  const rel = relative(folder, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

function toRel(folder: string, abs: string): string {
  return relative(folder, abs).split(sep).join('/')
}

function readText(abs: string): ReadResult {
  try {
    if (!existsSync(abs)) return { status: 'missing' }
    const stat = statSync(abs)
    if (!stat.isFile() || stat.size > MAX_BYTES) return { status: 'skip' }
    const buf = readFileSync(abs)
    if (buf.includes(0)) return { status: 'skip' }
    return { status: 'text', text: buf.toString('utf8') }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { status: 'missing' }
    return { status: 'skip' }
  }
}

function buildChange(rel: string, before: ReadResult, after: ReadResult): FileChange | null {
  if (before.status === 'skip' || after.status === 'skip') return null
  if (before.status === 'missing' && after.status === 'missing') return null
  const beforeText = before.status === 'text' ? before.text : ''
  const afterText = after.status === 'text' ? after.text : ''
  if (before.status === 'text' && after.status === 'text' && beforeText === afterText) return null

  const kind: FileChange['kind'] =
    before.status === 'missing' ? 'added' : after.status === 'missing' ? 'deleted' : 'modified'
  const full = lineDiff(splitLines(beforeText), splitLines(afterText))
  const additions = full.filter((line) => line.type === 'add').length
  const deletions = full.filter((line) => line.type === 'del').length
  const lines =
    full.length > MAX_DIFF_LINES
      ? [
          ...full.slice(0, MAX_DIFF_LINES),
          { type: 'gap' as const, text: `… mais ${full.length - MAX_DIFF_LINES} linhas omitidas …` }
        ]
      : full
  const preview = after.status === 'text' ? previewOf(rel, after.text) : undefined
  const revertable =
    (before.status !== 'text' || before.text.length <= 200_000) &&
    (after.status !== 'text' || after.text.length <= 200_000)
  return {
    path: rel,
    kind,
    additions,
    deletions,
    lines,
    preview,
    ...(revertable ? { previous: before.status === 'text' ? before.text : null } : {})
  }
}

/** Diferença entre o texto anterior guardado e o arquivo depois de aceitar ou recusar um trecho. */
export function changeBetween(rel: string, previous: string | null, next: string | null): FileChange | null {
  return buildChange(
    rel,
    previous === null ? { status: 'missing' } : { status: 'text', text: previous },
    next === null ? { status: 'missing' } : { status: 'text', text: next }
  )
}

function previewOf(rel: string, text: string): string | undefined {
  const ext = rel.split('.').pop()?.toLowerCase() ?? ''
  if (!PREVIEW_EXT.has(ext)) return undefined
  return text.slice(0, PREVIEW_CHARS)
}

function splitLines(text: string): string[] {
  if (!text) return []
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  return trimmed.split('\n')
}

function lineDiff(before: string[], after: string[]): DiffLine[] {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }

  const midBefore = before.slice(start, endBefore)
  const midAfter = after.slice(start, endAfter)
  const middle =
    midBefore.length <= LCS_LINE_CAP &&
    midAfter.length <= LCS_LINE_CAP &&
    midBefore.length * midAfter.length <= LCS_CELL_CAP
      ? lcsDiff(midBefore, midAfter)
      : [
          ...midBefore.map((text) => ({ type: 'del' as const, text })),
          { type: 'gap' as const, text: '… trecho grande demais para alinhar linha a linha …' },
          ...midAfter.map((text) => ({ type: 'add' as const, text }))
        ]

  return collapseContext(
    [
      ...before.slice(0, start).map((text) => ({ type: 'ctx' as const, text })),
      ...middle,
      ...before.slice(endBefore).map((text) => ({ type: 'ctx' as const, text }))
    ],
    CONTEXT
  )
}

function lcsDiff(before: string[], after: string[]): DiffLine[] {
  const rows = before.length
  const cols = after.length
  const scores: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0))
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      scores[i][j] =
        before[i] === after[j] ? scores[i + 1][j + 1] + 1 : Math.max(scores[i + 1][j], scores[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      out.push({ type: 'ctx', text: before[i] })
      i++
      j++
    } else if (scores[i + 1][j] >= scores[i][j + 1]) {
      out.push({ type: 'del', text: before[i] })
      i++
    } else {
      out.push({ type: 'add', text: after[j] })
      j++
    }
  }
  while (i < rows) out.push({ type: 'del', text: before[i++] })
  while (j < cols) out.push({ type: 'add', text: after[j++] })
  return out
}

function collapseContext(lines: DiffLine[], radius: number): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.type === 'ctx') return
    const from = Math.max(0, index - radius)
    const to = Math.min(lines.length - 1, index + radius)
    for (let i = from; i <= to; i++) keep[i] = true
  })

  const out: DiffLine[] = []
  let hidden = 0
  const flush = (): void => {
    if (hidden === 0) return
    out.push({
      type: 'gap',
      text: hidden === 1 ? '1 linha sem alteração' : `${hidden} linhas sem alteração`
    })
    hidden = 0
  }
  lines.forEach((line, index) => {
    if (keep[index]) {
      flush()
      out.push(line)
    } else {
      hidden++
    }
  })
  flush()
  return out
}
