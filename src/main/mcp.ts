import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerConfig, McpServerStatus, McpToolInfo } from '../shared/types'

interface ConnectedServer {
  config: McpServerConfig
  client: Client
  tools: McpToolInfo[]
}

/** Nome de ferramenta aceito pela API OpenAI: [a-zA-Z0-9_-], até 64 chars. */
function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export interface NamespacedTool {
  /** Nome exposto ao modelo, ex.: "github__search_issues" */
  fullName: string
  serverId: string
  serverName: string
  tool: McpToolInfo & { inputSchema?: Record<string, unknown> }
}

const WORKSPACE_ID = '__workspace'
const WORKSPACE_NAME = 'Pasta de trabalho'

interface WorkspaceServer {
  folder: string
  client: Client
  tools: (McpToolInfo & { inputSchema?: Record<string, unknown> })[]
}

export class McpManager {
  private servers = new Map<string, ConnectedServer>()
  private errors = new Map<string, string>()
  private toolIndex = new Map<string, NamespacedTool>()
  private workspace: WorkspaceServer | null = null
  private workspaceError: string | null = null

  /** Conecta servidores habilitados e desconecta os removidos/desabilitados. */
  async sync(configs: McpServerConfig[]): Promise<void> {
    for (const [id, server] of this.servers) {
      const cfg = configs.find((c) => c.id === id)
      if (!cfg || !cfg.enabled) {
        await server.client.close().catch(() => {})
        this.servers.delete(id)
      }
    }
    this.errors.clear()

    for (const cfg of configs.filter((c) => c.enabled)) {
      if (this.servers.has(cfg.id)) continue
      try {
        const transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          env: { ...(process.env as Record<string, string>), ...cfg.env }
        })
        const client = new Client({ name: 'osvacode', version: '0.1.0' })
        await client.connect(transport)
        const result = await client.listTools()
        const tools = result.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>
        }))
        this.servers.set(cfg.id, { config: cfg, client, tools })
      } catch (err) {
        this.errors.set(cfg.id, err instanceof Error ? err.message : String(err))
      }
    }
    this.rebuildToolIndex()
  }

  /**
   * Define a pasta de trabalho da conversa atual: sobe um servidor MCP de
   * arquivos restrito a ela (ou derruba o anterior quando folder é null).
   */
  async setWorkspace(folder: string | null): Promise<void> {
    if ((this.workspace?.folder ?? null) === folder) return

    if (this.workspace) {
      await this.workspace.client.close().catch(() => {})
      this.workspace = null
    }
    this.workspaceError = null

    if (folder) {
      try {
        const transport = new StdioClientTransport({
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', folder],
          env: process.env as Record<string, string>
        })
        const client = new Client({ name: 'osvacode-workspace', version: '0.1.0' })
        await client.connect(transport)
        const result = await client.listTools()
        this.workspace = {
          folder,
          client,
          tools: result.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown>
          }))
        }
      } catch (err) {
        this.workspaceError = err instanceof Error ? err.message : String(err)
      }
    }
    this.rebuildToolIndex()
  }

  private rebuildToolIndex(): void {
    this.toolIndex.clear()
    for (const [id, server] of this.servers) {
      for (const tool of server.tools) {
        const fullName = `${sanitize(id)}__${sanitize(tool.name)}`.slice(0, 64)
        this.toolIndex.set(fullName, {
          fullName,
          serverId: id,
          serverName: server.config.name,
          tool
        })
      }
    }
    if (this.workspace) {
      for (const tool of this.workspace.tools) {
        const fullName = `workspace__${sanitize(tool.name)}`.slice(0, 64)
        this.toolIndex.set(fullName, {
          fullName,
          serverId: WORKSPACE_ID,
          serverName: WORKSPACE_NAME,
          tool
        })
      }
    }
  }

  listNamespacedTools(): NamespacedTool[] {
    return [...this.toolIndex.values()]
  }

  lookup(fullName: string): NamespacedTool | undefined {
    return this.toolIndex.get(fullName)
  }

  /**
   * Resolve um nome vindo do modelo aceitando tanto o nome completo
   * (ex.: "workspace__read_file") quanto o nome "cru" da ferramenta
   * (ex.: apenas "read_file"), que modelos pequenos costumam escrever.
   */
  resolveTool(name: string): NamespacedTool | undefined {
    const direct = this.toolIndex.get(name)
    if (direct) return direct
    for (const entry of this.toolIndex.values()) {
      if (entry.tool.name === name) return entry
    }
    return undefined
  }

  async callTool(fullName: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.toolIndex.get(fullName)
    if (!entry) throw new Error(`Ferramenta desconhecida: ${fullName}`)
    const client =
      entry.serverId === WORKSPACE_ID ? this.workspace?.client : this.servers.get(entry.serverId)?.client
    if (!client) throw new Error(`Servidor MCP desconectado: ${entry.serverName}`)

    const result = await client.callTool({ name: entry.tool.name, arguments: args })
    const content = Array.isArray(result.content) ? result.content : []
    const text = content
      .map((block: { type: string; text?: string }) =>
        block.type === 'text' ? (block.text ?? '') : `[conteúdo do tipo ${block.type}]`
      )
      .join('\n')
    if (result.isError) throw new Error(text || 'A ferramenta retornou um erro.')
    return text || '(a ferramenta não retornou texto)'
  }

  status(configs: McpServerConfig[]): McpServerStatus[] {
    const list = configs.map((cfg) => {
      const connected = this.servers.get(cfg.id)
      return {
        id: cfg.id,
        name: cfg.name,
        connected: Boolean(connected),
        error: this.errors.get(cfg.id),
        tools: connected?.tools.map(({ name, description }) => ({ name, description })) ?? []
      }
    })
    if (this.workspace || this.workspaceError) {
      list.push({
        id: WORKSPACE_ID,
        name: this.workspace ? `${WORKSPACE_NAME} (${this.workspace.folder})` : WORKSPACE_NAME,
        connected: Boolean(this.workspace),
        error: this.workspaceError ?? undefined,
        tools: this.workspace?.tools.map(({ name, description }) => ({ name, description })) ?? []
      })
    }
    return list
  }

  async closeAll(): Promise<void> {
    for (const server of this.servers.values()) {
      await server.client.close().catch(() => {})
    }
    await this.workspace?.client.close().catch(() => {})
    this.workspace = null
    this.servers.clear()
    this.toolIndex.clear()
  }
}
