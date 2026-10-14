import type { FileChange } from '../../shared/types'

export type ArtifactKind = 'html' | 'svg' | 'markdown' | 'code'

export interface Artifact {
  id: string
  title: string
  kind: ArtifactKind
  language: string
  content: string
}

const PREVIEW_LANG = /^(html|svg|xml|markdown|md)$/i

/** Maior bloco cercado da resposta, preferindo HTML, SVG e Markdown. */
export function artifactFromMessage(messageId: string, content: string): Artifact | null {
  const fences = [...content.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)]
  if (fences.length === 0) return null
  const preferred = fences.find((match) => PREVIEW_LANG.test(match[1].trim()))
  const chosen =
    preferred ??
    fences.reduce((best, match) => (match[2].trim().length > best[2].trim().length ? match : best))
  const body = chosen[2].replace(/\s+$/, '')
  if (!preferred && body.length < 20) return null
  const language = chosen[1].trim().toLowerCase() || 'text'
  return {
    id: `msg:${messageId}`,
    title: titleFor(kindOf(language), language),
    kind: kindOf(language),
    language,
    content: body
  }
}

export function artifactFromChange(change: FileChange): Artifact | null {
  if (!change.preview) return null
  const language = change.path.split('.').pop()?.toLowerCase() ?? 'text'
  const kind = kindOf(language === 'htm' ? 'html' : language)
  const name = change.path.split('/').pop() ?? change.path
  return {
    id: `file:${change.path}`,
    title: name,
    kind,
    language,
    content: change.preview
  }
}

function kindOf(language: string): ArtifactKind {
  if (language === 'html' || language === 'xml' || language === 'htm') return 'html'
  if (language === 'svg') return 'svg'
  if (language === 'markdown' || language === 'md') return 'markdown'
  return 'code'
}

function titleFor(kind: ArtifactKind, language: string): string {
  if (kind === 'html') return 'Página HTML'
  if (kind === 'svg') return 'Imagem SVG'
  if (kind === 'markdown') return 'Documento'
  return `Código ${language}`
}
