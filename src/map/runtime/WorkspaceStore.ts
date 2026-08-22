import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Position, SessionRow, Thread, Workspace, WorkspaceState, WorkspaceSummary } from "../protocol/types.js";

export class InputError extends Error {
  readonly code = "INPUT_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

class ConflictError extends Error {
  readonly code = "CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

const DEFAULT_THREAD_COLOR = "#6366f1";
const LOCK_STALE_MS = 5000;
const MAX_LOCK_ATTEMPTS = 10;
const POSITION_STEP = 220;

function nowIso(): string {
  return new Date().toISOString();
}

function emptyState(): WorkspaceState {
  return {
    version: 4,
    hiddenSessionIds: [],
    workspaces: [],
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code: unknown }).code === code;
}

function validateId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0) {
    throw new InputError("id is required");
  }
  return id;
}

function validateTitle(title: unknown): string {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new InputError("title is required");
  }
  const trimmed = title.trim();
  if (trimmed.length > 200) {
    throw new InputError("title must not exceed 200 characters");
  }
  return trimmed;
}

function validatePosition(position: unknown): Position {
  if (!position || typeof position !== "object" || Array.isArray(position)) {
    throw new InputError("position must be an object with numeric x and y");
  }
  const p = position as Record<string, unknown>;
  if (typeof p.x !== "number" || !Number.isFinite(p.x) || typeof p.y !== "number" || !Number.isFinite(p.y)) {
    throw new InputError("position.x and position.y must be finite numbers");
  }
  return { x: p.x, y: p.y };
}

function summarize(workspace: Workspace): WorkspaceSummary {
  return {
    id: workspace.id,
    kind: workspace.kind,
    cwd: workspace.cwd,
    title: workspace.title,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    threadCount: workspace.threads.length,
  };
}

function summarizeAll(state: WorkspaceState): WorkspaceSummary[] {
  return state.workspaces.map(summarize);
}

function nextPosition(threads: readonly Thread[]): Position {
  if (threads.length === 0) return { x: 0, y: 0 };
  let maxX = 0;
  for (const thread of threads) {
    if (thread.position.x > maxX) maxX = thread.position.x;
  }
  return { x: maxX + POSITION_STEP, y: 0 };
}

function findThreadLocation(
  state: WorkspaceState,
  threadId: string,
): { workspace: Workspace; index: number } | undefined {
  for (const workspace of state.workspaces) {
    const index = workspace.threads.findIndex(thread => thread.id === threadId);
    if (index >= 0) return { workspace, index };
  }
  return undefined;
}

function findWorkspaceById(state: WorkspaceState, workspaceId: string): Workspace | undefined {
  return state.workspaces.find(workspace => workspace.id === workspaceId);
}

