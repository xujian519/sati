import { buildTool, type ToolDef } from '../../Tool.js'
import {
  buildListItem,
  getMemoryService,
  jsonToolResult,
  memoryListParameters,
  memoryToolsEnabled,
} from '../MemoryTool/shared.js'

type InputSchema = ReturnType<typeof memoryListParameters>

export const MemoryListTool = buildTool({
  name: 'memory_list',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Browse file-based user, feedback, and project memories.'
  },
  async prompt() {
    return 'Use this tool to browse file-based user, feedback, and project memories.'
  },
  get inputSchema(): InputSchema {
    return memoryListParameters()
  },
  userFacingName() {
    return 'MemoryList'
  },
  isEnabled() {
    return memoryToolsEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  renderToolUseMessage() {
    return null
  },
  async call({
    kind = 'all',
    query = '',
    limit = 10,
    offset = 0,
  }) {
    const items = getMemoryService()
      .list({
        ...(kind !== 'all'
          ? { kinds: [kind] as Array<'user' | 'feedback' | 'project'> }
          : {}),
        ...(query ? { query } : {}),
        limit,
        offset,
      })
      .map(buildListItem)

    return {
      data: {
        ok: true,
        kind,
        query,
        limit,
        offset,
        count: items.length,
        items,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return jsonToolResult(content, toolUseID)
  },
} satisfies ToolDef<InputSchema>)
