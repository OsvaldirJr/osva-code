import { useState } from 'react'
import type { AuthSession } from '../../../shared/types'

type Mode = 'signin' | 'signup'

function cleanIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function LoginScreen({
  serverUrl,
  onLoggedIn
}: {
  serverUrl: string
  onLoggedIn: (session: AuthSession) => void
}): JSX.Element {
  const [mode, setMode] = useState<Mode>('signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [server, setServer] = useState(serverUrl)
  const [editingServer, setEditingServer] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const canSubmit =
    email.trim() !== '' && password !== '' && (mode === 'signin' || name.trim() !== '')

  const submit = async (): Promise<void> => {
    if (!canSubmit || busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (mode === 'signin') {
        onLoggedIn(await window.api.login(email.trim(), password, server.trim()))
        return
      }
      const created = await window.api.signup(name.trim(), email.trim(), password, server.trim())
      if (created.user.role === 'pending') {
        setMode('signin')
        setPassword('')
        setNotice(
          'Cadastro criado! Sua conta aguarda a aprovação do administrador — depois disso, é só entrar.'
        )
      } else {
        onLoggedIn(created)
      }
    } catch (err) {
      setError(cleanIpcError(err))
    } finally {
      setBusy(false)
    }
  }

  const switchMode = (next: Mode): void => {
    setMode(next)
    setError(null)
    setNotice(null)
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-dot" />
          <h1>OsvaCode</h1>
        </div>
        <p className="login-subtitle">
          {mode === 'signin' ? 'Entre com a sua conta' : 'Crie a sua conta'}
          <span className="login-server">
            {server.replace(/^https?:\/\//, '') || 'nenhum servidor definido'}
            {' · '}
            <button className="login-server-change" onClick={() => setEditingServer((v) => !v)}>
              {editingServer ? 'ocultar' : 'trocar servidor'}
            </button>
          </span>
        </p>

        {editingServer && (
          <label>
            Servidor (Open WebUI)
            <input
              value={server}
              placeholder="https://chat.seuservidor.com"
              onChange={(e) => setServer(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && setEditingServer(false)}
            />
          </label>
        )}

        <div className="login-tabs">
          <button
            className={mode === 'signin' ? 'active' : ''}
            onClick={() => switchMode('signin')}
          >
            Entrar
          </button>
          <button
            className={mode === 'signup' ? 'active' : ''}
            onClick={() => switchMode('signup')}
          >
            Criar cadastro
          </button>
        </div>

        {mode === 'signup' && (
          <label>
            Nome
            <input
              value={name}
              autoFocus
              placeholder="Seu nome completo"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
          </label>
        )}
        <label>
          E-mail
          <input
            type="email"
            value={email}
            autoFocus={mode === 'signin'}
            placeholder="voce@email.com"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </label>
        <label>
          Senha
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </label>

        {error && <p className="login-error">⚠️ {error}</p>}
        {notice && <p className="login-notice">✅ {notice}</p>}

        <button className="send login-submit" onClick={() => void submit()} disabled={busy || !canSubmit}>
          {busy ? 'Aguarde…' : mode === 'signin' ? 'Entrar' : 'Criar cadastro'}
        </button>

        {mode === 'signup' && (
          <p className="login-hint">
            Contas novas passam pela aprovação do administrador antes do primeiro acesso.
          </p>
        )}
      </div>
    </div>
  )
}
