import { buildTool, type ToolDef } from '../../Tool.js'
import {
  getMemoryService,
  jsonToolResult,
  memorySearchParameters,
  memoryToolsEnabled,
} from '../MemoryTool/shared.js'

type InputSchema = ReturnType<typeof memorySearchParameters>

export const MemorySearchTool = buildTool({
  name: 'memory_search',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Run long-term memory retrieval for a question or topic.'
  },
  async prompt() {
    return 'Use this tool to search ClawXMemory for durable user, feedback, or project memory.'
  },
  get inputSchema(): InputSchema {
    return memorySearchParameters()
  },
  userFacingName() {
    return 'MemorySearch'
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
  async call({ query }) {
    const result = await getMemoryService().search(query)
    return {
      data: {
        ok: true,
        query: result.query,
        route: result.intent,
        context: result.context,
        refs: {
          files: result.debug?.selectedFileIds ?? [],
        },
        debug: result.debug,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return jsonToolResult(content, toolUseID)
  },
} satisfies ToolDef<InputSchema>)
