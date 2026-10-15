import { useEffect, useRef, type PointerEvent } from 'react'
import type { DesignElement, DesignFrame, DesignKind } from '../../../shared/design'
import { DESIGN_SIZE } from '../../../shared/design'

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : ['']
}

function paintElement(ctx: CanvasRenderingContext2D, element: DesignElement, time: number): void {
  let x = element.x
  let y = element.y
  if (element.motion && element.motion.duration > 0) {
    const wave = Math.sin((time / element.motion.duration) * Math.PI * 2)
    x += element.motion.dx * wave
    y += element.motion.dy * wave
  }
  ctx.save()
  ctx.globalAlpha = element.opacity
  ctx.fillStyle = element.fill
  ctx.strokeStyle = element.stroke
  ctx.lineWidth = 2
  if (element.type === 'ellipse') {
    ctx.beginPath()
    ctx.ellipse(x + element.w / 2, y + element.h / 2, Math.max(element.w / 2, 0.5), Math.max(element.h / 2, 0.5), 0, 0, Math.PI * 2)
    ctx.fill()
    if (element.stroke !== 'transparent') ctx.stroke()
  } else if (element.type === 'line') {
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + element.w, y + element.h)
    ctx.strokeStyle = element.stroke === 'transparent' ? element.fill : element.stroke
    ctx.stroke()
  } else if (element.type === 'text') {
    ctx.font = `${element.weight} ${element.size}px "SF Pro Text", -apple-system, sans-serif`
    ctx.textAlign = element.align
    ctx.textBaseline = 'top'
    const anchor = element.align === 'center' ? x + element.w / 2 : element.align === 'right' ? x + element.w : x
    const lines = wrapText(ctx, element.text, Math.max(element.w, 40))
    lines.forEach((line, index) => ctx.fillText(line, anchor, y + index * element.size * 1.25))
  } else {
    const radius = element.type === 'round' ? element.radius : 0
    ctx.beginPath()
    ctx.roundRect(x, y, element.w, element.h, radius)
    ctx.fill()
    if (element.stroke !== 'transparent') ctx.stroke()
  }
  ctx.restore()
}

export function paintFrame(ctx: CanvasRenderingContext2D, frame: DesignFrame, time: number): void {
  ctx.clearRect(0, 0, frame.width, frame.height)
  ctx.fillStyle = frame.background
  ctx.fillRect(0, 0, frame.width, frame.height)
  for (const element of frame.elements) paintElement(ctx, element, time)
}

function jpegPage(frame: DesignFrame): { width: number; height: number; bytes: Uint8Array } | null {
  const canvas = document.createElement('canvas')
  canvas.width = frame.width
  canvas.height = frame.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  paintFrame(ctx, frame, 0)
  const url = canvas.toDataURL('image/jpeg', 0.82)
  const raw = atob(url.slice(url.indexOf(',') + 1))
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index)
  return { width: frame.width, height: frame.height, bytes }
}

