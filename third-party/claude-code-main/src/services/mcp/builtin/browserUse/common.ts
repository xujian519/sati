import { normalizeNameForMCP } from '../../normalization.js'

export const BROWSER_USE_MCP_SERVER_NAME = 'browser-use'

export function isBrowserUseMCPServer(name: string): boolean {
  return normalizeNameForMCP(name) === BROWSER_USE_MCP_SERVER_NAME
}
