import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
} from '../constants/xml.js'
import { getSessionId } from '../bootstrap/state.js'
import { type QueryParams, query } from '../query.js'
import type { SetAppState } from '../Task.js'
import { createTaskStateBase } from '../Task.js'
import type { Message } from '../types/message.js'
import { asAgentId } from '../types/ids.js'
import { createAbortController } from '../utils/abortController.js'
import {
  runWithAgentContext,
  type SubagentContext,
} from '../utils/agentContext.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import {
  type CronTask,
  updateCronTask,
} from '../utils/cronTasks.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import {
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
} from '../utils/messages.js'
import { getQuerySourceForAgent } from '../utils/promptCategory.js'
import {
  getAgentTranscript,
  getAgentTranscriptPath,
  recordSidechainTranscript,
  setAgentTranscriptSession,
} from '../utils/sessionStorage.js'
import {
  evictTaskOutput,
  initTaskOutputAsSymlink,
} from '../utils/task/diskOutput.js'
import { registerTask, updateTaskState } from '../utils/task/framework.js'
import {
  createActivityDescriptionResolver,
  createProgressTracker,
  getProgressUpdate,
  type LocalAgentTaskState,
  updateProgressFromMessage,
} from './LocalAgentTask/LocalAgentTask.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import type { CustomAgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import {
  type ContentReplacementRecord,
  reconstructContentReplacementState,
} from '../utils/toolResultStorage.js'

export const CRON_BACKGROUND_AGENT_TYPE = 'cron-session'
export const CRON_BACKGROUND_QUERY_SOURCE = getQuerySourceForAgent(
  CRON_BACKGROUND_AGENT_TYPE,
  true,
)

const CRON_BACKGROUND_AGENT: CustomAgentDefinition = {
  agentType: CRON_BACKGROUND_AGENT_TYPE,
  whenToUse: 'Cron background session',
  source: 'userSettings',
  getSystemPrompt: () => '',
}

const runningRecurringCrons = new Set<string>()

type CronBackgroundTaskState = LocalAgentTaskState & {
  agentType: 'main-session'
  cronTaskId: string
  transcriptKey: string
}

export type CreateCronQueryParams = (args: {
  messages: Message[]
  abortController: AbortController
  transcriptKey: string
  querySource: typeof CRON_BACKGROUND_QUERY_SOURCE
}) => Promise<Omit<QueryParams, 'messages'>>

export type CronTaskUpdater = (
  id: string,
  updater: (task: CronTask) => CronTask,
) => Promise<CronTask | null>

export type CronNotificationSink = (message: string) => Promise<void>

export type StartCronBackgroundTaskResult =
  | {
      status: 'started'
      runtimeTaskId: string
      transcriptKey: string
      completion: Promise<void>
    }
  | {
      status: 'skipped'
      transcriptKey: string
      reason: 'already-running'
      completion: Promise<void>
    }

