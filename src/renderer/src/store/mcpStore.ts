// mcpStore — Zustand store for MCP config and server connection status.

import { create } from 'zustand'
import type { McpConfig, McpServerConfig, McpToolInfo } from '@shared/types'

interface ServerInfo {
  tools: McpToolInfo[]
  status: 'idle' | 'testing' | 'connected' | 'error'
  error?: string
}

interface McpState {
  config: McpConfig
  serverInfos: Record<string, ServerInfo>
  load: () => Promise<void>
  addServer: (name: string, config: McpServerConfig) => Promise<void>
  updateServer: (name: string, config: Partial<McpServerConfig>) => Promise<void>
  deleteServer: (name: string) => Promise<void>
  testServer: (name: string) => Promise<void>
}

export const useMcpStore = create<McpState>((set, get) => ({
  config: { servers: {} },
  serverInfos: {},

  load: async () => {
    const config = await window.api.mcp.getConfig()
    set({ config })
  },

  addServer: async (name, serverConfig) => {
    const config = await window.api.mcp.addServer(name, serverConfig)
    set({ config })
  },

  updateServer: async (name, serverConfig) => {
    const config = await window.api.mcp.updateServer(name, serverConfig)
    set({ config })
  },

  deleteServer: async (name) => {
    const config = await window.api.mcp.deleteServer(name)
    const serverInfos = { ...get().serverInfos }
    delete serverInfos[name]
    set({ config, serverInfos })
  },

  testServer: async (name) => {
    const config = get().config
    const serverConfig = config.servers[name]
    if (!serverConfig) return

    set((state) => ({
      serverInfos: {
        ...state.serverInfos,
        [name]: { tools: [], status: 'testing' }
      }
    }))

    const result = await window.api.mcp.testServer(serverConfig)

    set((state) => ({
      serverInfos: {
        ...state.serverInfos,
        [name]: {
          tools: result.tools,
          status: result.error ? 'error' : 'connected',
          error: result.error
        }
      }
    }))
  }
}))
