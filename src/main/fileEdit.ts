import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'

/**
 * O modelo local repete a pasta de trabalho no caminho, às vezes sem a barra
 * inicial. path.resolve trata isso como relativo e cola a pasta de novo,
 * e a leitura falha com ENOENT num caminho duplicado.
 */
export function normalizeWorkspacePath(folder: string, input: string): string | null {
  let text = input.trim().replace(/\\/g, '/')
  if (!text) return null
  const root = folder.replace(/\/+$/, '')
  const rootBody = root.startsWith('/') ? root.slice(1) : root
  if (!text.startsWith('/') && (text === rootBody || text.startsWith(`${rootBody}/`))) {
    text = `/${text}`
  }
  const repeated = `${root}/${rootBody}`
  while (text.includes(repeated)) text = text.replace(repeated, root)

  const abs = isAbsolute(text) ? resolve(text) : resolve(root, text)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

interface TextEdit {
  oldText: string
  newText: string
}

interface Span {
  start: number
  end: number
  /** 1 = correspondência exata. Abaixo disso, o trecho era parecido o bastante. */
  score: number
}

/**
 * Aplica edit_file localmente. O servidor MCP de arquivos exige o trecho
 * idêntico e devolve "Could not find exact match" quando o modelo manda
 * aspas escapadas, um rótulo "HTML", espaços diferentes ou um caractere a
 * menos. A permissão do usuário já foi dada; aqui a edição entra mesmo assim.
 */
export function applyWorkspaceEdit(folder: string, args: Record<string, unknown>): string {
  const raw = stringArg(args, ['path', 'file_path', 'filename'])
  if (!raw) throw new Error('edit_file precisa do path absoluto do arquivo dentro da pasta de trabalho.')
  const abs = resolveInside(folder, raw)
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error(`Não encontrei o arquivo para editar: ${abs}. Se ele ainda não existe, use write_file.`)
  }

  const edits = editsFromArgs(args)
  if (edits.length === 0) {
    throw new Error('edit_file precisa de edits: uma lista com oldText (trecho atual) e newText (trecho novo).')
  }

  const original = readFileSync(abs, 'utf8')
  const next = applyEditsToText(original, edits)
  const dryRun = args.dryRun === true || args.dry_run === true
  if (!dryRun && next !== original) writeFileSync(abs, next, 'utf8')

  const verb = dryRun ? 'Simulação' : 'Arquivo editado'
  return `${verb}: ${abs}. ${edits.length} trecho(s) aplicado(s).`
}

export function applyEditsToText(original: string, edits: TextEdit[]): string {
  const newline = newlineOf(original)
  let content = original.replace(/\r\n/g, '\n').replace(/\r/g, '\n').normalize('NFC')
  for (const edit of edits) {
    const oldText = edit.oldText.normalize('NFC')
    const newText = edit.newText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').normalize('NFC')
    if (!oldText.trim()) {
      throw new Error('edit_file recebeu oldText vazio. Diga qual trecho do arquivo deve mudar.')
    }
    const span = locate(content, oldText)
    if (!span) throw unmatchedError(oldText)
    let replacement = alignReplacement(content, span, newText)
    const matched = content.slice(span.start, span.end)
    if (matched.endsWith('\n') && !replacement.endsWith('\n')) replacement += '\n'
    content = content.slice(0, span.start) + replacement + content.slice(span.end)
  }
  return newline === '\r\n' ? content.replace(/\n/g, '\r\n') : content
}

function editsFromArgs(args: Record<string, unknown>): TextEdit[] {
  const raw = args.edits ?? args.edit ?? args.changes
  const fromList = parseEdits(raw)
  if (fromList.length > 0) return fromList
  const oldText = stringArg(args, ['oldText', 'old_text', 'old_string', 'original', 'search'])
  const newText = stringArg(args, ['newText', 'new_text', 'new_string', 'replacement', 'replace'])
  if (oldText != null && newText != null) return [{ oldText, newText }]
  return []
}

function parseEdits(value: unknown): TextEdit[] {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    try {
      return parseEdits(JSON.parse(trimmed))
    } catch {
      return []
    }
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const obj = item as Record<string, unknown>
      const oldText = stringArg(obj, ['oldText', 'old_text', 'old_string', 'original', 'search', 'from'])
      const newText = stringArg(obj, ['newText', 'new_text', 'new_string', 'replacement', 'replace', 'to'])
      if (oldText == null || newText == null) return []
      return [{ oldText, newText }]
    })
  }
  if (value && typeof value === 'object') return parseEdits([value])
  return []
}

function stringArg(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return null
}

function resolveInside(folder: string, input: string): string {
  const abs = normalizeWorkspacePath(folder, input)
  if (!abs || abs === folder.replace(/\/+$/, '')) {
    throw new Error(`O caminho fica fora da pasta de trabalho ou não é um arquivo: ${input}`)
  }
  return abs
}