export async function startCronBackgroundTask({
  task,
  setAppState,
  createQueryParams,
  dir,
  updateTask,
  notificationSink,
}: {
  task: CronTask
  setAppState: SetAppState
  createQueryParams: CreateCronQueryParams
  dir?: string
  updateTask?: CronTaskUpdater
  notificationSink?: CronNotificationSink
}): Promise<StartCronBackgroundTaskResult> {
  if (task.recurring && runningRecurringCrons.has(task.id)) {
    logForDebugging(
      `[CronBackgroundTask] skipping ${task.id}: previous run still active`,
    )
    return {
      status: 'skipped',
      transcriptKey: task.transcriptKey ?? `cron-pending-${task.id}`,
      reason: 'already-running',
      completion: Promise.resolve(),
    }
  }

  const recurringState = task.recurring
    ? await ensureRecurringTranscript(task, dir, updateTask)
    : {
        task,
        transcriptKey: generateCronId('cron-shot'),
        transcriptSessionId: task.originSessionId ?? getSessionId(),
      }

  const { transcriptKey, transcriptSessionId } = recurringState
  task.transcriptKey = transcriptKey
  task.originSessionId = transcriptSessionId
  setAgentTranscriptSession(transcriptKey, transcriptSessionId)

  const history = task.recurring
    ? await loadRecurringTranscript(transcriptKey)
    : { messages: [], contentReplacements: [], lastUuid: null }
  const promptMessage = createUserMessage({
    content: task.prompt,
    isMeta: true,
  })
  const initialMessages = [...history.messages, promptMessage]
  const runtimeTaskId = generateCronId('cron-run')
  task.lastRunTaskId = runtimeTaskId

  const description = describeCronTask(task)
  const abortController = createAbortController()

  const taskOutputPathPromise = initTaskOutputAsSymlink(
    runtimeTaskId,
    getAgentTranscriptPath(asAgentId(transcriptKey)),
  )

  const unregisterCleanup = registerCleanup(async () => {
    setAppState(prev => {
      const { [runtimeTaskId]: _removed, ...rest } = prev.tasks
      return { ...prev, tasks: rest }
    })
  })

  const taskState: CronBackgroundTaskState = {
    ...createTaskStateBase(runtimeTaskId, 'local_agent', description),
    type: 'local_agent',
    status: 'running',
    agentId: transcriptKey,
    prompt: task.prompt,
    selectedAgent: CRON_BACKGROUND_AGENT,
    agentType: 'main-session',
    abortController,
    unregisterCleanup,
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: true,
    messages: initialMessages,
    cronTaskId: task.id,
    transcriptKey,
  }
  registerTask(taskState, setAppState)

  if (task.recurring) {
    runningRecurringCrons.add(task.id)
  }

  let resolveCompletion: (() => void) | undefined
  let rejectCompletion: ((error: unknown) => void) | undefined
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })

  void runWithAgentContext(
    {
      agentId: asAgentId(transcriptKey),
      agentType: 'subagent',
      subagentName: CRON_BACKGROUND_AGENT_TYPE,
      isBuiltIn: true,
    } satisfies SubagentContext,
    async () => {
      let success = false
      let wasAborted = false
      try {
        await recordSidechainTranscript([promptMessage], transcriptKey, history.lastUuid)

        const builtQueryParams = await createQueryParams({
          messages: initialMessages,
          abortController,
          transcriptKey,
          querySource: CRON_BACKGROUND_QUERY_SOURCE,
        })
        const toolUseContext = {
          ...builtQueryParams.toolUseContext,
          abortController,
          messages: initialMessages,
          agentId: asAgentId(transcriptKey),
          agentType: CRON_BACKGROUND_AGENT_TYPE,
          options: {
            ...builtQueryParams.toolUseContext.options,
            querySource: CRON_BACKGROUND_QUERY_SOURCE,
          },
          contentReplacementState:
            builtQueryParams.toolUseContext.contentReplacementState === undefined
              ? undefined
              : reconstructContentReplacementState(
                  history.messages,
                  history.contentReplacements,
                ),
        }
        const queryParams: QueryParams = {
          ...builtQueryParams,
          querySource: CRON_BACKGROUND_QUERY_SOURCE,
          toolUseContext,
          messages: initialMessages,
        }

        const runMessages = [...initialMessages]
        const progressTracker = createProgressTracker()
        const resolveActivityDescription = createActivityDescriptionResolver(
          toolUseContext.options.tools,
        )
        let lastRecordedUuid: UUID | null = promptMessage.uuid

        for await (const event of query(queryParams)) {
          if (abortController.signal.aborted) {
            wasAborted = true
            let shouldEmitStopped = false
            updateTaskState<CronBackgroundTaskState>(
              runtimeTaskId,
              setAppState,
              currentTask => {
                if (currentTask.status !== 'running') {
                  return currentTask
                }
                shouldEmitStopped = currentTask.notified !== true
                currentTask.unregisterCleanup?.()
                return {
                  ...currentTask,
                  status: 'killed',
                  endTime: Date.now(),
                  notified: true,
                  messages: currentTask.messages?.length
                    ? [currentTask.messages.at(-1)!]
                    : undefined,
                }
              },
            )
            void evictTaskOutput(runtimeTaskId)
            if (shouldEmitStopped) {
              emitTaskTerminatedSdk(runtimeTaskId, 'stopped', {
                summary: description,
              })
            }
            return
          }

          if (
            event.type !== 'user' &&
            event.type !== 'assistant' &&
            event.type !== 'system'
          ) {
            continue
          }

          runMessages.push(event)
          await recordSidechainTranscript([event], transcriptKey, lastRecordedUuid)
          lastRecordedUuid = event.uuid

          updateProgressFromMessage(
            progressTracker,
            event,
            resolveActivityDescription,
            toolUseContext.options.tools,
          )

          setAppState(prev => {
            const currentTask = prev.tasks[runtimeTaskId]
            if (!currentTask || currentTask.type !== 'local_agent') {
              return prev
            }
            return {
              ...prev,
              tasks: {
                ...prev.tasks,
                [runtimeTaskId]: {
                  ...currentTask,
                  messages: runMessages,
                  progress: getProgressUpdate(progressTracker),
                },
              },
            }
          })
        }

        success = true
      } catch (error) {
        logError(error)
      } finally {
        let completionError: unknown
        if (!wasAborted) {
          try {
            await finishCronBackgroundTask(
              runtimeTaskId,
              description,
              success,
              setAppState,
              taskOutputPathPromise,
              notificationSink,
            )
          } catch (error) {
            completionError = error
            logError(error)
          }
        }
        if (task.recurring) {
          runningRecurringCrons.delete(task.id)
        }
        if (completionError) {
          rejectCompletion?.(completionError)
        } else {
          resolveCompletion?.()
        }
      }
    },
  )

  return {
    status: 'started',
    runtimeTaskId,
    transcriptKey,
    completion,
  }
}

