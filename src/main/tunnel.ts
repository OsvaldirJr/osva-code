import { type ChildProcess, spawn } from 'child_process'

let child: ChildProcess | null = null
let publicUrl: string | null = null

export function tunnelUrl(): string | null {
  return publicUrl
}

export function stopTunnel(): void {
  publicUrl = null
  if (!child) return
  child.kill('SIGTERM')
  child = null
}

/** Abre um endereço público temporário até o webhook local. Exige rede na hora. */
export function startTunnel(port: number, onClose: () => void): Promise<string> {
  stopTunnel()
  return new Promise((resolve, reject) => {
    const proc = spawn(`npx --yes localtunnel --port ${port}`, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`
      }
    })
    child = proc
    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      stopTunnel()
      reject(new Error(message))
    }
    const timer = setTimeout(() => fail('O túnel demorou demais para abrir.'), 45_000)
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      const match = text.match(/https:\/\/[^\s]+/)
      if (!match || settled) return
      settled = true
      clearTimeout(timer)
      publicUrl = match[0].replace(/[).,]+$/, '')
      resolve(publicUrl)
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', () => fail('Não foi possível iniciar o túnel.'))
    proc.on('exit', (code) => {
      if (!settled) fail(`O túnel encerrou antes de informar o endereço (código ${code ?? 'desconhecido'}).`)
      if (child === proc) {
        child = null
        publicUrl = null
        onClose()
      }
    })
  })
}