function newlineOf(original: string): '\n' | '\r\n' {
  const crlf = original.split('\r\n').length - 1
  const lf = original.split('\n').length - 1
  return crlf > 0 && crlf === lf ? '\r\n' : '\n'
}

function unmatchedError(oldText: string): Error {
  const preview = oldText.replace(/\s+/g, ' ').trim().slice(0, 90)
  return new Error(
    `Não encontrei no arquivo o trecho para substituir (“${preview}”). ` +
      'Leia o arquivo e copie o texto exato, ou reescreva o arquivo inteiro com write_file.'
  )
}

function locate(content: string, oldText: string): Span | null {
  const options = candidates(oldText)
  for (const candidate of options) {
    const exact = exactSpan(content, candidate)
    if (exact) return exact
  }
  for (const candidate of options) {
    const flex = regexSpan(content, candidate)
    if (flex) return flex
  }

  let best: Span | null = null
  for (const candidate of options) {
    for (const span of [fuzzyLineSpan(content, candidate), fuzzyLooseSpan(content, candidate)]) {
      if (!span) continue
      if (!best || span.score > best.score) best = span
    }
  }
  if (!best || best.score < 0.88) return null
  return best
}

function candidates(oldText: string): string[] {
  const seen = new Set<string>()
  const add = (value: string): void => {
    const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').normalize('NFC')
    if (!normalized.trim() || seen.has(normalized)) return
    seen.add(normalized)
  }
  const unescaped = unescapeModelText(oldText)
  for (const base of [oldText, unescaped]) {
    add(base)
    const fence = stripLooseFence(base)
    const numbered = stripLineNumbers(base)
    const labeled = stripLanguageLabel(base)
    add(fence)
    add(numbered)
    add(labeled)
    add(stripLanguageLabel(fence))
    add(stripLineNumbers(fence))
    add(stripLanguageLabel(numbered))
  }
  return [...seen]
}

function unescapeModelText(text: string): string {
  if (!text.includes('\\')) return text
  return text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
}

function stripLooseFence(text: string): string {
  let out = text.trim()
  out = out.replace(/^```[a-zA-Z0-9_-]*[ \t]*\n?/, '')
  out = out.replace(/\n?```$/, '')
  return out
}

const LANGUAGE_LINE = /^(?:html|css|javascript|js|jsx|ts|tsx|json|markdown|md|python|py|txt)\s*$/i

function stripLanguageLabel(text: string): string {
  const lines = text.split('\n')
  if (lines.length < 2 || !LANGUAGE_LINE.test(lines[0].trim())) return text
  return lines.slice(1).join('\n')
}

function stripLineNumbers(text: string): string {
  const lines = text.split('\n')
  const numbered = lines.filter((line) => /^\s*\d+\s*[|:]\s?/.test(line))
  if (numbered.length < Math.max(1, Math.ceil(lines.length * 0.6))) return text
  return lines.map((line) => line.replace(/^\s*\d+\s*[|:]\s?/, '')).join('\n')
}

function exactSpan(content: string, needle: string): Span | null {
  const at = content.indexOf(needle)
  if (at < 0) return null
  return { start: at, end: at + needle.length, score: 1 }
}

function regexSpan(content: string, needle: string): Span | null {
  const trimmed = needle.trim()
  if (trimmed.length < 8) return null
  const pattern = flexiblePattern(trimmed)
  if (!pattern || pattern.length > 20000) return null
  let match: RegExpExecArray | null
  try {
    match = new RegExp(pattern, 'u').exec(content)
  } catch {
    return null
  }
  if (!match || match.index == null) return null
  return { start: match.index, end: match.index + match[0].length, score: 0.99 }
}

