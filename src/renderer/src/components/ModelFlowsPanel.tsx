import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from 'react'
import { Copy, Plus, Split, Trash2, Workflow, X } from 'lucide-react'
import type { AppSettings, FlowEdge, FlowNode, ModelFlow, ProviderConfig } from '../../../shared/types'

const WORLD = { w: 2400, h: 1600 }

type Point = { x: number; y: number }
type PortOffsets = Record<string, { inn: Point | null; out: Point | null }>

function exampleFlow(providerId: string): ModelFlow {
  const entry = crypto.randomUUID()
  const decide = crypto.randomUUID()
  const easy = crypto.randomUUID()
  const hard = crypto.randomUUID()
  const check = crypto.randomUUID()
  return {
    id: crypto.randomUUID(),
    name: 'Código com verificação',
    nodes: [
      { id: entry, kind: 'entry', name: 'Entrada', x: 48, y: 250, providerId: '', instruction: '' },
      {
        id: decide,
        kind: 'decide',
        name: 'Classificar',
        x: 360,
        y: 210,
        providerId,
        instruction:
          'Leia o pedido e escolha a rota. Código curto, local ou óbvio é simples. Arquitetura, vários arquivos ou algo ambíguo é difícil.'
      },
      {
        id: easy,
        kind: 'model',
        name: 'Código simples',
        x: 760,
        y: 40,
        providerId,
        instruction: 'Resolva o pedido de código simples e entregue a solução para a etapa seguinte conferir.'
      },
      {
        id: hard,
        kind: 'model',
        name: 'Código difícil',
        x: 760,
        y: 400,
        providerId,
        instruction: 'Resolva a parte difícil com rigor e entregue a solução para a etapa seguinte conferir.'
      },
      {
        id: check,
        kind: 'model',
        name: 'Verificar',
        x: 1160,
        y: 220,
        providerId,
        instruction:
          'Confira a resposta anterior. Se estiver correta, entregue a versão final. Se houver erro, corrija e entregue a versão corrigida.'
      }
    ],
    edges: [
      { id: crypto.randomUUID(), from: entry, to: decide, when: '' },
      { id: crypto.randomUUID(), from: decide, to: easy, when: 'código simples' },
      { id: crypto.randomUUID(), from: decide, to: hard, when: 'código difícil' },
      { id: crypto.randomUUID(), from: easy, to: check, when: '' },
      { id: crypto.randomUUID(), from: hard, to: check, when: '' }
    ]
  }
}

function blankNode(kind: 'decide' | 'model', providerId: string, x: number, y: number): FlowNode {
  return {
    id: crypto.randomUUID(),
    kind,
    name: kind === 'decide' ? 'Decisão' : 'Modelo',
    x,
    y,
    providerId,
    instruction: kind === 'decide' ? 'Escolha a rota que melhor descreve o pedido.' : 'Cumpra a sua parte do pedido.'
  }
}

function reaches(flow: ModelFlow, start: string, goal: string): boolean {
  const stack = [start]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (id === goal) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const edge of flow.edges) {
      if (edge.from === id) stack.push(edge.to)
    }
  }
  return false
}

