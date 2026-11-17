import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { accessSync, constants, existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { StringDecoder } from 'string_decoder'
import type {
  TerminalCliConfig,
  TerminalEvent,
  TerminalSessionInfo,
  TerminalTarget,
  TerminalToolStatus
} from '../shared/types'

const MAX_HISTORY_CHARS = 200_000

const PTY_BRIDGE_SCRIPT = `
import base64, errno, fcntl, json, os, pty, select, signal, struct, sys, termios

shell = sys.argv[1]
mode = sys.argv[2]
cols = max(10, int(sys.argv[3]))
rows = max(4, int(sys.argv[4]))
command = sys.argv[5] if len(sys.argv) > 5 else ""

master_fd, slave_fd = pty.openpty()
fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

pid = os.fork()
if pid == 0:
    os.close(master_fd)
    os.setsid()
    fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
    try:
        os.tcsetpgrp(slave_fd, os.getpgrp())
    except OSError:
        pass
    os.dup2(slave_fd, 0)
    os.dup2(slave_fd, 1)
    os.dup2(slave_fd, 2)
    if slave_fd > 2:
        os.close(slave_fd)
    if mode == "interactive":
        argv = [shell, "-ic", command] if command else [shell, "-i"]
    else:
        argv = [shell, "-c", command]
    os.execvp(shell, argv)

os.close(slave_fd)
stdin_fd = sys.stdin.fileno()
flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()

def write_all(fd, raw):
    mv = memoryview(raw)
    while mv:
        try:
            written = os.write(fd, mv)
            mv = mv[written:]
        except BlockingIOError:
            select.select([], [fd], [], 0.1)
        except OSError:
            break

def kill_child(sig=signal.SIGTERM):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass
    except OSError:
        try:
            os.kill(pid, sig)
        except OSError:
            pass

def handle_signal(_signum, _frame):
    kill_child(signal.SIGTERM)

signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGHUP, handle_signal)

stdin_buf = b""
stdin_open = True
exit_code = None

while True:
    watch = [master_fd] + ([stdin_fd] if stdin_open else [])
    try:
        readable, _, _ = select.select(watch, [], [], 0.25)
    except InterruptedError:
        continue

    if master_fd in readable:
        eof = False
        while True:
            try:
                chunk = os.read(master_fd, 4096)
                if not chunk:
                    eof = True
                    break
                emit({"type": "data", "data": base64.b64encode(chunk).decode("ascii")})
            except BlockingIOError:
                break
            except OSError as err:
                if err.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    break
                eof = True
                break
        if eof:
            break

    if stdin_open and stdin_fd in readable:
        try:
            in_chunk = os.read(stdin_fd, 65536)
        except OSError:
            in_chunk = b""
        if not in_chunk:
            stdin_open = False
            kill_child(signal.SIGTERM)
            break
        stdin_buf += in_chunk
        while b"\\n" in stdin_buf:
            line, stdin_buf = stdin_buf.split(b"\\n", 1)
            if not line:
                continue
            try:
                msg = json.loads(line.decode("utf-8"))
            except Exception:
                continue
            mtype = msg.get("type")
            if mtype == "input":
                raw = base64.b64decode(msg.get("data", ""))
                if raw:
                    write_all(master_fd, raw)
            elif mtype == "resize":
                c = max(10, int(msg.get("cols", 80)))
                r = max(4, int(msg.get("rows", 24)))
                try:
                    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
                    kill_child(signal.SIGWINCH)
                except OSError:
                    pass
            elif mtype == "kill":
                kill_child(signal.SIGTERM)

    if exit_code is None:
        try:
            done_pid, status = os.waitpid(pid, os.WNOHANG)
            if done_pid == pid:
                exit_code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8)
                break
        except ChildProcessError:
            exit_code = 0
            break

while True:
    try:
        chunk = os.read(master_fd, 4096)
        if not chunk:
            break
        emit({"type": "data", "data": base64.b64encode(chunk).decode("ascii")})
    except OSError:
        break

if exit_code is None:
    try:
        _, status = os.waitpid(pid, 0)
        exit_code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8)
    except ChildProcessError:
        exit_code = 0

try:
    os.close(master_fd)
except OSError:
    pass

emit({"type": "exit", "code": exit_code})
`

interface ActiveSession {
  info: TerminalSessionInfo
  child: ChildProcessWithoutNullStreams | null
  decoder: StringDecoder
  history: string
  stdoutBuffer: string
  pendingInitialInput?: string
  initialTimer?: ReturnType<typeof setTimeout>
  initialFallbackTimer?: ReturnType<typeof setTimeout>
  lineTimer?: ReturnType<typeof setTimeout>
}

const sessions = new Map<string, ActiveSession>()
let cachedEnvPath: string | null = null
let eventSink: ((event: TerminalEvent) => void) | null = null

export function setTerminalEventSink(sink: (event: TerminalEvent) => void): void {
  eventSink = sink
}

function emitEvent(event: TerminalEvent): void {
  eventSink?.(event)
}

function defaultShell(): string {
  const envShell = process.env.SHELL?.trim()
  if (envShell && existsSync(envShell)) return envShell
  if (existsSync('/bin/zsh')) return '/bin/zsh'
  if (existsSync('/bin/bash')) return '/bin/bash'
  return '/bin/sh'
}

function isExecutable(filePath: string): boolean {
  try {
    const info = statSync(filePath)
    if (!info.isFile()) return false
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function nvmBinDirs(home: string): string[] {
  const root = join(home, '.nvm', 'versions', 'node')
  if (!existsSync(root)) return []
  try {
    return readdirSync(root)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((dir) => join(root, dir, 'bin'))
      .filter((dir) => existsSync(dir))
  } catch {
    return []
  }
}

export function resolveShellPath(forceRefresh = false): string {
  if (cachedEnvPath && !forceRefresh) return cachedEnvPath
  const home = homedir()
  const candidates: string[] = []
  const shell = defaultShell()

  try {
    const out = execFileSync(shell, ['-ilc', 'printf "%s" "$PATH"'], {
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (out) candidates.push(...out.split(':'))
  } catch {
    // fallback para caminhos conhecidos caso o login shell demore ou falhe
  }

  candidates.push(
    ...nvmBinDirs(home),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, 'bin'),
    ...(process.env.PATH ? process.env.PATH.split(':') : [])
  )

  const seen = new Set<string>()
  const unique = candidates.filter((entry) => {
    const clean = entry.trim()
    if (!clean || seen.has(clean)) return false
    seen.add(clean)
    return true
  })

  cachedEnvPath = unique.join(':')
  return cachedEnvPath
}

function findBinary(name: string, envPath: string): string | null {
  for (const dir of envPath.split(':')) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

export function detectTerminalTools(): TerminalToolStatus {
  const envPath = resolveShellPath()
  return {
    claude: findBinary('claude', envPath),
    copilot: findBinary('copilot', envPath),
    gh: findBinary('gh', envPath)
  }
}

function resolveCwd(cwd?: string | null): string {
  const candidate = cwd?.trim()
  if (candidate && existsSync(candidate)) {
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // usa home
    }
  }
  return homedir()
}

function resolveCommandSpec(
  target: TerminalTarget,
  config: TerminalCliConfig | undefined,
  tools: TerminalToolStatus
): { shell: string; mode: 'interactive' | 'command'; command: string; display: string; missingHint?: string } {
  const userShell = config?.shellCommand?.trim() || defaultShell()

  if (target === 'shell') {
    return {
      shell: userShell,
      mode: 'interactive',
      command: '',
      display: basename(userShell)
    }
  }

  if (target === 'claude') {
    const custom = config?.claudeCommand?.trim()
    const command = custom || 'claude'
    const missingHint =
      !custom && !tools.claude
        ? 'Aviso: binário "claude" não encontrado no PATH. Instale o Claude Code (`npm i -g @anthropic-ai/claude-code`) ou ajuste o comando em Configurações → Terminal.\r\n'
        : undefined
    return {
      shell: userShell,
      mode: 'command',
      command,
      display: command,
      missingHint
    }
  }

  const custom = config?.copilotCommand?.trim()
  const detected = tools.copilot ? 'copilot' : tools.gh ? 'gh copilot' : 'copilot'
  const command = custom || detected
  const missingHint =
    !custom && !tools.copilot && !tools.gh
      ? 'Aviso: "copilot" e "gh" não encontrados no PATH. Instale o GitHub Copilot CLI ou ajuste o comando em Configurações → Terminal.\r\n'
      : undefined
  return {
    shell: userShell,
    mode: 'command',
    command,
    display: command,
    missingHint
  }
}

function appendHistory(session: ActiveSession, text: string): void {
  if (!text) return
  session.history += text
  if (session.history.length > MAX_HISTORY_CHARS) {
    session.history = session.history.slice(-MAX_HISTORY_CHARS)
  }
}

function sendControl(session: ActiveSession, msg: Record<string, unknown>): void {
  if (!session.child || session.child.killed || !session.child.stdin.writable) return
  try {
    session.child.stdin.write(`${JSON.stringify(msg)}\n`)
  } catch {
    // o processo já encerrou
  }
}

function clearInitialTimers(session: ActiveSession): void {
  if (session.initialTimer) {
    clearTimeout(session.initialTimer)
    session.initialTimer = undefined
  }
  if (session.initialFallbackTimer) {
    clearTimeout(session.initialFallbackTimer)
    session.initialFallbackTimer = undefined
  }
  if (session.lineTimer) {
    clearTimeout(session.lineTimer)
    session.lineTimer = undefined
  }
}

function flushInitialInput(session: ActiveSession): void {
  const pending = session.pendingInitialInput
  if (pending === undefined) return
  session.pendingInitialInput = undefined
  clearInitialTimers(session)
  if (!session.info.running) return
  sendTerminalLine(session.info.sessionId, pending)
}

export function startTerminalSession(input: {
  sessionId: string
  target: TerminalTarget
  cwd?: string | null
  cols?: number
  rows?: number
  initialInput?: string
  restart?: boolean
  adoptSessionId?: string
  config?: TerminalCliConfig
}): TerminalSessionInfo {
  const previous = sessions.get(input.sessionId)
  if (!input.restart && previous?.info.running) {
    if (input.initialInput !== undefined) {
      sendTerminalLine(input.sessionId, input.initialInput)
    }
    return { ...previous.info }
  }
  if (!input.restart && input.adoptSessionId && input.adoptSessionId !== input.sessionId) {
    const adopted = sessions.get(input.adoptSessionId)
    if (adopted?.info.running) {
      sessions.delete(input.adoptSessionId)
      adopted.info = { ...adopted.info, sessionId: input.sessionId }
      sessions.set(input.sessionId, adopted)
      emitEvent({ sessionId: input.adoptSessionId, type: 'exit', code: 0 })
      emitEvent({ sessionId: input.sessionId, type: 'status', session: { ...adopted.info } })
      if (input.initialInput !== undefined) {
        if (adopted.pendingInitialInput !== undefined) {
          adopted.pendingInitialInput = input.initialInput
        } else {
          sendTerminalLine(input.sessionId, input.initialInput)
        }
      }
      return { ...adopted.info }
    }
  }
  if (previous?.info.running) {
    stopTerminalSession(input.sessionId)
  }

  const tools = detectTerminalTools()
  const envPath = resolveShellPath()
  const cwd = resolveCwd(input.cwd)
  const cols = Math.max(10, Math.round(input.cols ?? 96))
  const rows = Math.max(4, Math.round(input.rows ?? 26))
  const spec = resolveCommandSpec(input.target, input.config, tools)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: envPath,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '1'
  }
  delete env.NO_COLOR

  const info: TerminalSessionInfo = {
    sessionId: input.sessionId,
    target: input.target,
    cwd,
    command: spec.display,
    running: true,
    exitCode: null
  }

  const session: ActiveSession = {
    info,
    child: null,
    decoder: new StringDecoder('utf8'),
    history: '',
    stdoutBuffer: '',
    ...(input.initialInput !== undefined ? { pendingInitialInput: input.initialInput } : {})
  }
  sessions.set(input.sessionId, session)

  const headerLine = `\x1b[90m[${spec.display} · ${cwd}]\x1b[0m\r\n`
  appendHistory(session, headerLine)
  emitEvent({ sessionId: input.sessionId, type: 'status', session: { ...info } })
  emitEvent({ sessionId: input.sessionId, type: 'data', data: headerLine })

  if (spec.missingHint) {
    const warn = `\x1b[33m${spec.missingHint}\x1b[0m`
    appendHistory(session, warn)
    emitEvent({ sessionId: input.sessionId, type: 'data', data: warn })
  }

  const child = spawn(
    'python3',
    ['-u', '-c', PTY_BRIDGE_SCRIPT, spec.shell, spec.mode, String(cols), String(rows), spec.command],
    { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  session.child = child

  if (session.pendingInitialInput !== undefined) {
    session.initialFallbackTimer = setTimeout(() => {
      flushInitialInput(session)
    }, input.target === 'shell' ? 450 : 1800)
  }

  const pushText = (text: string): void => {
    if (!text) return
    appendHistory(session, text)
    emitEvent({ sessionId: session.info.sessionId, type: 'data', data: text })
    if (session.pendingInitialInput !== undefined && !session.initialTimer) {
      const delay = input.target === 'shell' ? 150 : 650
      session.initialTimer = setTimeout(() => flushInitialInput(session), delay)
    }
  }

  child.stdout.on('data', (chunk: Buffer) => {
    session.stdoutBuffer += chunk.toString('utf8')
    let newlineIndex = session.stdoutBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = session.stdoutBuffer.slice(0, newlineIndex).trim()
      session.stdoutBuffer = session.stdoutBuffer.slice(newlineIndex + 1)
      newlineIndex = session.stdoutBuffer.indexOf('\n')
      if (!line) continue
      try {
        const msg = JSON.parse(line) as { type?: string; data?: string; code?: number }
        if (msg.type === 'data' && typeof msg.data === 'string') {
          const decoded = session.decoder.write(Buffer.from(msg.data, 'base64'))
          pushText(decoded)
        } else if (msg.type === 'exit') {
          const tail = session.decoder.end()
          if (tail) pushText(tail)
          session.info = {
            ...session.info,
            running: false,
            exitCode: typeof msg.code === 'number' ? msg.code : 0
          }
          clearInitialTimers(session)
          emitEvent({ sessionId: session.info.sessionId, type: 'status', session: { ...session.info } })
          emitEvent({ sessionId: session.info.sessionId, type: 'exit', code: session.info.exitCode ?? 0 })
        }
      } catch {
        // ignora linha malformada
      }
    }
  })

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    if (text) pushText(text)
  })

  child.on('error', (err) => {
    clearInitialTimers(session)
    session.info = { ...session.info, running: false, exitCode: 1 }
    const msg = `\r\n\x1b[31mErro ao iniciar terminal: ${err.message}\x1b[0m\r\n`
    appendHistory(session, msg)
    emitEvent({ sessionId: session.info.sessionId, type: 'data', data: msg })
    emitEvent({ sessionId: session.info.sessionId, type: 'error', message: err.message })
    emitEvent({ sessionId: session.info.sessionId, type: 'status', session: { ...session.info } })
  })

  child.on('close', (code) => {
    clearInitialTimers(session)
    if (session.info.running) {
      const tail = session.decoder.end()
      if (tail) pushText(tail)
      session.info = { ...session.info, running: false, exitCode: code }
      emitEvent({ sessionId: session.info.sessionId, type: 'status', session: { ...session.info } })
      emitEvent({ sessionId: session.info.sessionId, type: 'exit', code })
    }
  })

  return { ...info }
}

export function writeTerminalSession(sessionId: string, data: string): void {
  const session = sessions.get(sessionId)
  if (!session || !session.info.running || !data) return
  const encoded = Buffer.from(data, 'utf8').toString('base64')
  sendControl(session, { type: 'input', data: encoded })
}

export function sendTerminalLine(sessionId: string, text: string): void {
  const session = sessions.get(sessionId)
  if (!session || !session.info.running) return
  if (!text) {
    writeTerminalSession(sessionId, '\r')
    return
  }
  if (text.endsWith('\r') || text.endsWith('\n')) {
    writeTerminalSession(sessionId, text)
    return
  }
  writeTerminalSession(sessionId, text)
  if (session.lineTimer) clearTimeout(session.lineTimer)
  session.lineTimer = setTimeout(() => {
    session.lineTimer = undefined
    writeTerminalSession(sessionId, '\r')
  }, 40)
}

export function resizeTerminalSession(sessionId: string, cols: number, rows: number): void {
  const session = sessions.get(sessionId)
  if (!session || !session.info.running) return
  sendControl(session, { type: 'resize', cols: Math.max(10, Math.round(cols)), rows: Math.max(4, Math.round(rows)) })
}

export function stopTerminalSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  clearInitialTimers(session)
  session.pendingInitialInput = undefined
  if (session.info.running) {
    sendControl(session, { type: 'kill' })
    setTimeout(() => {
      if (session.child && !session.child.killed) {
        try {
          session.child.kill('SIGTERM')
        } catch {
          // processo já encerrado
        }
      }
    }, 150)
  }
}

export function getTerminalHistory(sessionId: string): { session: TerminalSessionInfo | null; buffer: string } {
  const session = sessions.get(sessionId)
  if (!session) return { session: null, buffer: '' }
  return { session: { ...session.info }, buffer: session.history }
}

export function listTerminalSessions(): TerminalSessionInfo[] {
  return [...sessions.values()].map((item) => ({ ...item.info }))
}

export function closeAllTerminals(): void {
  for (const sessionId of sessions.keys()) {
    stopTerminalSession(sessionId)
  }
}
