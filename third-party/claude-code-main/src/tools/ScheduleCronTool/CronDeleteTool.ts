import { z } from 'zod/v4'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCronFilePath } from '../../utils/cronTasks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import { requestCronDaemon } from '../../daemon/client.js'
import { assertCronDaemonOk } from '../../daemon/ipc.js'
import {
  buildCronDeletePrompt,
  CRON_DELETE_DESCRIPTION,
  CRON_DELETE_TOOL_NAME,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderDeleteResultMessage, renderDeleteToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().describe('Job ID returned by CronCreate.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type DeleteOutput = z.infer<OutputSchema>

export const CronDeleteTool = buildTool({
  name: CRON_DELETE_TOOL_NAME,
  searchHint: 'cancel a scheduled cron job',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isKairosCronEnabled()
  },
  toAutoClassifierInput(input) {
    return input.id
  },
  async description() {
    return CRON_DELETE_DESCRIPTION
  },
  async prompt() {
    return buildCronDeletePrompt(isDurableCronEnabled())
  },
  getPath() {
    return getCronFilePath()
  },
  async validateInput(input): Promise<ValidationResult> {
    const response = await requestCronDaemon({
      type: 'list_tasks',
      projectRoot: getProjectRoot(),
      originSessionId: getSessionId(),
    })
    assertCronDaemonOk(response)
    if (response.data.type !== 'list_tasks') {
      throw new Error('Unexpected Cron daemon list response')
    }
    const tasks = response.data.tasks
    const task = tasks.find(t => t.id === input.id)
    if (!task) {
      return {
        result: false,
        message: `No scheduled job with id '${input.id}'`,
        errorCode: 1,
      }
    }
    // Teammates may only delete their own crons.
    const ctx = getTeammateContext()
    if (ctx && task.agentId !== ctx.agentId) {
      return {
        result: false,
        message: `Cannot delete cron job '${input.id}': owned by another agent`,
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async call({ id }) {
    const response = await requestCronDaemon({
      type: 'delete_task',
      projectRoot: getProjectRoot(),
      originSessionId: getSessionId(),
      taskId: id,
    })
    assertCronDaemonOk(response)
    if (response.data.type !== 'delete_task') {
      throw new Error('Unexpected Cron daemon delete response')
    }
    return { data: { id } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Cancelled job ${output.id}.`,
    }
  },
  renderToolUseMessage: renderDeleteToolUseMessage,
  renderToolResultMessage: renderDeleteResultMessage,
} satisfies ToolDef<InputSchema, DeleteOutput>)