function buildPdf(pages: { width: number; height: number; bytes: Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const push = (data: Uint8Array | string): void => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    chunks.push(bytes)
    length += bytes.length
  }
  push('%PDF-1.3\n')
  const pageIds = pages.map((_, index) => 3 + index * 3)
  offsets.push(length)
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  offsets.push(length)
  push(
    `2 0 obj\n<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>\nendobj\n`
  )
  pages.forEach((page, index) => {
    const pageId = 3 + index * 3
    const contentId = pageId + 1
    const imageId = pageId + 2
    const content = `q\n${page.width} 0 0 ${page.height} 0 0 cm\n/Im0 Do\nQ\n`
    offsets.push(length)
    push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`
    )
    offsets.push(length)
    push(`${contentId} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`)
    offsets.push(length)
    push(
      `${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`
    )
    push(page.bytes)
    push('\nendstream\nendobj\n')
  })
  const xref = length
  const count = 2 + pages.length * 3
  let xrefBody = `xref\n0 ${count + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) xrefBody += `${String(offset).padStart(10, '0')} 00000 n \n`
  push(xrefBody)
  push(`trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)
  const out = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

export function downloadPdf(frames: DesignFrame[], title: string): void {
  const pages = frames.flatMap((frame) => {
    const page = jpegPage(frame)
    return page ? [page] : []
  })
  if (pages.length === 0) return
  const pdf = buildPdf(pages)
  const blob = new Blob([pdf.buffer as ArrayBuffer], { type: 'application/pdf' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${title || 'design'}.pdf`
  link.click()
  URL.revokeObjectURL(link.href)
}

export function downloadFrame(frame: DesignFrame, title: string): void {
  const canvas = document.createElement('canvas')
  canvas.width = frame.width
  canvas.height = frame.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  paintFrame(ctx, frame, 0)
  const link = document.createElement('a')
  link.href = canvas.toDataURL('image/png')
  link.download = `${title || 'design'}.png`
  link.click()
}

/** Miniatura ilustrada de cada tipo, antes de existir um design salvo. */
export function sampleFrame(kind: DesignKind): DesignFrame {
  const size = kind === 'screen' ? { width: 180, height: 320 } : { width: 320, height: 180 }
  if (kind === 'slides') {
    return {
      name: 'Slide',
      ...size,
      background: '#161a24',
      elements: [
        { type: 'round', x: 22, y: 28, w: 46, h: 8, fill: '#8b9cff', stroke: 'transparent', radius: 8, text: '', size: 12, weight: 600, align: 'left', opacity: 1 },
        { type: 'text', x: 22, y: 52, w: 260, h: 40, fill: '#f4f6fb', stroke: 'transparent', radius: 0, text: 'Título do slide', size: 28, weight: 700, align: 'left', opacity: 1 },
        { type: 'text', x: 22, y: 100, w: 240, h: 40, fill: '#9aa3b8', stroke: 'transparent', radius: 0, text: 'Uma ideia por quadro.', size: 16, weight: 500, align: 'left', opacity: 1 }
      ]
    }
  }
  if (kind === 'screen') {
    return {
      name: 'Tela',
      width: size.width,
      height: size.height,
      background: '#12151d',
      elements: [
        { type: 'round', x: 16, y: 28, w: 148, h: 64, fill: '#8b9cff', stroke: 'transparent', radius: 16, text: '', size: 12, weight: 600, align: 'left', opacity: 1 },
        { type: 'round', x: 16, y: 108, w: 148, h: 36, fill: '#1d2330', stroke: 'transparent', radius: 12, text: '', size: 12, weight: 600, align: 'left', opacity: 1 },
        { type: 'round', x: 16, y: 152, w: 148, h: 36, fill: '#1d2330', stroke: 'transparent', radius: 12, text: '', size: 12, weight: 600, align: 'left', opacity: 1 },
        { type: 'round', x: 16, y: 196, w: 148, h: 36, fill: '#1d2330', stroke: 'transparent', radius: 12, text: '', size: 12, weight: 600, align: 'left', opacity: 1 }
      ]
    }
  }
  if (kind === 'code') {
    return {
      name: 'Código',
      ...size,
      background: '#10141c',
      elements: [
        { type: 'round', x: 16, y: 16, w: 288, h: 148, fill: '#1a2030', stroke: 'transparent', radius: 14, text: '', size: 12, weight: 600, align: 'left', opacity: 1 },
        { type: 'ellipse', x: 30, y: 28, w: 10, h: 10, fill: '#f07178', stroke: 'transparent', radius: 0, text: '', size: 12, weight: 600, align: 'left', opacity: 1 },
        { type: 'ellipse', x: 46, y: 28, w: 10, h: 10, fill: '#e8b84a', stroke: 'transparent', radius: 0, text: '', size: 12, weight: 600, align: 'left', opacity: 1 },
        { type: 'ellipse', x: 62, y: 28, w: 10, h: 10, fill: '#3dd68c', stroke: 'transparent', radius: 0, text: '', size: 12, weight: 600, align: 'left', opacity: 1 },
        { type: 'round', x: 30, y: 56, w: 180, h: 8, fill: '#8b9cff', stroke: 'transparent', radius: 6, text: '', size: 12, weight: 600, align: 'left', opacity: 1 },
        { type: 'round', x: 30, y: 74, w: 140, h: 8, fill: '#3a445c', stroke: 'transparent', radius: 6, text: '', size: 12, weight: 600, align: 'left', opacity: 1 },
        { type: 'round', x: 30, y: 92, w: 210, h: 8, fill: '#3a445c', stroke: 'transparent', radius: 6, text: '', size: 12, weight: 600, align: 'left', opacity: 1 }
      ]
    }
  }
  if (kind === 'system') {
    return {
      name: 'Sistema',
      ...size,
      background: '#141820',
      elements: [
        { type: 'round', x: 18, y: 24, w: 42, h: 42, fill: '#8b9cff', stroke: 'transparent', radius: 12, text: '', size: 12, weight: 600, align: 'left', opacity: 1 },
        { type: 'round', x: 68, y: 24, w: 42, h: 42, fill: '#3dd68c', stroke: 'transparent', radius: 12, text: '', size: 12, weight: 600, align: 'left', opacity: 1 },
        { type: 'round', x: 118, y: 24, w: 42, h: 42, fill: '#e8b84a', stroke: 'transparent', radius: 12, text: '', size: 12, weight: 600, align: 'left', opacity: 1 },
        { type: 'round', x: 168, y: 24, w: 42, h: 42, fill: '#f07178', stroke: 'transparent', radius: 12, text: '', size: 12, weight: 600, align: 'left', opacity: 1 },
        { type: 'text', x: 18, y: 86, w: 280, h: 36, fill: '#f4f6fb', stroke: 'transparent', radius: 0, text: 'Aa Sistema', size: 28, weight: 700, align: 'left', opacity: 1 },
        { type: 'round', x: 18, y: 132, w: 120, h: 28, fill: '#8b9cff', stroke: 'transparent', radius: 14, text: '', size: 12, weight: 600, align: 'left', opacity: 1 }
      ]
    }
  }
  return {
    name: 'Motion',
    width: DESIGN_SIZE.motion.width > 0 ? 320 : 320,
    height: 180,
    background: '#121018',
    elements: [
      {
        type: 'ellipse',
        x: 36,
        y: 50,
        w: 80,
        h: 80,
        fill: '#8b9cff',
        stroke: 'transparent',
        radius: 0,
        text: '',
        size: 12,
        weight: 600,
        align: 'left',
        opacity: 0.9,
        motion: { dx: 28, dy: 0, duration: 1800 }
      },
      {
        type: 'ellipse',
        x: 150,
        y: 70,
        w: 48,
        h: 48,
        fill: '#e8b84a',
        stroke: 'transparent',
        radius: 0,
        text: '',
        size: 12,
        weight: 600,
        align: 'left',
        opacity: 1,
        motion: { dx: 0, dy: 18, duration: 1200 }
      },
      {
        type: 'round',
        x: 220,
        y: 64,
        w: 64,
        h: 64,
        fill: '#3dd68c',
        stroke: 'transparent',
        radius: 18,
        text: '',
        size: 12,
        weight: 600,
        align: 'left',
        opacity: 1,
        motion: { dx: -16, dy: 10, duration: 2000 }
      }
    ]
  }
}

export function DesignCanvas({
  frame,
  animate = false,
  onMove
}: {
  frame: DesignFrame
  animate?: boolean
  onMove?: (index: number, x: number, y: number) => void
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    index: number
    x: number
    y: number
    grabX: number
    grabY: number
    pointerId: number
  } | null>(null)
  const drawRef = useRef<(time: number) => void>(() => {})

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let frameId = 0
    const painted = (): DesignFrame => {
      const drag = dragRef.current
      if (!drag) return frame
      return {
        ...frame,
        elements: frame.elements.map((element, index) =>
          index === drag.index ? { ...element, x: drag.x, y: drag.y } : element
        )
      }
    }
    const draw = (time: number): void => {
      const current = painted()
      const bounds = host.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const scale = Math.min(bounds.width / current.width, bounds.height / current.height)
      const safe = Number.isFinite(scale) && scale > 0 ? scale : 1
      canvas.width = Math.max(1, Math.floor(current.width * safe * dpr))
      canvas.height = Math.max(1, Math.floor(current.height * safe * dpr))
      canvas.style.width = `${Math.floor(current.width * safe)}px`
      canvas.style.height = `${Math.floor(current.height * safe)}px`
      ctx.setTransform(dpr * safe, 0, 0, dpr * safe, 0, 0)
      paintFrame(ctx, current, time)
      if (animate) frameId = window.requestAnimationFrame(draw)
    }
    drawRef.current = draw
    frameId = window.requestAnimationFrame(draw)
    const observer = new ResizeObserver(() => {
      if (!animate) draw(0)
    })
    observer.observe(host)
    return () => {
      window.cancelAnimationFrame(frameId)
      observer.disconnect()
    }
  }, [frame, animate])

  const pointOf = (event: PointerEvent<HTMLCanvasElement>): { x: number; y: number } | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: ((event.clientX - rect.left) / rect.width) * frame.width,
      y: ((event.clientY - rect.top) / rect.height) * frame.height
    }
  }

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>): void => {
    if (!onMove) return
    const point = pointOf(event)
    if (!point) return
    for (let index = frame.elements.length - 1; index >= 0; index--) {
      const element = frame.elements[index]
      const inside =
        point.x >= element.x &&
        point.x <= element.x + Math.max(element.w, 8) &&
        point.y >= element.y &&
        point.y <= element.y + Math.max(element.h, 8)
      if (!inside) continue
      dragRef.current = {
        index,
        x: element.x,
        y: element.y,
        grabX: point.x - element.x,
        grabY: point.y - element.y,
        pointerId: event.pointerId
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const point = pointOf(event)
    if (!point) return
    drag.x = Math.round(point.x - drag.grabX)
    drag.y = Math.round(point.y - drag.grabY)
    if (!animate) drawRef.current(0)
  }

  const endDrag = (event: PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    onMove?.(drag.index, drag.x, drag.y)
  }

  return (
    <div className="design-canvas-host" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className={onMove ? 'design-canvas editable' : 'design-canvas'}
        onPointerDown={onMove ? onPointerDown : undefined}
        onPointerMove={onMove ? onPointerMove : undefined}
        onPointerUp={onMove ? endDrag : undefined}
        onPointerCancel={onMove ? endDrag : undefined}
      />
    </div>
  )
}
