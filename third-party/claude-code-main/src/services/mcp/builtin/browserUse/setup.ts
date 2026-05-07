import { join } from 'path'
import { fileURLToPath } from 'url'
import { buildMcpToolName } from '../../mcpStringUtils.js'
import type { ScopedMcpServerConfig } from '../../types.js'
import { BROWSER_USE_MCP_SERVER_NAME } from './common.js'
import { BROWSER_TOOLS } from './tools.js'

export function setupBrowserUseMCP(): {
  mcpConfig: Record<string, ScopedMcpServerConfig>
  allowedTools: string[]
} {
  const allowedTools = BROWSER_TOOLS.map(t =>
    buildMcpToolName(BROWSER_USE_MCP_SERVER_NAME, t.name),
  )

  const args = [
    join(fileURLToPath(import.meta.url), '..', 'mcpServer.js'),
    '--browser-use-mcp',
  ]

  return {
    mcpConfig: {
      [BROWSER_USE_MCP_SERVER_NAME]: {
        type: 'stdio',
        command: process.execPath,
        args,
        scope: 'dynamic',
      } as const,
    },
    allowedTools,
  }
}
