// Traduz eventos técnicos (chamadas de ferramenta, resultados) para
// frases em linguagem simples exibidas ao usuário durante a geração.

function formatArgs(argsJson: string): string {
  try {
    const args = JSON.parse(argsJson || '{}') as Record<string, unknown>
    const pairs = Object.entries(args)
    if (pairs.length === 0) return ''
    const parts = pairs.slice(0, 4).map(([key, value]) => {
      let text = typeof value === 'string' ? value : JSON.stringify(value)
      if (text.length > 60) text = text.slice(0, 57) + '…'
      return `${key}: ${text}`
    })
    const extra = pairs.length > 4 ? ` (e mais ${pairs.length - 4})` : ''
    return parts.join(' · ') + extra
  } catch {
    return ''
  }
}

export function explainToolCall(
  serverName: string,
  toolName: string,
  description: string | undefined,
  argsJson: string
): string {
  const what = description
    ? description.replace(/\.$/, '').charAt(0).toLowerCase() + description.replace(/\.$/, '').slice(1)
    : null
  const base = what
    ? `Estou usando a ferramenta “${toolName}” de ${serverName} para ${what}.`
    : `Estou usando a ferramenta “${toolName}” do servidor ${serverName}.`
  const args = formatArgs(argsJson)
  return args ? `${base}\nDetalhes: ${args}` : base
}

export function summarizeToolResult(ok: boolean, resultText: string): string {
  if (!ok) return `Algo deu errado nessa etapa: ${truncate(resultText, 200)}`
  return `Pronto — recebi as informações (${truncate(resultText, 160)})`
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
}

/** Prompt usado pelo botão “Simplificar” para reescrever respostas técnicas. */
export const SIMPLIFY_SYSTEM_PROMPT = [
  'Você é um tradutor de linguagem técnica para linguagem simples, em português.',
  'Reescreva o texto do usuário para que qualquer pessoa leiga entenda:',
  'use frases curtas, analogias do dia a dia e explique todo termo técnico.',
  'Preserve o significado e os fatos. Não adicione informações novas.',
  'Responda apenas com o texto reescrito, sem preâmbulos.'
].join(' ')
