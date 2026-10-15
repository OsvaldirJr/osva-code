import { useEffect, useRef } from 'react'
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
  animate = false
}: {
  frame: DesignFrame
  animate?: boolean
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let frameId = 0
    const draw = (time: number): void => {
      const bounds = host.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const scale = Math.min(bounds.width / frame.width, bounds.height / frame.height)
      const safe = Number.isFinite(scale) && scale > 0 ? scale : 1
      canvas.width = Math.max(1, Math.floor(frame.width * safe * dpr))
      canvas.height = Math.max(1, Math.floor(frame.height * safe * dpr))
      canvas.style.width = `${Math.floor(frame.width * safe)}px`
      canvas.style.height = `${Math.floor(frame.height * safe)}px`
      ctx.setTransform(dpr * safe, 0, 0, dpr * safe, 0, 0)
      paintFrame(ctx, frame, time)
      if (animate) frameId = window.requestAnimationFrame(draw)
    }
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

  return (
    <div className="design-canvas-host" ref={hostRef}>
      <canvas ref={canvasRef} className="design-canvas" />
    </div>
  )
}
