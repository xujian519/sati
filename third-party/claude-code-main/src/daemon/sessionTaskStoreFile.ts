import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { getSessionScheduledTasksPath } from './paths.js'
import type { DaemonCronTask } from './types.js'
import { parseCronExpression } from '../utils/cron.js'
import { logForDebugging } from '../utils/debug.js'
import { safeParseJSON } from '../utils/json.js'
import { logError } from '../utils/log.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { nextCronRunMs } from '../utils/cronTasks.js'

type SessionCronTaskFile = {
  tasks: Array<{
    id: string
    cron: string
    prompt: string
    createdAt: number
    lastFiredAt?: number
    recurring?: boolean
    manualOnly?: boolean
    transcriptKey?: string
    originSessionId?: string
    agentId?: string
  }>
}

export type ReadSessionScheduledTasksResult = {
  tasks: DaemonCronTask[]
  hadFile: boolean
  pruned: boolean
}

function serializeTask(task: DaemonCronTask): SessionCronTaskFile['tasks'][number] {
  return {
    id: task.id,
    cron: task.cron,
    prompt: task.prompt,
    createdAt: task.createdAt,
    ...(typeof task.lastFiredAt === 'number'
      ? { lastFiredAt: task.lastFiredAt }
      : {}),
    ...(task.recurring ? { recurring: true } : {}),
    ...(task.manualOnly ? { manualOnly: true } : {}),
    ...(typeof task.transcriptKey === 'string'
      ? { transcriptKey: task.transcriptKey }
      : {}),
    ...(typeof task.originSessionId === 'string'
      ? { originSessionId: task.originSessionId }
      : {}),
    ...(typeof task.agentId === 'string' ? { agentId: task.agentId } : {}),
  }
}

function parseTask(
  task: SessionCronTaskFile['tasks'][number],
): DaemonCronTask | null {
  if (
    !task ||
    typeof task.id !== 'string' ||
    typeof task.cron !== 'string' ||
    typeof task.prompt !== 'string' ||
    typeof task.createdAt !== 'number'
  ) {
    return null
  }

  if (!parseCronExpression(task.cron)) {
    logForDebugging(
      `[SessionScheduledTasks] skipping task ${task.id} with invalid cron '${task.cron}'`,
    )
    return null
  }

  return {
    id: task.id,
    cron: task.cron,
    prompt: task.prompt,
    createdAt: task.createdAt,
    durable: false,
    ...(typeof task.lastFiredAt === 'number'
      ? { lastFiredAt: task.lastFiredAt }
      : {}),
    ...(task.recurring ? { recurring: true } : {}),
    ...(task.manualOnly ? { manualOnly: true } : {}),
    ...(typeof task.transcriptKey === 'string'
      ? { transcriptKey: task.transcriptKey }
      : {}),
    ...(typeof task.originSessionId === 'string'
      ? { originSessionId: task.originSessionId }
      : {}),
    ...(typeof task.agentId === 'string' ? { agentId: task.agentId } : {}),
  }
}

function isRecoverableSessionTask(task: DaemonCronTask, nowMs: number): boolean {
  if (task.manualOnly) {
    return true
  }
  if (task.recurring) {
    return true
  }

  const nextFireAt = nextCronRunMs(task.cron, task.createdAt)
  return nextFireAt !== null && nextFireAt >= nowMs
}

export async function readSessionScheduledTasks(
  projectRoot: string,
  nowMs = Date.now(),
): Promise<ReadSessionScheduledTasksResult> {
  try {
    const raw = await readFile(getSessionScheduledTasksPath(projectRoot), 'utf-8')
    const parsed = safeParseJSON(raw, false) as Partial<SessionCronTaskFile> | null
    if (!parsed || !Array.isArray(parsed.tasks)) {
      return { tasks: [], hadFile: true, pruned: true }
    }

    const tasks: DaemonCronTask[] = []
    let pruned = false
    for (const rawTask of parsed.tasks) {
      const task = parseTask(rawTask)
      if (!task) {
        pruned = true
        continue
      }
      if (!isRecoverableSessionTask(task, nowMs)) {
        logForDebugging(
          `[SessionScheduledTasks] dropping expired one-shot task ${task.id}`,
        )
        pruned = true
        continue
      }
      tasks.push(task)
    }

    return { tasks, hadFile: true, pruned }
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? error.code : null
    if (code === 'ENOENT') {
      return { tasks: [], hadFile: false, pruned: false }
    }
    logError(error)
    return { tasks: [], hadFile: false, pruned: false }
  }
}

export async function writeSessionScheduledTasks(
  projectRoot: string,
  tasks: readonly DaemonCronTask[],
): Promise<void> {
  const path = getSessionScheduledTasksPath(projectRoot)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    jsonStringify({ tasks: tasks.map(serializeTask) }, null, 2) + '\n',
    'utf-8',
  )
}