function flexiblePattern(needle: string): string | null {
  let pattern = ''
  let i = 0
  while (i < needle.length) {
    if (/\s/u.test(needle[i])) {
      pattern += '\\s+'
      while (i < needle.length && /\s/u.test(needle[i])) i++
      continue
    }
    if (needle.startsWith('&quot;', i)) {
      pattern += '(?:"|&quot;)'
      i += 6
      continue
    }
    const ch = needle[i]
    const next = needle[i + 1]
    if (ch === '\\' && (next === '"' || next === "'")) {
      pattern += '[\"\'“”‘’]'
      i += 2
      continue
    }
    if ('"\'“”‘’'.includes(ch)) {
      pattern += '[\"\'“”‘’]'
      i++
      continue
    }
    pattern += escapeRegex(ch)
    i++
  }
  return pattern || null
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fuzzyLineSpan(content: string, needle: string): Span | null {
  const hay = content.split('\n')
  const need = needle.split('\n')
  const haySig = hay.map((line, index) => ({ line, index })).filter((item) => item.line.trim())
  const needSig = need.filter((line) => line.trim())
  if (needSig.length === 0 || needSig.length > haySig.length) return null
  if (hay.length > 2500 || needSig.length > 120) return null

  const hayLoose = haySig.map((item) => looseKey(item.line))
  const needLoose = needSig.map((line) => looseKey(line))
  let bestScore = 0
  let second = 0
  let bestAt = -1
  for (let k = 0; k <= hayLoose.length - needLoose.length; k++) {
    let score = 0
    for (let j = 0; j < needLoose.length; j++) score += similarity(hayLoose[k + j], needLoose[j])
    score /= needLoose.length
    if (score > bestScore) {
      second = bestScore
      bestScore = score
      bestAt = k
    } else if (score > second) {
      second = score
    }
  }
  if (bestAt < 0 || bestScore < 0.9) return null
  if (second >= 0.9 && bestScore - second < 0.03) return null

  const fromLine = haySig[bestAt].index
  const toLine = haySig[bestAt + needLoose.length - 1].index
  const offsets = lineOffsets(content)
  const start = offsets[fromLine] ?? 0
  const end = toLine + 1 < offsets.length ? offsets[toLine + 1] : content.length
  return { start, end, score: bestScore }
}

function fuzzyLooseSpan(content: string, needle: string): Span | null {
  const hay = toLoose(content)
  const ned = toLoose(needle)
  const n = ned.text.length
  const h = hay.text.length
  if (n < 12 || n > 800 || h < n || h > 12000) return null
  const limit = Math.max(1, Math.floor(n * 0.12))
  let bestDist = limit + 1
  let second = limit + 1
  let bestAt = -1
  const overlapsBest = (at: number): boolean => bestAt >= 0 && at < bestAt + n && bestAt < at + n
  const step = n > 240 ? 2 : 1
  for (let i = 0; i <= h - n; i += step) {
    const dist = levenshteinLimit(hay.text.slice(i, i + n), ned.text, limit)
    if (dist > limit) continue
    if (dist < bestDist) {
      if (bestAt >= 0 && !overlapsBest(i)) second = Math.min(second, bestDist)
      bestDist = dist
      bestAt = i
    } else if (!overlapsBest(i) && dist < second) {
      second = dist
    }
  }
  if (bestAt < 0) return null
  if (second <= limit && second - bestDist <= 1) return null
  const start = hay.originStart[bestAt]
  const last = bestAt + n - 1
  const end = hay.originEnd[last] ?? content.length
  return { start, end, score: 1 - bestDist / n }
}

function similarity(a: string, b: string): number {
  if (a === b) return 1
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  const bound = Math.floor(max * 0.22)
  if (Math.abs(a.length - b.length) > bound) return 0
  const dist = levenshteinLimit(a, b, bound)
  if (dist > bound) return 0
  return 1 - dist / max
}

function levenshteinLimit(a: string, b: string, max: number): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = curr[0]
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (rowMin > max) return max + 1
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[b.length]
}

interface LooseForm {
  text: string
  originStart: number[]
  originEnd: number[]
}

function looseKey(input: string): string {
  return toLoose(input).text
}

function toLoose(input: string): LooseForm {
  const text: string[] = []
  const originStart: number[] = []
  const originEnd: number[] = []
  let i = 0
  while (i < input.length && isSpace(input[i])) i++
  let spaceFrom = -1
  while (i < input.length) {
    if (isSpace(input[i])) {
      if (spaceFrom < 0) spaceFrom = i
      i++
      continue
    }
    if (spaceFrom >= 0 && text.length > 0) {
      text.push(' ')
      originStart.push(spaceFrom)
      originEnd.push(i)
      spaceFrom = -1
    }
    let ch = input[i]
    let end = i + 1
    const next = input[i + 1]
    if (ch === '\\' && (next === '"' || next === "'")) {
      ch = next
      end = i + 2
    } else if ('“”«»'.includes(ch)) {
      ch = '"'
    } else if ('‘’'.includes(ch)) {
      ch = "'"
    }
    text.push(ch)
    originStart.push(i)
    originEnd.push(end)
    i = end
  }
  return { text: text.join(''), originStart, originEnd }
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\f' || ch === '\v'
}

function lineOffsets(text: string): number[] {
  const offsets = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1)
  return offsets
}

function alignReplacement(content: string, span: Span, newText: string): string {
  const atLineStart = span.start === 0 || content[span.start - 1] === '\n'
  const atLineEnd = span.end === content.length || content[span.end - 1] === '\n'
  if (!atLineStart || !atLineEnd) return newText
  const matched = content.slice(span.start, span.end)
  const fileIndent = matched.match(/^[ \t]*/)?.[0] ?? ''
  if (!fileIndent) return newText
  const lines = newText.split('\n')
  const firstCode = lines.find((line) => line.trim())
  const newIndent = firstCode?.match(/^[ \t]*/)?.[0] ?? ''
  if (newIndent.length > 0) return newText
  return lines.map((line) => (line.length ? fileIndent + line : line)).join('\n')
}
