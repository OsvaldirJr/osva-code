// Autenticação contra as contas do Open WebUI + persistência da sessão local.

import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import type { AuthSession } from '../shared/types'

interface AuthResponse {
  token: string
  id: string
  name: string
  email: string
  role: string
}

async function authRequest(
  url: string,
  path: string,
  body: Record<string, string>,
  badCredentialsMessage: string
): Promise<AuthSession> {
  const baseUrl = url.replace(/\/+$/, '')
  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch {
    throw new Error(`Não consegui me conectar ao servidor ${baseUrl}. Verifique sua internet.`)
  }

  if (response.status === 400 || response.status === 401 || response.status === 403) {
    const detail = (await response.json().catch(() => null)) as { detail?: string } | null
    throw new Error(detail?.detail ?? badCredentialsMessage)
  }
  if (!response.ok) {
    throw new Error(`O servidor respondeu com o erro ${response.status}.`)
  }

  const data = (await response.json()) as AuthResponse
  return {
    token: data.token,
    serverUrl: baseUrl,
    user: { id: data.id, name: data.name, email: data.email, role: data.role }
  }
}

export async function owuiSignin(url: string, email: string, password: string): Promise<AuthSession> {
  return authRequest(url, '/api/v1/auths/signin', { email, password }, 'E-mail ou senha incorretos.')
}

export async function owuiSignup(
  url: string,
  name: string,
  email: string,
  password: string
): Promise<AuthSession> {
  return authRequest(
    url,
    '/api/v1/auths/signup',
    { name, email, password },
    'Não foi possível criar o cadastro. Verifique os dados.'
  )
}

function sessionPath(): string {
  return join(app.getPath('userData'), 'session.json')
}

export function loadSessionFile(): AuthSession | null {
  try {
    if (existsSync(sessionPath())) {
      return JSON.parse(readFileSync(sessionPath(), 'utf-8')) as AuthSession
    }
  } catch {
    // sessão corrompida: trata como deslogado
  }
  return null
}

export function saveSessionFile(session: AuthSession): void {
  writeFileSync(sessionPath(), JSON.stringify(session, null, 2), 'utf-8')
}

export function clearSessionFile(): void {
  try {
    if (existsSync(sessionPath())) unlinkSync(sessionPath())
  } catch {
    // sem sessão para apagar
  }
}
