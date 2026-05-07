import type { Message } from '../../types/message.js'
import {
  buildEdgeClawMemoryPromptSection,
  EdgeClawMemoryService,
  summarizeTranscriptMessage,
  type MemoryMessage,
} from '../../../../edgeclaw-memory-core/lib/index.js'
import {
  getEdgeClawMemoryServiceOptions,
  loadEdgeClawConfig,
} from '../../../edgeclaw-config'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'

const servicesByWorkspace = new Map<string, EdgeClawMemoryService>()
type TranscriptSummary = ReturnType<typeof summarizeTranscriptMessage>
type UserTranscriptSummary = TranscriptSummary & { role: 'user' }
type ConversationTranscriptSummary = TranscriptSummary & {
  role: 'user' | 'assistant'
}

export function isEdgeClawMemoryEnabled(): boolean {
  try {
    return loadEdgeClawConfig().memory?.enabled !== false
  } catch {
    // Fall back to legacy env handling below.
  }
  const raw = process.env.EDGECLAW_MEMORY_ENABLED
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return false
  }
  if (isEnvTruthy(raw)) {
    return true
  }
  if (isEnvDefinedFalsy(raw)) {
    return false
  }
  return true
}

export function getEdgeClawMemoryService(
  workspaceDir: string,
): EdgeClawMemoryService {
  const existing = servicesByWorkspace.get(workspaceDir)
  if (existing) {
    return existing
  }

  const service = new EdgeClawMemoryService({
    workspaceDir,
    source: 'claude-code-main',
    ...getEdgeClawMemoryServiceOptions(),
  })
  servicesByWorkspace.set(workspaceDir, service)
  return service
}

export function getEdgeClawMemoryPromptSection(toolNames: Iterable<string>) {
  return buildEdgeClawMemoryPromptSection({
    availableTools: toolNames,
    citationsMode: 'off',
  })
}

export function buildEdgeClawMemoryQuery(messages: readonly Message[]): string {
  const userTexts = messages
    .map(message => summarizeTranscriptMessage(message))
    .filter(
      (message): message is UserTranscriptSummary =>
        message.role === 'user' && message.content.trim().length > 0,
    )
    .map(message => message.content.trim())

  return userTexts.at(-1) ?? ''
}

export function buildEdgeClawRecentMessages(
  messages: readonly Message[],
  limit = 12,
): MemoryMessage[] {
  const normalized = messages
    .map(message => summarizeTranscriptMessage(message))
    .filter(
      (message): message is ConversationTranscriptSummary =>
        (message.role === 'user' || message.role === 'assistant') &&
        message.content.trim().length > 0,
    )
    .map(message => ({
      role: message.role,
      content: message.content.trim(),
    }))

  return normalized.slice(-limit)
}

export function resetEdgeClawMemoryServices(): void {
  for (const service of servicesByWorkspace.values()) {
    try {
      service.close()
    } catch {
      // ignore close failures during shutdown/tests
    }
  }
  servicesByWorkspace.clear()
}
