import { resolve } from 'path'
import type { DaemonCronTask } from './types.js'
import {
  readSessionScheduledTasks,
  writeSessionScheduledTasks,
} from './sessionTaskStoreFile.js'

export class DaemonSessionTaskStore {
  private readonly tasksByProject = new Map<string, Map<string, DaemonCronTask>>()
  private readonly knownProjects = new Set<string>()

  private normalizeProjectRoot(projectRoot: string): string {
    return resolve(projectRoot)
  }

  private peekProjectTasks(projectRoot: string): Map<string, DaemonCronTask> | null {
    return this.tasksByProject.get(this.normalizeProjectRoot(projectRoot)) ?? null
  }

  private getProjectTasks(projectRoot: string): Map<string, DaemonCronTask> {
    const normalized = this.normalizeProjectRoot(projectRoot)
    let tasks = this.tasksByProject.get(normalized)
    if (!tasks) {
      tasks = new Map()
      this.tasksByProject.set(normalized, tasks)
    }
    return tasks
  }

  private replaceProjectTasks(
    projectRoot: string,
    tasks: readonly DaemonCronTask[],
  ): void {
    const normalized = this.normalizeProjectRoot(projectRoot)
    this.knownProjects.add(normalized)
    if (tasks.length === 0) {
      this.tasksByProject.delete(normalized)
      return
    }

    this.tasksByProject.set(
      normalized,
      new Map(tasks.map(task => [task.id, { ...task, durable: false }])),
    )
  }

  async hydrateProject(projectRoot: string, nowMs = Date.now()): Promise<void> {
    const { tasks, hadFile, pruned } = await readSessionScheduledTasks(
      projectRoot,
      nowMs,
    )
    if (hadFile || tasks.length > 0) {
      this.replaceProjectTasks(projectRoot, tasks)
    } else {
      this.tasksByProject.delete(this.normalizeProjectRoot(projectRoot))
    }
    if (hadFile && pruned) {
      await this.persistProject(projectRoot)
    }
  }

  async persistProject(projectRoot: string): Promise<void> {
    const normalized = this.normalizeProjectRoot(projectRoot)
    const tasks = this.listProjectTasks(projectRoot)
    if (tasks.length === 0 && !this.knownProjects.has(normalized)) {
      return
    }
    this.knownProjects.add(normalized)
    await writeSessionScheduledTasks(projectRoot, tasks)
  }

  async persistProjects(projectRoots: Iterable<string>): Promise<void> {
    for (const projectRoot of projectRoots) {
      await this.persistProject(projectRoot)
    }
  }

  addTask(projectRoot: string, task: DaemonCronTask): DaemonCronTask {
    this.knownProjects.add(this.normalizeProjectRoot(projectRoot))
    const tasks = this.getProjectTasks(projectRoot)
    tasks.set(task.id, { ...task, durable: false })
    return tasks.get(task.id)!
  }

  listProjectTasks(projectRoot: string): DaemonCronTask[] {
    return [...(this.peekProjectTasks(projectRoot)?.values() ?? [])]
  }

  listVisibleTasks(
    projectRoot: string,
    originSessionId?: string,
  ): DaemonCronTask[] {
    const tasks = this.listProjectTasks(projectRoot)
    if (!originSessionId) {
      return tasks
    }
    return tasks.filter(task => task.originSessionId === originSessionId)
  }

  getTask(projectRoot: string, taskId: string): DaemonCronTask | null {
    return this.getProjectTasks(projectRoot).get(taskId) ?? null
  }

  updateTask(
    projectRoot: string,
    taskId: string,
    updater: (task: DaemonCronTask) => DaemonCronTask,
  ): DaemonCronTask | null {
    const tasks = this.getProjectTasks(projectRoot)
    const existing = tasks.get(taskId)
    if (!existing) return null
    const updated = { ...updater(existing), durable: false as const }
    tasks.set(taskId, updated)
    return updated
  }

  deleteTask(
    projectRoot: string,
    taskId: string,
    originSessionId?: string,
  ): boolean {
    const normalized = this.normalizeProjectRoot(projectRoot)
    const tasks = this.tasksByProject.get(normalized)
    if (!tasks) return false
    const task = tasks.get(taskId)
    if (!task) return false
    if (originSessionId && task.originSessionId !== originSessionId) {
      return false
    }
    const deleted = tasks.delete(taskId)
    if (tasks.size === 0) {
      this.tasksByProject.delete(normalized)
    }
    return deleted
  }

  markTaskFired(projectRoot: string, taskId: string, firedAt: number): boolean {
    const tasks = this.peekProjectTasks(projectRoot)
    if (!tasks) return false
    const existing = tasks.get(taskId)
    if (!existing || !existing.recurring) {
      return false
    }
    tasks.set(taskId, {
      ...existing,
      lastFiredAt: firedAt,
      durable: false,
    })
    return true
  }

  countForProject(projectRoot: string): number {
    return this.peekProjectTasks(projectRoot)?.size ?? 0
  }
}