function parseState(raw: string): WorkspaceState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new InputError(`invalid workspaces.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InputError("invalid workspaces.json: expected object");
  }

  const state = parsed as Record<string, unknown>;
  if (state.version !== 4) {
    throw new InputError(`unsupported workspaces.json version: ${String(state.version)}`);
  }

  const hidden = Array.isArray(state.hiddenSessionIds)
    ? state.hiddenSessionIds.filter((id): id is string => typeof id === "string")
    : [];
  const workspaces = Array.isArray(state.workspaces) ? (state.workspaces as Workspace[]) : [];

  return {
    version: 4,
    hiddenSessionIds: hidden,
    workspaces,
  };
}

export class WorkspaceStore {
  private readonly dataFile: string;
  private readonly lockFile: string;

  constructor(dataFile: string) {
    this.dataFile = dataFile;
    this.lockFile = `${dataFile}.lock`;
  }

  async list(): Promise<WorkspaceSummary[]> {
    return this.read(state => summarizeAll(state));
  }

  async get(id: string): Promise<Workspace> {
    const workspace = await this.read(state => findWorkspaceById(state, id));
    if (!workspace) {
      throw new NotFoundError(`workspace not found: ${id}`);
    }
    return structuredClone(workspace);
  }

  async create(title: string): Promise<WorkspaceSummary> {
    const trimmed = validateTitle(title);
    return this.mutate(state => {
      const workspace: Workspace = {
        id: randomUUID(),
        kind: "manual",
        cwd: null,
        title: trimmed,
        threads: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.workspaces.push(workspace);
      return structuredClone(summarize(workspace));
    });
  }

  async createThread(
    workspaceId: string,
    options: {
      title: string;
      parentId?: string;
      sessionId?: string;
      sessionTitle?: string;
      position?: Position;
      color?: string;
    },
  ): Promise<Thread> {
    validateId(workspaceId);
    const title = validateTitle(options.title);
    const sessionId = options.sessionId ?? null;
    const parentId = options.parentId ?? null;

    if (parentId !== null) validateId(parentId);

    return this.mutate(state => {
      const workspace = findWorkspaceById(state, workspaceId);
      if (!workspace) {
        throw new NotFoundError(`workspace not found: ${workspaceId}`);
      }

      const threadId = sessionId ?? randomUUID();
      if (findThreadLocation(state, threadId)) {
        throw new InputError(`thread id already exists: ${threadId}`);
      }

      if (parentId !== null && !findThreadLocation(state, parentId)) {
        throw new NotFoundError(`parent thread not found: ${parentId}`);
      }

      const thread: Thread = {
        id: threadId,
        workspaceId: workspace.id,
        title,
        parentId,
        sessionId,
        sessionTitle: options.sessionTitle ?? title,
        color: typeof options.color === "string" && options.color.length > 0 ? options.color : DEFAULT_THREAD_COLOR,
        position: options.position ? validatePosition(options.position) : nextPosition(workspace.threads),
        messages: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      workspace.threads.push(thread);
      workspace.updatedAt = nowIso();
      return structuredClone(thread);
    });
  }

  async branch(
    threadId: string,
    options: {
      title?: string;
      sessionId?: string;
      sessionTitle?: string;
      position?: Position;
      color?: string;
    },
  ): Promise<Thread> {
    validateId(threadId);

    return this.mutate(state => {
      const location = findThreadLocation(state, threadId);
      if (!location) {
        throw new NotFoundError(`thread not found: ${threadId}`);
      }

      const parent = location.workspace.threads[location.index];
      const title = options.title ? validateTitle(options.title) : `Branch of ${parent.title}`;
      const sessionId = options.sessionId ?? null;
      const newId = sessionId ?? randomUUID();

      if (findThreadLocation(state, newId)) {
        throw new InputError(`thread id already exists: ${newId}`);
      }

      const thread: Thread = {
        id: newId,
        workspaceId: location.workspace.id,
        title,
        parentId: threadId,
        sessionId,
        sessionTitle: options.sessionTitle ?? parent.sessionTitle ?? title,
        color: typeof options.color === "string" && options.color.length > 0 ? options.color : parent.color,
        position: options.position ? validatePosition(options.position) : nextPosition(location.workspace.threads),
        messages: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      location.workspace.threads.push(thread);
      location.workspace.updatedAt = nowIso();
      return structuredClone(thread);
    });
  }

  async updateThread(threadId: string, updates: { title?: string; position?: Position }): Promise<Thread> {
    validateId(threadId);

    return this.mutate(state => {
      const location = findThreadLocation(state, threadId);
      if (!location) {
        throw new NotFoundError(`thread not found: ${threadId}`);
      }

      const thread = location.workspace.threads[location.index];
      if (updates.title !== undefined) {
        thread.title = validateTitle(updates.title);
      }
      if (updates.position !== undefined) {
        thread.position = validatePosition(updates.position);
      }
      thread.updatedAt = nowIso();
      location.workspace.updatedAt = nowIso();
      return structuredClone(thread);
    });
  }

  async removeThread(threadId: string): Promise<{ removed: number }> {
    validateId(threadId);

    return this.mutate(state => {
      const location = findThreadLocation(state, threadId);
      if (!location) {
        throw new NotFoundError(`thread not found: ${threadId}`);
      }

      location.workspace.threads.splice(location.index, 1);
      location.workspace.updatedAt = nowIso();
      return { removed: 1 };
    });
  }

  async syncSessions(
    sessions: SessionRow[],
    removedSessionIds?: string[],
  ): Promise<{ summaries: WorkspaceSummary[]; threads: Thread[] }> {
    if (!Array.isArray(sessions)) {
      throw new InputError("sessions must be an array");
    }
    const removed = Array.isArray(removedSessionIds) ? removedSessionIds : [];

    return this.mutate(state => {
      const removedSet = new Set(removed);
      const hiddenSet = new Set(state.hiddenSessionIds);
      const currentSessionIds = new Set<string>();
      const managedCwds = new Set<string | null>();

      for (const session of sessions) {
        if (!session || typeof session !== "object") continue;
        if (session.blank || removedSet.has(session.id) || hiddenSet.has(session.id)) {
          continue;
        }
        currentSessionIds.add(session.id);
        managedCwds.add(session.cwd ?? null);

        let workspace = state.workspaces.find(w => w.kind === "project" && w.cwd === session.cwd);
        if (!workspace) {
          workspace = {
            id: randomUUID(),
            kind: "project",
            cwd: session.cwd,
            title: session.cwd,
            threads: [],
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          state.workspaces.push(workspace);
        }

        const existingIndex = workspace.threads.findIndex(t => t.sessionId === session.id);
        const parentId = session.parentId ?? null;

        if (existingIndex >= 0) {
          const thread = workspace.threads[existingIndex];
          thread.title = session.title;
          thread.sessionTitle = session.title;
          thread.parentId = parentId;
          thread.workspaceId = workspace.id;
          thread.updatedAt = nowIso();
        } else {
          const thread: Thread = {
            id: session.id,
            workspaceId: workspace.id,
            title: session.title,
            parentId,
            sessionId: session.id,
            sessionTitle: session.title,
            color: DEFAULT_THREAD_COLOR,
            position: nextPosition(workspace.threads),
            messages: [],
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          workspace.threads.push(thread);
        }

        workspace.updatedAt = nowIso();
      }

      // Explicit removals apply globally, but the "drop sessions not seen in this
      // sync" prune must be scoped to the workspaces this sync actually manages
      // (i.e. whose cwd was present in the incoming sessions).  Workspaces of
      // other projects and manual workspaces are left untouched so a per-project
      // sync never removes another project's threads.
      for (const workspace of state.workspaces) {
        if (workspace.kind !== "project") continue;
        const isManaged = managedCwds.has(workspace.cwd);
        workspace.threads = workspace.threads.filter(thread => {
          if (thread.sessionId === null) return true;
          if (hiddenSet.has(thread.sessionId)) return true;
          if (removedSet.has(thread.sessionId)) return false;
          if (!isManaged) return true;
          return currentSessionIds.has(thread.sessionId);
        });
      }

      const summaries = summarizeAll(state);
      const threads = state.workspaces.flatMap(w => w.threads);
      return structuredClone({ summaries, threads });
    });
  }

  private async read<T>(fn: (state: WorkspaceState) => T): Promise<T> {
    return this.withLockRetry(async () => {
      const { state } = await this.loadLocked();
      return fn(state);
    });
  }

  private async mutate<T>(fn: (state: WorkspaceState) => T): Promise<T> {
    return this.withLockRetry(async () => {
      const { state, mtime } = await this.loadLocked();
      const result = fn(state);
      await this.saveLocked(state, mtime);
      return result;
    });
  }

  private async loadLocked(): Promise<{ state: WorkspaceState; mtime: number }> {
    await mkdir(dirname(this.dataFile), { recursive: true });

    try {
      const beforeStat = await stat(this.dataFile);
      const raw = await readFile(this.dataFile, "utf8");
      const afterStat = await stat(this.dataFile);

      if (beforeStat.mtimeMs !== afterStat.mtimeMs) {
        throw new ConflictError("workspaces.json was modified during read");
      }

      return { state: parseState(raw), mtime: afterStat.mtimeMs };
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { state: emptyState(), mtime: 0 };
      }
      throw error;
    }
  }

  private async saveLocked(state: WorkspaceState, beforeMtime: number): Promise<void> {
    await mkdir(dirname(this.dataFile), { recursive: true });
    const payload = JSON.stringify(state, null, 2);
    await writeFile(this.dataFile, `${payload}\n`, "utf8");
    const afterStat = await stat(this.dataFile);

    if (afterStat.mtimeMs <= beforeMtime) {
      throw new ConflictError("workspaces.json mtime did not advance after write");
    }
  }

  private async withLockRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_LOCK_ATTEMPTS; attempt += 1) {
      const acquired = await this.acquireLock();
      if (acquired) {
        try {
          return await fn();
        } finally {
          await unlink(this.lockFile).catch(() => undefined);
        }
      }

      if (attempt === MAX_LOCK_ATTEMPTS) {
        throw new ConflictError("unable to acquire workspaces.json lock");
      }

      await new Promise(resolve => {
        setTimeout(resolve, 10 * attempt);
      });
    }

    throw new ConflictError("unable to acquire workspaces.json lock");
  }

  private async acquireLock(): Promise<boolean> {
    await mkdir(dirname(this.lockFile), { recursive: true });
    const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
    try {
      await writeFile(this.lockFile, payload, { flag: "wx" });
      return true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }

    try {
      const lockStat = await stat(this.lockFile);
      if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await unlink(this.lockFile).catch(() => undefined);
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }

    return false;
  }
}
