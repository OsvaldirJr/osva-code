/** Peça que o modelo desenha no canvas da área Design. */
export type DesignKind = 'slides' | 'screen' | 'code' | 'system' | 'motion'

export type DesignElementType = 'rect' | 'round' | 'text' | 'ellipse' | 'line'

export interface DesignMotion {
  dx: number
  dy: number
  duration: number
}

export interface DesignElement {
  type: DesignElementType
  x: number
  y: number
  w: number
  h: number
  fill: string
  stroke: string
  radius: number
  text: string
  size: number
  weight: number
  align: 'left' | 'center' | 'right'
  opacity: number
  motion?: DesignMotion
}

export interface DesignFrame {
  name: string
  width: number
  height: number
  background: string
  elements: DesignElement[]
}

/** O que a ferramenta devolve para o canvas substituir. */
export interface DesignSnapshot {
  id: string
  title: string
  kind: DesignKind
  frames: DesignFrame[]
}

/** Design aberto enquanto o modelo desenha. */
export interface DesignContext {
  id: string
  kind: DesignKind
  title: string
}

export const DESIGN_KINDS: { kind: DesignKind; label: string; blurb: string }[] = [
  { kind: 'slides', label: 'Apresentação', blurb: 'Slides em sequência.' },
  { kind: 'screen', label: 'Tela', blurb: 'Uma tela de aplicativo.' },
  { kind: 'code', label: 'Design na base de código', blurb: 'A interface a partir do código.' },
  { kind: 'system', label: 'Sistema de design', blurb: 'Cores, tipo e componentes.' },
  { kind: 'motion', label: 'Motion', blurb: 'Uma peça com movimento.' }
]

export const DESIGN_SIZE: Record<DesignKind, { width: number; height: number }> = {
  slides: { width: 1280, height: 720 },
  screen: { width: 390, height: 844 },
  code: { width: 1280, height: 800 },
  system: { width: 1280, height: 900 },
  motion: { width: 1280, height: 720 }
}

const KINDS = new Set<string>(DESIGN_KINDS.map((item) => item.kind))
const TYPES = new Set<string>(['rect', 'round', 'text', 'ellipse', 'line'])

function num(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function color(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) return text
  if (/^(rgb|rgba|hsl|hsla)\(\s*[\d.,%\s]+\)$/i.test(text)) return text
  return fallback
}

function element(raw: unknown): DesignElement | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const type = typeof item.type === 'string' ? item.type : ''
  if (!TYPES.has(type)) return null
  const motionRaw = item.motion
  let motion: DesignMotion | undefined
  if (motionRaw && typeof motionRaw === 'object') {
    const motionItem = motionRaw as Record<string, unknown>
    motion = {
      dx: num(motionItem.dx, 0, -800, 800),
      dy: num(motionItem.dy, 0, -800, 800),
      duration: num(motionItem.duration, 1600, 200, 8000)
    }
  }
  const align = item.align === 'center' || item.align === 'right' ? item.align : 'left'
  return {
    type: type as DesignElementType,
    x: num(item.x, 0, -2000, 4000),
    y: num(item.y, 0, -2000, 4000),
    w: num(item.w, type === 'text' ? 400 : 80, 0, 4000),
    h: num(item.h, type === 'text' ? 48 : 80, 0, 4000),
    fill: color(item.fill, type === 'text' ? '#f4f6fb' : '#8b9cff'),
    stroke: color(item.stroke, 'transparent'),
    radius: num(item.radius, type === 'round' ? 16 : 0, 0, 800),
    text: typeof item.text === 'string' ? item.text.slice(0, 500) : '',
    size: num(item.size, 28, 8, 240),
    weight: num(item.weight, 600, 300, 800),
    align,
    opacity: num(item.opacity, 1, 0, 1),
    ...(motion ? { motion } : {})
  }
}

/** Converte o JSON do modelo no desenho que o canvas sabe pintar. */
export function normalizeDesign(raw: unknown, context: DesignContext): DesignSnapshot {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  if (!record || !Array.isArray(record.frames) || record.frames.length === 0) {
    throw new Error('design_canvas precisa de frames: uma lista com pelo menos um quadro.')
  }
  const kind = typeof record.kind === 'string' && KINDS.has(record.kind) ? (record.kind as DesignKind) : context.kind
  const size = DESIGN_SIZE[kind]
  const frames = record.frames.slice(0, 12).map((frame, index) => {
    const item = frame && typeof frame === 'object' ? (frame as Record<string, unknown>) : {}
    const elements = Array.isArray(item.elements)
      ? item.elements.map(element).filter((entry): entry is DesignElement => entry !== null).slice(0, 80)
      : []
    return {
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 80) : `Quadro ${index + 1}`,
      width: num(item.width, size.width, 200, 1920),
      height: num(item.height, size.height, 200, 1920),
      background: color(item.background, '#10141c'),
      elements
    }
  })
  if (frames.every((frame) => frame.elements.length === 0)) {
    throw new Error('Cada quadro precisa de elements: retângulos, textos, elipses ou linhas.')
  }
  const title =
    typeof record.title === 'string' && record.title.trim()
      ? record.title.trim().slice(0, 80)
      : context.title
  return { id: context.id, title, kind, frames }
}

export function designInstructions(context: DesignContext): string {
  const size = DESIGN_SIZE[context.kind]
  return (
    'Você está no programa Design do OsvaCode. O usuário vê um canvas, não um chat de código.\n' +
    'Desenhe chamando a ferramenta design_canvas. Ela substitui o desenho aberto.\n' +
    `O design aberto é “${context.title}”, do tipo ${context.kind}, no tamanho sugerido ${size.width}x${size.height}.\n` +
    'Tipos: slides (um frame por slide, 1280x720), screen (uma tela, 390x844), code (interface, 1280x800), system (cores e componentes, 1280x900), motion (peça animada, 1280x720).\n' +
    'Cada frame tem name, width, height, background e elements.\n' +
    'Cada element tem type (rect, round, text, ellipse ou line), x, y, w, h, fill, stroke, radius, text, size, weight, align (left, center ou right) e opacity.\n' +
    'Cores em #hex. Texto em português quando o pedido estiver em português. Títulos grandes, com size 48 ou mais em slides.\n' +
    'Em motion, element.motion = { dx, dy, duration } move o elemento em pixels ao longo de duration milissegundos.\n' +
    'Não descreva o layout só em texto. Se não conseguir chamar a ferramenta, responda com um bloco ```design contendo o mesmo JSON, com title, kind e frames.'
  )
}
