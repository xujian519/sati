/**
 * `task_*` builtin tools — public surface for the C5 background task
 * runtime (§6.5.5 step 4-5).
 *
 *   - task_create  → `BackgroundTaskRuntime.start`
 *   - task_list    → `BackgroundTaskRuntime.list`
 *   - task_output  → `BackgroundTaskRuntime.getOutput` (incremental polling)
 *   - task_stop    → `BackgroundTaskRuntime.stop`
 *
 * The runtime is injected once at registry construction (no per-call
 * lookup); tools without a runtime hand back `unsupported_tool`.
 */

import type { BackgroundTaskRuntime } from "../../task/runtime/BackgroundTaskRuntime.js";
import type {
  PolitDeckBackgroundBashTask,
  PolitDeckBackgroundTaskKind,
  PolitDeckBackgroundTaskListFilter,
  PolitDeckBackgroundTaskStatus,
} from "../../task/protocol/types.js";
import { PolitDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PolitDeckToolDefinition,
  PolitDeckToolExecutionOutput,
} from "../protocol/types.js";

export type TaskCreateInput = {
  command: string;
  agentId?: string;
  kind?: PolitDeckBackgroundTaskKind;
};

export type TaskCreateOutput = {
  taskId: string;
  status: PolitDeckBackgroundTaskStatus;
  pid?: number;
};

export type TaskListInput = {
  agentId?: string;
  status?: PolitDeckBackgroundTaskStatus | PolitDeckBackgroundTaskStatus[];
  kind?: PolitDeckBackgroundTaskKind;
};

export type TaskListOutput = {
  tasks: Array<
    Pick<
      PolitDeckBackgroundBashTask,
      | "taskId"
      | "agentId"
      | "kind"
      | "command"
      | "status"
      | "pid"
      | "exitCode"
      | "interrupted"
      | "outputBytes"
    > & { startedAt: string; endedAt?: string }
  >;
};

export type TaskOutputInput = {
  taskId: string;
  offset?: number;
  maxBytes?: number;
};

export type TaskOutputResult = {
  taskId: string;
  content: string;
  nextOffset: number;
  totalBytes: number;
  truncated: boolean;
  status: PolitDeckBackgroundTaskStatus;
  exitCode?: number | null;
};

export type TaskStopInput = {
  taskId: string;
  graceMs?: number;
};

export type TaskStopResult = {
  taskId: string;
  status: PolitDeckBackgroundTaskStatus;
};

function ensureRuntime(runtime: BackgroundTaskRuntime | undefined): BackgroundTaskRuntime {
  if (!runtime) {
    throw new PolitDeckToolRuntimeError(
      "unsupported_tool",
      "task_* tools require a BackgroundTaskRuntime. Configure one via createBuiltinRegistry({ backgroundTasks: { runtime } }).",
    );
  }
  return runtime;
}

export function createTaskCreateTool(
  runtime?: BackgroundTaskRuntime,
): PolitDeckToolDefinition<TaskCreateInput, TaskCreateOutput> {
  return {
    name: "task_create",
    aliases: ["TaskCreate"],
    description:
      "Spawn a shell command as a detached background task. Returns immediately with a taskId; poll task_output / task_stop to manage it.",
    kind: "shell",
    inputSchema: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        agentId: { type: "string" },
        kind: { type: "string", enum: ["bash", "monitor"] },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => true,
    execute: async (input, context): Promise<PolitDeckToolExecutionOutput<TaskCreateOutput>> => {
      const rt = ensureRuntime(runtime);
      const task = await rt.start({
        command: input.command,
        cwd: context.cwd,
        env: context.env,
        agentId: input.agentId,
        kind: input.kind,
      });
      return {
        content: [
          { type: "text", text: `task_create taskId=${task.taskId} status=${task.status}` },
        ],
        data: { taskId: task.taskId, status: task.status, pid: task.pid },
      };
    },
  };
}

