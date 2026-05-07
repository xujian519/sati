import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import {
  getEdgeClawMemoryService,
  isEdgeClawMemoryEnabled,
} from '../../services/edgeclawMemory/index.js'

export const noParameters = lazySchema(() => z.strictObject({}))

export const memorySearchParameters = lazySchema(() =>
  z.strictObject({
    query: z
      .string()
      .min(1)
      .describe('Question or topic to search in memory.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe('Maximum files to read after manifest selection.'),
  }),
)

export const memoryListParameters = lazySchema(() =>
  z.strictObject({
    kind: z
      .enum(['all', 'user', 'feedback', 'project'])
      .optional()
      .describe('Memory kind to browse.'),
    query: z.string().optional().describe('Optional search string for browsing memory.'),
    limit: z.number().int().min(1).max(50).optional().describe('Maximum items to return.'),
    offset: z.number().int().min(0).optional().describe('Skip this many results before returning items.'),
  }),
)

export const memoryGetParameters = lazySchema(() =>
  z.strictObject({
    ids: z
      .array(z.string().min(1))
      .min(1)
      .describe('One or more relative file ids returned by memory_search or memory_list.'),
  }),
)

export function getMemoryService() {
  return getEdgeClawMemoryService(getCwd())
}

export function memoryToolsEnabled(): boolean {
  return isEdgeClawMemoryEnabled()
}

export function jsonToolResult(
  content: unknown,
  toolUseID: string,
): {
  tool_use_id: string
  type: 'tool_result'
  content: string
} {
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: JSON.stringify(content, null, 2),
  }
}

export function buildListItem(item: {
  relativePath: string
  type: string
  scope: string
  name: string
  description: string
  updatedAt: string
  file: string
}) {
  return {
    id: item.relativePath,
    type: item.type,
    scope: item.scope,
    name: item.name,
    description: item.description,
    updatedAt: item.updatedAt,
    file: item.file,
  }
}
