import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { userInfo } from 'os'
import type { AppSettings } from '../shared/types'

/**
 * URL padrão do Open WebUI. Fonte ÚNICA deste valor no app: os handlers de
 * login/cadastro em index.ts também a consomem daqui.
 * Pode ser sobrescrita por ambiente (OSVACODE_OPENWEBUI_URL) para instâncias
 * self-hosted, ou pelo usuário em Configurações → Open WebUI.
 */
export const DEFAULT_OPENWEBUI_URL =
  process.env.OSVACODE_OPENWEBUI_URL?.trim() || 'https://chat.srv842877.hstgr.cloud'

const DEFAULT_SYSTEM_PROMPT = [
  'Você é um assistente prestativo que responde sempre em português claro e acessível.',
  'Prefira explicações simples; quando usar termos técnicos, explique-os em uma frase.',
  'Quando usar ferramentas, avise o usuário do que está fazendo em linguagem simples.'
].join(' ')

const DEFAULT_SETTINGS: AppSettings = {
  providers: [
    {
      id: 'ollama-local',
      name: 'Meu modelo (Ollama local)',
      baseURL: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'meu-modelo'
    }
  ],
  activeProviderId: 'ollama-local',
  mcpServers: [],
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  userName: defaultUserName(),
  toolPermissions: {},
  openWebUi: {
    url: DEFAULT_OPENWEBUI_URL,
    apiKey: '',
    enabled: false
  }
}

function defaultUserName(): string {
  try {
    const name = userInfo().username
    return name.charAt(0).toUpperCase() + name.slice(1)
  } catch {
    return 'Você'
  }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): AppSettings {
  try {
    if (existsSync(settingsPath())) {
      const raw = JSON.parse(readFileSync(settingsPath(), 'utf-8'))
      return { ...DEFAULT_SETTINGS, ...raw }
    }
  } catch (err) {
    console.error('Falha ao ler settings.json, usando padrões:', err)
  }
  return structuredClone(DEFAULT_SETTINGS)
}

export function saveSettings(settings: AppSettings): void {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
}