export async function ensureRecurringTranscript(
  task: CronTask,
  dir?: string,
  updateTask?: CronTaskUpdater,
): Promise<{
  task: CronTask
  transcriptKey: string
  transcriptSessionId: string
}> {
  const existingSessionId = task.originSessionId ?? getSessionId()
  if (task.transcriptKey) {
    const updated = task.originSessionId
      ? task
      : ((await (updateTask ?? ((id, updater) => updateCronTask(id, updater, dir)))(
          task.id,
          currentTask => ({
            ...currentTask,
            originSessionId: currentTask.originSessionId ?? existingSessionId,
          }),
        )) ?? {
          ...task,
          originSessionId: existingSessionId,
        })

    return {
      task: updated,
      transcriptKey: updated.transcriptKey ?? task.transcriptKey,
      transcriptSessionId: updated.originSessionId ?? existingSessionId,
    }
  }

  const transcriptKey = generateCronId('cron-thread')
  const updated =
    (await (updateTask ?? ((id, updater) => updateCronTask(id, updater, dir)))(
      task.id,
      currentTask => ({
        ...currentTask,
        transcriptKey,
        originSessionId: currentTask.originSessionId ?? existingSessionId,
      }),
    )) ??
    ({
      ...task,
      transcriptKey,
      originSessionId: existingSessionId,
    } satisfies CronTask)

  return {
    task: updated,
    transcriptKey,
    transcriptSessionId: updated.originSessionId ?? existingSessionId,
  }
}

async function loadRecurringTranscript(transcriptKey: string): Promise<{
  messages: Message[]
  contentReplacements: ContentReplacementRecord[]
  lastUuid: UUID | null
}> {
  const transcript = await getAgentTranscript(asAgentId(transcriptKey))
  if (!transcript) {
    return { messages: [], contentReplacements: [], lastUuid: null }
  }
  const messages = filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUses(transcript.messages),
    ),
  )
  return {
    messages,
    contentReplacements: transcript.contentReplacements,
    lastUuid: (messages.at(-1)?.uuid as UUID | undefined) ?? null,
  }
}

async function finishCronBackgroundTask(
  runtimeTaskId: string,
  description: string,
  success: boolean,
  setAppState: SetAppState,
  taskOutputPathPromise: Promise<string>,
  notificationSink?: CronNotificationSink,
): Promise<void> {
  let wasBackgrounded = true

  updateTaskState<CronBackgroundTaskState>(runtimeTaskId, setAppState, task => {
    if (task.status !== 'running') {
      return task
    }
    wasBackgrounded = task.isBackgrounded ?? true
    task.unregisterCleanup?.()
    return {
      ...task,
      status: success ? 'completed' : 'failed',
      endTime: Date.now(),
      messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
    }
  })

  const outputPath = await taskOutputPathPromise
  await evictTaskOutput(runtimeTaskId)

  if (wasBackgrounded) {
    await enqueueCronNotification(
      runtimeTaskId,
      description,
      success ? 'completed' : 'failed',
      setAppState,
      outputPath,
      notificationSink,
    )
  } else {
    updateTaskState<CronBackgroundTaskState>(runtimeTaskId, setAppState, task => ({
      ...task,
      notified: true,
    }))
    emitTaskTerminatedSdk(runtimeTaskId, success ? 'completed' : 'failed', {
      summary: description,
    })
  }
}

async function enqueueCronNotification(
  runtimeTaskId: string,
  description: string,
  status: 'completed' | 'failed',
  setAppState: SetAppState,
  outputPath: string,
  notificationSink?: CronNotificationSink,
): Promise<void> {
  let shouldEnqueue = false
  updateTaskState<CronBackgroundTaskState>(runtimeTaskId, setAppState, task => {
    if (task.notified) return task
    shouldEnqueue = true
    return { ...task, notified: true }
  })
  if (!shouldEnqueue) {
    return
  }

  const summary =
    status === 'completed'
      ? `Cron task "${description}" completed`
      : `Cron task "${description}" failed`

  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${runtimeTaskId}</${TASK_ID_TAG}>
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`

  if (notificationSink) {
    await notificationSink(message)
    return
  }

  enqueuePendingNotification({ value: message, mode: 'task-notification' })
}

function describeCronTask(task: CronTask): string {
  return task.recurring ? `Recurring cron ${task.id}` : `One-shot cron ${task.id}`
}

export function generateCronId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 16)}`
}
