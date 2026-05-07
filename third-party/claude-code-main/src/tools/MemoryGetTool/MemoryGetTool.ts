import { buildTool, type ToolDef } from '../../Tool.js'
import {
  getMemoryService,
  jsonToolResult,
  memoryGetParameters,
  memoryToolsEnabled,
} from '../MemoryTool/shared.js'

type InputSchema = ReturnType<typeof memoryGetParameters>

export const MemoryGetTool = buildTool({
  name: 'memory_get',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Load exact memory files by ids returned from memory_search or memory_list.'
  },
  async prompt() {
    return 'Use this tool to read exact memory files by id.'
  },
  get inputSchema(): InputSchema {
    return memoryGetParameters()
  },
  userFacingName() {
    return 'MemoryGet'
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
  async call({ ids }) {
    const records = getMemoryService().get(ids)
    const foundIds = new Set(records.map(record => record.relativePath))
    return {
      data: {
        ok: true,
        requestedIds: ids,
        foundIds: Array.from(foundIds),
        missingIds: ids.filter(id => !foundIds.has(id)),
        count: records.length,
        records,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return jsonToolResult(content, toolUseID)
  },
} satisfies ToolDef<InputSchema>)
