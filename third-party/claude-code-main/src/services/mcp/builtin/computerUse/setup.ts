import { join } from 'path'
import { fileURLToPath } from 'url'
import { buildMcpToolName } from '../../mcpStringUtils.js'
import type { ScopedMcpServerConfig } from '../../types.js'
import { COMPUTER_USE_MCP_SERVER_NAME } from './common.js'
import { COMPUTER_USE_TOOLS } from './tools.js'

/**
 * Build the dynamic MCP config + allowed tool names for computer-use.
 * The `mcp__computer-use__*` tool names are kept intentionally — the API
 * backend detects these names and emits a computer-use availability hint
 * into the system prompt.
 */
export function setupComputerUseMCP(): {
  mcpConfig: Record<string, ScopedMcpServerConfig>
  allowedTools: string[]
} {
  const allowedTools = COMPUTER_USE_TOOLS.map(t =>
    buildMcpToolName(COMPUTER_USE_MCP_SERVER_NAME, t.name),
  )

  const args = [
    join(fileURLToPath(import.meta.url), '..', 'mcpServer.js'),
    '--computer-use-mcp',
  ]

  return {
    mcpConfig: {
      [COMPUTER_USE_MCP_SERVER_NAME]: {
        type: 'stdio',
        command: process.execPath,
        args,
        scope: 'dynamic',
      } as const,
    },
    allowedTools,
  }
}
