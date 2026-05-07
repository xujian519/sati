export type PermissionMode =
  | 'ask'
  | 'skip_all_permission_checks'
  | 'follow_a_plan'

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface ClaudeForChromeContext {
  serverName: string
  logger: Logger
  socketPath: string
  getSocketPaths: () => string[]
  clientTypeId: string
  onAuthenticationError?: () => void
  onToolCallDisconnected?: () => string
  onExtensionPaired?: (deviceId: string, name: string) => void
  onExtensionUnpaired?: () => void
  bridgeUrl?: string
  permissionMode?: PermissionMode
}

export const BROWSER_TOOLS: Array<{ name: string }> = []

export function createClaudeForChromeMcpServer(): never {
  throw new Error('Claude in Chrome is unavailable in this build')
}