export function createTaskListTool(
  runtime?: BackgroundTaskRuntime,
): PolitDeckToolDefinition<TaskListInput, TaskListOutput> {
  return {
    name: "task_list",
    aliases: ["TaskList"],
    description: "List background tasks (optionally filter by agentId / status / kind).",
    kind: "shell",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: { type: "string" },
        status: { type: ["string", "array"] },
        kind: { type: "string", enum: ["bash", "monitor"] },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input): Promise<PolitDeckToolExecutionOutput<TaskListOutput>> => {
      const rt = ensureRuntime(runtime);
      const filter: PolitDeckBackgroundTaskListFilter = {
        agentId: input.agentId,
        status: input.status,
        kind: input.kind,
      };
      const tasks = rt.list(filter).map((t) => ({
        taskId: t.taskId,
        agentId: t.agentId,
        kind: t.kind,
        command: t.command,
        status: t.status,
        pid: t.pid,
        exitCode: t.exitCode ?? undefined,
        interrupted: t.interrupted,
        outputBytes: t.outputBytes,
        startedAt: t.startedAt.toISOString(),
        endedAt: t.endedAt?.toISOString(),
      }));
      return {
        content: [{ type: "json", value: { tasks } }],
        data: { tasks },
      };
    },
  };
}

export function createTaskOutputTool(
  runtime?: BackgroundTaskRuntime,
): PolitDeckToolDefinition<TaskOutputInput, TaskOutputResult> {
  return {
    name: "task_output",
    aliases: ["TaskOutput"],
    description: "Read newly-produced output for a background task (incremental polling).",
    kind: "shell",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      additionalProperties: false,
      properties: {
        taskId: { type: "string" },
        offset: { type: "integer" },
        maxBytes: { type: "integer" },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input): Promise<PolitDeckToolExecutionOutput<TaskOutputResult>> => {
      const rt = ensureRuntime(runtime);
      const task = rt.get(input.taskId);
      if (!task) {
        throw new PolitDeckToolRuntimeError(
          "invalid_tool_input",
          `Unknown taskId: ${input.taskId}`,
        );
      }
      const slice = rt.getOutput(input.taskId, input.offset ?? 0, input.maxBytes);
      const data: TaskOutputResult = {
        taskId: input.taskId,
        content: slice.content,
        nextOffset: slice.nextOffset,
        totalBytes: slice.totalBytes,
        truncated: slice.truncated,
        status: task.status,
        exitCode: task.exitCode,
      };
      return { content: [{ type: "text", text: slice.content }], data };
    },
  };
}

export function createTaskStopTool(
  runtime?: BackgroundTaskRuntime,
): PolitDeckToolDefinition<TaskStopInput, TaskStopResult> {
  return {
    name: "task_stop",
    aliases: ["TaskStop"],
    description: "Stop a background task (SIGTERM → grace → SIGKILL).",
    kind: "shell",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      additionalProperties: false,
      properties: {
        taskId: { type: "string" },
        graceMs: { type: "integer" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => true,
    execute: async (input): Promise<PolitDeckToolExecutionOutput<TaskStopResult>> => {
      const rt = ensureRuntime(runtime);
      const task = rt.get(input.taskId);
      if (!task) {
        throw new PolitDeckToolRuntimeError(
          "invalid_tool_input",
          `Unknown taskId: ${input.taskId}`,
        );
      }
      await rt.stop(input.taskId, { graceMs: input.graceMs });
      const after = rt.get(input.taskId)!;
      return {
        content: [{ type: "text", text: `task_stop taskId=${input.taskId} status=${after.status}` }],
        data: { taskId: input.taskId, status: after.status },
      };
    },
  };
}

export type CreateTaskToolsOptions = {
  runtime: BackgroundTaskRuntime;
};

export function createTaskTools(options: CreateTaskToolsOptions): {
  create: ReturnType<typeof createTaskCreateTool>;
  list: ReturnType<typeof createTaskListTool>;
  output: ReturnType<typeof createTaskOutputTool>;
  stop: ReturnType<typeof createTaskStopTool>;
} {
  return {
    create: createTaskCreateTool(options.runtime),
    list: createTaskListTool(options.runtime),
    output: createTaskOutputTool(options.runtime),
    stop: createTaskStopTool(options.runtime),
  };
}
