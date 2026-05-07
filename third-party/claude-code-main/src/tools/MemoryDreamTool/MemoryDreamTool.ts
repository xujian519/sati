import { buildTool, type ToolDef } from '../../Tool.js'
import {
  getMemoryService,
  jsonToolResult,
  memoryToolsEnabled,
  noParameters,
} from '../MemoryTool/shared.js'

type InputSchema = ReturnType<typeof noParameters>

export const MemoryDreamTool = buildTool({
  name: 'memory_dream',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Run a manual Dream pass to distill indexed memories into cleaner formal project memory.'
  },
  async prompt() {
    return 'Use this tool to run a manual Dream pass over indexed memory.'
  },
  get inputSchema(): InputSchema {
    return noParameters()
  },
  userFacingName() {
    return 'MemoryDream'
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
    const result = await service.dream('manual')
    const afterOverview = service.overview()
    return {
      data: {
        ok: true,
        beforeOverview,
        afterOverview,
        result,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return jsonToolResult(content, toolUseID)
  },
} satisfies ToolDef<InputSchema>)
