import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  formatAoCombinedList,
  formatAoCronList,
  formatAoCronRunResult,
  formatAoCronStatus,
  formatAoDiscoveryPlanList,
  formatAoDiscoveryPlanStatus,
  formatAoUsage,
  getAoCronJobStatus,
  getAoDiscoveryPlan,
  listAoCronJobs,
  listAoDiscoveryPlans,
  parseAoArgs,
  prepareAoDiscoveryPlanExecution,
  runAoCronJob,
} from './helpers.js'

function buildTaskStatusMap(
  context: LocalJSXCommandContext,
): Map<string, string> {
  const taskStatuses = new Map<string, string>()
  const tasks = context.getAppState().tasks ?? {}

  for (const task of Object.values(tasks)) {
    if (
      !task ||
      typeof task !== 'object' ||
      !('cronTaskId' in task) ||
      !('status' in task)
    ) {
      continue
    }

    const cronTaskId = task.cronTaskId
    const status = task.status
    if (typeof cronTaskId === 'string' && typeof status === 'string') {
      taskStatuses.set(cronTaskId, status)
    }
  }

  return taskStatuses
}

function respond(onDone: LocalJSXCommandOnDone, message: string): void {
  onDone(message, { display: 'system' })
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<null> {
  const parsed = parseAoArgs(args)
  const taskStatusesByCronTaskId = buildTaskStatusMap(context)

  try {
    if (parsed.action === 'help') {
      const message = parsed.error
        ? `${parsed.error}\n\n${formatAoUsage()}`
        : formatAoUsage()
      respond(onDone, message)
      return null
    }

    if (parsed.action === 'list') {
      if (parsed.target === 'cron') {
        const jobs = await listAoCronJobs(taskStatusesByCronTaskId)
        respond(onDone, `# Always-On\n\n${formatAoCronList(jobs)}`)
        return null
      }

      if (parsed.target === 'plan') {
        const plans = await listAoDiscoveryPlans()
        respond(onDone, `# Always-On\n\n${formatAoDiscoveryPlanList(plans)}`)
        return null
      }

      const [jobs, plans] = await Promise.all([
        listAoCronJobs(taskStatusesByCronTaskId),
        listAoDiscoveryPlans(),
      ])
      respond(onDone, formatAoCombinedList({ jobs, plans }))
      return null
    }

    if (parsed.action === 'status' && parsed.target === 'cron') {
      const job = await getAoCronJobStatus(parsed.id, taskStatusesByCronTaskId)
      if (!job) {
        respond(onDone, `No cron job found with id ${parsed.id}.`)
        return null
      }

      respond(onDone, formatAoCronStatus(job))
      return null
    }

    if (parsed.action === 'status' && parsed.target === 'plan') {
      const plan = await getAoDiscoveryPlan(parsed.id)
      if (!plan) {
        respond(onDone, `No discovery plan found with id ${parsed.id}.`)
        return null
      }

      respond(onDone, formatAoDiscoveryPlanStatus(plan))
      return null
    }

    if (parsed.action === 'run' && parsed.target === 'cron') {
      const result = await runAoCronJob(parsed.id)
      respond(onDone, formatAoCronRunResult(parsed.id, result))
      return null
    }

    if (parsed.action === 'run' && parsed.target === 'plan') {
      const execution = await prepareAoDiscoveryPlanExecution(parsed.id)
      onDone(`Running Always-On discovery plan ${execution.plan.id}.`, {
        display: 'system',
        nextInput: execution.prompt,
        submitNextInput: true,
      })
      return null
    }

    respond(onDone, formatAoUsage())
    return null
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : 'Always-On command failed.'
    respond(onDone, `Always-On command failed: ${message}`)
    return null
  }
}
