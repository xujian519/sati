import { buildTool, type ToolDef } from '../../Tool.js'
import {
  getMemoryService,
  jsonToolResult,
  memoryToolsEnabled,
  noParameters,
} from '../MemoryTool/shared.js'

type InputSchema = ReturnType<typeof noParameters>

export const MemoryFlushTool = buildTool({
  name: 'memory_flush',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Run a manual extraction flush so pending memory becomes searchable sooner.'
  },
  async prompt() {
    return 'Use this tool to flush pending memory into searchable indexed memory.'
  },
  get inputSchema(): InputSchema {
    return noParameters()
  },
  userFacingName() {
    return 'MemoryFlush'
  },
  isEnabled() {
    return memoryToolsEnabled()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  renderToolUseMessage() {
    return null
  },
  async call() {
    const service = getMemoryService()
    const beforeOverview = service.overview()
    const stats = await service.flush({
      reason: 'manual',
    })
    const afterOverview = service.overview()
    return {
      data: {
        ok: true,
        scope: 'all',
        reason: 'manual',
        beforeOverview,
        afterOverview,
        stats,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return jsonToolResult(content, toolUseID)
  },
} satisfies ToolDef<InputSchema>)
