import { buildTool, type ToolDef } from '../../Tool.js'
import {
  getMemoryService,
  jsonToolResult,
  memoryToolsEnabled,
  noParameters,
} from '../MemoryTool/shared.js'

type InputSchema = ReturnType<typeof noParameters>

export const MemoryOverviewTool = buildTool({
  name: 'memory_overview',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Return current ClawXMemory counts, freshness, indexing backlog, and runtime health.'
  },
  async prompt() {
    return 'Use this tool to inspect current ClawXMemory status, freshness, backlog, and health.'
  },
  get inputSchema(): InputSchema {
    return noParameters()
  },
  userFacingName() {
    return 'MemoryOverview'
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
  async call() {
    const overview = getMemoryService().overview()
    return {
      data: {
        ok: true,
        overview,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return jsonToolResult(content, toolUseID)
  },
} satisfies ToolDef<InputSchema, { ok: true; overview: unknown }>)