function curve(from: Point, to: Point): string {
  const dx = Math.max(56, Math.abs(to.x - from.x) * 0.45)
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`
}

function curveMid(from: Point, to: Point): Point {
  const dx = Math.max(56, Math.abs(to.x - from.x) * 0.45)
  const c1 = { x: from.x + dx, y: from.y }
  const c2 = { x: to.x - dx, y: to.y }
  const t = 0.5
  const u = 1 - t
  return {
    x: u ** 3 * from.x + 3 * u ** 2 * t * c1.x + 3 * u * t ** 2 * c2.x + t ** 3 * to.x,
    y: u ** 3 * from.y + 3 * u ** 2 * t * c1.y + 3 * u * t ** 2 * c2.y + t ** 3 * to.y
  }
}

function flowIssues(flow: ModelFlow, providers: ProviderConfig[]): string[] {
  const outgoing = new Map<string, FlowEdge[]>()
  for (const edge of flow.edges) {
    const list = outgoing.get(edge.from) ?? []
    list.push(edge)
    outgoing.set(edge.from, list)
  }
  const found: string[] = []
  const entry = flow.nodes.find((node) => node.kind === 'entry')
  if (!entry) found.push('Falta o bloco de entrada.')
  else if ((outgoing.get(entry.id) ?? []).length !== 1) found.push('A entrada precisa de uma saída.')
  for (const node of flow.nodes) {
    if (node.kind === 'entry') continue
    const label = node.name.trim() || 'Bloco'
    if (!providers.some((item) => item.id === node.providerId)) found.push(`“${label}” está sem modelo.`)
    const edges = outgoing.get(node.id) ?? []
    if (node.kind === 'decide' && edges.length < 2) found.push(`“${label}” precisa de pelo menos duas rotas.`)
    if (node.kind === 'decide' && edges.some((edge) => !edge.when.trim())) {
      found.push(`Escreva a condição em cada rota de “${label}”.`)
    }
    if (node.kind === 'model' && edges.length > 1) found.push(`“${label}” só pode ter uma saída.`)
  }
  const finals = flow.nodes.filter((node) => node.kind === 'model' && (outgoing.get(node.id) ?? []).length === 0)
  if (flow.nodes.some((node) => node.kind === 'model') && finals.length === 0) {
    found.push('O caminho precisa terminar num modelo sem saída: é ele quem responde.')
  }
  return found
}

export function ModelFlowsPanel({
  draft,
  setDraft
}: {
  draft: AppSettings
  setDraft: Dispatch<SetStateAction<AppSettings>>
}): JSX.Element {
  const flows = draft.flows ?? []
  const providers = draft.providers
  const providerId = draft.activeProviderId ?? providers[0]?.id ?? ''
  const [openId, setOpenId] = useState<string | null>(flows[0]?.id ?? null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pan, setPan] = useState({ x: 36, y: 28 })
  const [zoom, setZoom] = useState(1)
  const [offsets, setOffsets] = useState<PortOffsets>({})
  const [cursor, setCursor] = useState<Point | null>(null)
  const [linkingFrom, setLinkingFrom] = useState<string | null>(null)
  const [linkNote, setLinkNote] = useState('')
  const worldRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef(draft)
  const openRef = useRef(openId)
  const panRef = useRef(pan)
  const zoomRef = useRef(zoom)
  draftRef.current = draft
  openRef.current = openId
  panRef.current = pan
  zoomRef.current = zoom

  const flow = flows.find((item) => item.id === openId) ?? flows[0] ?? null

  useEffect(() => {
    if (flow && flow.id !== openId) setOpenId(flow.id)
  }, [flow, openId])

  useEffect(() => {
    setPan({ x: 36, y: 28 })
    setZoom(1)
    setSelectedId(null)
    setLinkNote('')
  }, [flow?.id])

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        setZoom((value) => Math.min(1.6, Math.max(0.5, value * (event.deltaY > 0 ? 0.92 : 1.08))))
        return
      }
      setPan((value) => ({ x: value.x - event.deltaX, y: value.y - event.deltaY }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [flow?.id])

  const measureKey = flow
    ? flow.nodes.map((node) => `${node.id}|${node.kind}|${node.name}|${node.instruction}|${node.providerId}`).join('~')
    : ''

  useLayoutEffect(() => {
    const world = worldRef.current
    if (!world || !flow) return
    const next: PortOffsets = {}
    for (const el of world.querySelectorAll<HTMLElement>('[data-node]')) {
      const id = el.dataset.node
      if (!id) continue
      const base = el.getBoundingClientRect()
      const read = (selector: string): Point | null => {
        const port = el.querySelector(selector) as HTMLElement | null
        if (!port) return null
        const rect = port.getBoundingClientRect()
        return {
          x: (rect.left + rect.width / 2 - base.left) / zoomRef.current,
          y: (rect.top + rect.height / 2 - base.top) / zoomRef.current
        }
      }
      next[id] = { inn: read('[data-port="in"]'), out: read('[data-port="out"]') }
    }
    setOffsets(next)
  }, [measureKey, flow])

  const replaceFlow = (next: ModelFlow): void => {
    setDraft((current) => ({
      ...current,
      flows: (current.flows ?? []).map((item) => (item.id === next.id ? next : item))
    }))
  }

  const patchNode = (nodeId: string, patch: Partial<FlowNode>): void => {
    if (!flow) return
    replaceFlow({
      ...flow,
      nodes: flow.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node))
    })
  }

  const addFlow = (): void => {
    const next = exampleFlow(providerId)
    setDraft((current) => ({ ...current, flows: [...(current.flows ?? []), next] }))
    setOpenId(next.id)
  }

  const duplicateFlow = (source: ModelFlow): void => {
    const map = new Map<string, string>()
    const nodes = source.nodes.map((node) => {
      const id = crypto.randomUUID()
      map.set(node.id, id)
      return { ...node, id, x: node.x + 40, y: node.y + 40 }
    })
    const edges = source.edges.map((edge) => ({
      ...edge,
      id: crypto.randomUUID(),
      from: map.get(edge.from) ?? edge.from,
      to: map.get(edge.to) ?? edge.to
    }))
    const next: ModelFlow = {
      id: crypto.randomUUID(),
      name: `${source.name || 'Fluxo'} cópia`,
      nodes,
      edges
    }
    setDraft((current) => ({ ...current, flows: [...(current.flows ?? []), next] }))
    setOpenId(next.id)
  }

  const removeFlow = (id: string): void => {
    setDraft((current) => ({
      ...current,
      flows: (current.flows ?? []).filter((item) => item.id !== id),
      activeFlowId: current.activeFlowId === id ? null : current.activeFlowId
    }))
    if (openId === id) setOpenId(null)
  }

  const addNode = (kind: 'decide' | 'model'): void => {
    if (!flow) return
    const spot = {
      x: Math.round((140 - pan.x) / zoom + (flow.nodes.length % 4) * 24),
      y: Math.round((120 - pan.y) / zoom + (flow.nodes.length % 3) * 28)
    }
    const node = blankNode(kind, providerId, spot.x, spot.y)
    replaceFlow({ ...flow, nodes: [...flow.nodes, node] })
    setSelectedId(node.id)
  }

  const removeNode = (nodeId: string): void => {
    if (!flow) return
    const node = flow.nodes.find((item) => item.id === nodeId)
    if (!node || node.kind === 'entry') return
    replaceFlow({
      ...flow,
      nodes: flow.nodes.filter((item) => item.id !== nodeId),
      edges: flow.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId)
    })
    if (selectedId === nodeId) setSelectedId(null)
  }

  const linkNodes = (fromId: string, toId: string): void => {
    const current = (draftRef.current.flows ?? []).find((item) => item.id === openRef.current)
    if (!current || fromId === toId) return
    const source = current.nodes.find((node) => node.id === fromId)
    const target = current.nodes.find((node) => node.id === toId)
    if (!source || !target || target.kind === 'entry') {
      setLinkNote('Solte a ligação na entrada de um bloco de decisão ou de modelo.')
      return
    }
    if (current.edges.some((edge) => edge.from === fromId && edge.to === toId)) return
    if (reaches(current, toId, fromId)) {
      setLinkNote('Essa ligação fecharia um ciclo.')
      return
    }
    setLinkNote('')
    const kept =
      source.kind === 'entry' || source.kind === 'model'
        ? current.edges.filter((edge) => edge.from !== fromId)
        : current.edges
    const when =
      source.kind === 'decide' ? `rota ${kept.filter((edge) => edge.from === fromId).length + 1}` : ''
    replaceFlow({
      ...current,
      edges: [...kept, { id: crypto.randomUUID(), from: fromId, to: toId, when }]
    })
  }

  const beginLink = (fromId: string, event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    event.preventDefault()
    setLinkingFrom(fromId)
    const move = (pointer: PointerEvent): void => {
      const world = worldRef.current
      if (!world) return
      const box = world.getBoundingClientRect()
      setCursor({
        x: (pointer.clientX - box.left) / zoomRef.current,
        y: (pointer.clientY - box.top) / zoomRef.current
      })
    }
    const up = (pointer: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setLinkingFrom(null)
      setCursor(null)
      const el = document.elementFromPoint(pointer.clientX, pointer.clientY)
      const host = el?.closest('[data-node]') as HTMLElement | null
      const toId = host?.dataset.node ?? ''
      if (toId) linkNodes(fromId, toId)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const beginDrag = (node: FlowNode, event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    setSelectedId(node.id)
    const world = worldRef.current
    if (!world) return
    const box = world.getBoundingClientRect()
    const origin = {
      x: (event.clientX - box.left) / zoomRef.current - node.x,
      y: (event.clientY - box.top) / zoomRef.current - node.y
    }
    const move = (pointer: PointerEvent): void => {
      const live = worldRef.current?.getBoundingClientRect()
      if (!live) return
      const x = Math.round((pointer.clientX - live.left) / zoomRef.current - origin.x)
      const y = Math.round((pointer.clientY - live.top) / zoomRef.current - origin.y)
      setDraft((current) => ({
        ...current,
        flows: (current.flows ?? []).map((item) =>
          item.id !== openRef.current
            ? item
            : {
                ...item,
                nodes: item.nodes.map((entry) => (entry.id === node.id ? { ...entry, x, y } : entry))
              }
        )
      }))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (target.closest('.flow-node, .flow-edge-label, .flow-port')) return
    setSelectedId(null)
    const start = { x: event.clientX, y: event.clientY, panX: panRef.current.x, panY: panRef.current.y }
    const move = (pointer: PointerEvent): void => {
      setPan({
        x: start.panX + (pointer.clientX - start.x),
        y: start.panY + (pointer.clientY - start.y)
      })
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const portOf = (nodeId: string, side: 'out' | 'inn'): Point | null => {
    const node = flow?.nodes.find((item) => item.id === nodeId)
    const offset = offsets[nodeId]?.[side]
    if (!node || !offset) return null
    return { x: node.x + offset.x, y: node.y + offset.y }
  }

  const issues = flow ? flowIssues(flow, providers) : []

  return (
    <div className="flow-editor">
      <aside className="flow-list">
        <p className="flow-list-title">Fluxos</p>
        {flows.map((item) => (
          <div key={item.id} className={`flow-list-item ${flow?.id === item.id ? 'active' : ''}`}>
            <button type="button" onClick={() => setOpenId(item.id)}>
              <Workflow size={14} />
              <span>{item.name.trim() || 'Fluxo sem nome'}</span>
              {draft.activeFlowId === item.id && <em>ativo</em>}
            </button>
            <button type="button" className="ghost icon" title="Duplicar fluxo" onClick={() => duplicateFlow(item)}>
              <Copy size={14} />
            </button>
            <button type="button" className="ghost icon" title="Remover fluxo" onClick={() => removeFlow(item.id)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button type="button" className="add" onClick={addFlow}>
          <Plus size={15} /> Novo fluxo
        </button>
      </aside>

      {!flow ? (
        <div className="flow-empty">
          <Workflow size={28} />
          <h3>Nenhum fluxo ainda</h3>
          <p>
            Um fluxo escolhe o modelo conforme o pedido. Por exemplo: um modelo classifica, outro escreve o código
            simples, outro o código difícil, e um último confere a resposta.
          </p>
          <button type="button" className="add" onClick={addFlow}>
            <Plus size={15} /> Criar fluxo de exemplo
          </button>
          {providers.length === 0 && <p className="help warn">Cadastre um modelo na aba Modelos antes.</p>}
        </div>
      ) : (
        <div className="flow-stage">
          <div className="flow-toolbar">
            <label>
              Nome do fluxo
              <input
                value={flow.name}
                onChange={(event) => replaceFlow({ ...flow, name: event.target.value })}
              />
            </label>
            <button type="button" className="ghost" onClick={() => addNode('decide')}>
              <Split size={14} /> Decisão
            </button>
            <button type="button" className="ghost" onClick={() => addNode('model')}>
              <Plus size={14} /> Modelo
            </button>
            <button
              type="button"
              className={`flow-use ${draft.activeFlowId === flow.id ? 'on' : ''}`}
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  activeFlowId: current.activeFlowId === flow.id ? null : flow.id
                }))
              }
            >
              {draft.activeFlowId === flow.id ? 'Fluxo ativo' : 'Usar este fluxo'}
            </button>
          </div>
          <p className="flow-help">
            Arraste da bolinha da direita até outro bloco. Numa decisão, escreva a condição em cima do fio
            (código simples, código difícil). Aponte Classificar e Verificar para o modelo que decide, e cada bloco
            de código para o modelo daquela dificuldade. Salve: o fluxo entra na lista de modelos.
          </p>
          {providers.length === 0 && (
            <p className="help warn">Cadastre pelo menos um modelo na aba Modelos para ligar os blocos.</p>
          )}
          {linkNote && <p className="help warn">{linkNote}</p>}
          {issues.length > 0 && (
            <ul className="flow-issues">
              {issues.map((issue, index) => (
                <li key={`${index}-${issue}`}>{issue}</li>
              ))}
            </ul>
          )}
          <div className="flow-canvas" ref={canvasRef} onPointerDown={beginPan}>
            <div
              className="flow-world"
              ref={worldRef}
              style={{
                width: WORLD.w,
                height: WORLD.h,
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
              }}
            >
              <svg className="flow-svg" width={WORLD.w} height={WORLD.h}>
                <defs>
                  <marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
                  </marker>
                </defs>
                {flow.edges.map((edge) => {
                  const from = portOf(edge.from, 'out')
                  const to = portOf(edge.to, 'inn')
                  if (!from || !to) return null
                  const source = flow.nodes.find((node) => node.id === edge.from)
                  return (
                    <path
                      key={edge.id}
                      d={curve(from, to)}
                      className={source?.kind === 'decide' ? 'decide' : ''}
                      markerEnd="url(#flow-arrow)"
                    />
                  )
                })}
                {linkingFrom && cursor && portOf(linkingFrom, 'out') && (
                  <path d={curve(portOf(linkingFrom, 'out') as Point, cursor)} className="rubber" />
                )}
              </svg>

              {flow.edges.map((edge) => {
                const from = portOf(edge.from, 'out')
                const to = portOf(edge.to, 'inn')
                if (!from || !to) return null
                const source = flow.nodes.find((node) => node.id === edge.from)
                const mid = curveMid(from, to)
                return (
                  <div key={edge.id} className="flow-edge-label" style={{ left: mid.x, top: mid.y }}>
                    {source?.kind === 'decide' && (
                      <input
                        value={edge.when}
                        aria-label="Condição da rota"
                        onChange={(event) =>
                          replaceFlow({
                            ...flow,
                            edges: flow.edges.map((item) =>
                              item.id === edge.id ? { ...item, when: event.target.value } : item
                            )
                          })
                        }
                      />
                    )}
                    <button
                      type="button"
                      title="Remover ligação"
                      onClick={() => replaceFlow({ ...flow, edges: flow.edges.filter((item) => item.id !== edge.id) })}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )
              })}

              {flow.nodes.map((node) => (
                <article
                  key={node.id}
                  data-node={node.id}
                  className={`flow-node ${node.kind} ${selectedId === node.id ? 'selected' : ''}`}
                  style={{ left: node.x, top: node.y }}
                  onPointerDownCapture={() => setSelectedId(node.id)}
                >
                  {node.kind !== 'entry' && (
                    <button type="button" className="flow-port in" data-port="in" data-node-id={node.id} tabIndex={-1} />
                  )}
                  <button
                    type="button"
                    className="flow-port out"
                    data-port="out"
                    data-node-id={node.id}
                    title="Arraste até outro bloco"
                    onPointerDown={(event) => beginLink(node.id, event)}
                  />
                  <div className="flow-node-head" onPointerDown={(event) => beginDrag(node, event)}>
                    <span className="flow-kind">
                      {node.kind === 'entry' ? 'Entrada' : node.kind === 'decide' ? 'Decisão' : 'Modelo'}
                    </span>
                    {node.kind !== 'entry' && (
                      <button
                        type="button"
                        className="ghost icon"
                        title="Remover bloco"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => removeNode(node.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                  <div className="flow-node-body" onPointerDown={(event) => event.stopPropagation()}>
                    {node.kind === 'entry' ? (
                      <p>O pedido entra aqui e segue pelo fio.</p>
                    ) : (
                      <>
                        <label>
                          Nome
                          <input value={node.name} onChange={(event) => patchNode(node.id, { name: event.target.value })} />
                        </label>
                        <label>
                          Modelo
                          <select
                            value={node.providerId}
                            onChange={(event) => patchNode(node.id, { providerId: event.target.value })}
                          >
                            <option value="">Escolher modelo</option>
                            {providers.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name} · {item.model}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          {node.kind === 'decide' ? 'Como decidir' : 'O que este modelo faz'}
                          <textarea
                            rows={2}
                            value={node.instruction}
                            onChange={(event) => patchNode(node.id, { instruction: event.target.value })}
                          />
                        </label>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
