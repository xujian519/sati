import { useEffect } from 'react'
import { useAppStateStore, useSetAppState } from '../state/AppState.js'
import { isTerminalTaskStatus } from '../Task.js'
import {
  findTeammateTaskByAgentId,
  injectUserMessageToTeammate,
} from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { isKairosCronEnabled } from '../tools/ScheduleCronTool/prompt.js'
import { getCronJitterConfig } from '../utils/cronJitterConfig.js'
import { createCronScheduler } from '../utils/cronScheduler.js'
import { type CronTask, removeCronTasks } from '../utils/cronTasks.js'
import { logForDebugging } from '../utils/debug.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import { WORKLOAD_CRON } from '../utils/workloadContext.js'

type Props = {
  /**
   * When true, auto-enable the scheduler on startup before CronCreate flips
   * the session flag. Assistant mode can start with durable tasks already on
   * disk.
   */
  assistantMode?: boolean
  runLeadCronTask: (task: CronTask) => void | Promise<void>
}

/**
 * REPL wrapper for the cron scheduler. Mounts the scheduler once and tears
 * it down on unmount. Missed one-shot prompts still go into the command queue
 * as 'later' priority; normal fires route through onFireTask into the caller's
 * background runner.
 *
 * Scheduler core (timer, file watcher, fire logic) lives in cronScheduler.ts
 * so SDK/-p mode can share it — see print.ts for the headless wiring.
 */
export function useScheduledTasks({
  assistantMode = false,
  runLeadCronTask,
}: Props): void {
  const store = useAppStateStore()
  const setAppState = useSetAppState()

  useEffect(() => {
    // Runtime gate checked here (not at the hook call site) so the hook
    // stays unconditionally mounted — rules-of-hooks forbid wrapping the
    // call in a dynamic condition. getFeatureValue_CACHED_WITH_REFRESH
    // reads from disk; the 5-min TTL fires a background refetch but the
    // effect won't re-run on value flip (assistantMode is the only dep),
    // so this guard alone is launch-grain. The mid-session killswitch is
    // the isKilled option below — check() polls it every tick.
    if (!isKairosCronEnabled()) return

    // System-generated — hidden from queue preview and transcript UI.
    // In brief mode, executeForkedSlashCommand runs as a background
    // subagent and returns no visible messages. In normal mode,
    // isMeta is only propagated for plain-text prompts (via
    // processTextPrompt); slash commands like /context:fork do not
    // forward isMeta, so their messages remain visible in the
    // transcript. This is acceptable since normal mode is not the
    // primary use case for scheduled tasks.
    const enqueueForLead = (prompt: string) =>
      enqueuePendingNotification({
        value: prompt,
        mode: 'prompt',
        priority: 'later',
        isMeta: true,
        // Threaded through to cc_workload= in the billing-header
        // attribution block so the API can serve cron-initiated requests
        // at lower QoS when capacity is tight. No human is actively
        // waiting on this response.
        workload: WORKLOAD_CRON,
      })

    const scheduler = createCronScheduler({
      // Missed-task surfacing (onFire fallback). Teammate crons are always
      // session-only (durable:false) so they never appear in the missed list,
      // which is populated from disk at scheduler startup — this path only
      // handles team-lead durable crons.
      onFire: enqueueForLead,
      // Normal fires receive the full CronTask so we can route by agentId.
      onFireTask: task => {
        if (task.agentId) {
          const teammate = findTeammateTaskByAgentId(
            task.agentId,
            store.getState().tasks,
          )
          if (teammate && !isTerminalTaskStatus(teammate.status)) {
            injectUserMessageToTeammate(teammate.id, task.prompt, setAppState)
            return
          }
          // Teammate is gone — clean up the orphaned cron so it doesn't keep
          // firing into nowhere every tick. One-shots would auto-delete on
          // fire anyway, but recurring crons would loop until auto-expiry.
          logForDebugging(
            `[ScheduledTasks] teammate ${task.agentId} gone, removing orphaned cron ${task.id}`,
          )
          return removeCronTasks([task.id]).catch(error =>
            logForDebugging(
              `[ScheduledTasks] failed to remove orphaned cron ${task.id}: ${String(error)}`,
            ),
          )
        }
        return Promise.resolve(runLeadCronTask(task)).catch(error =>
          logForDebugging(
            `[ScheduledTasks] failed to start cron background task ${task.id}: ${String(error)}`,
          ),
        )
      },
      // Deliberately no shouldDeferFire gate here: lead cron fires should
      // dispatch immediately into isolated background sidechains, even while
      // the foreground turn is still streaming.
      assistantMode,
      getJitterConfig: getCronJitterConfig,
      isKilled: () => !isKairosCronEnabled(),
    })
    scheduler.start()
    return () => scheduler.stop()
    // assistantMode is stable for the session lifetime; store/setAppState are
    // stable refs from useSyncExternalStore; runLeadCronTask is a stable useCallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantMode])
}
