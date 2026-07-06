import type {
  PilotDeckPlanTodoStateHandle,
  PilotDeckPlanTodoStateSnapshot,
  PilotDeckTodoItem,
} from "../../tool/protocol/types.js";

type SessionPlanTodoState = {
  approvedPlan?: string;
  requiresInitialization: boolean;
  toolCallsSinceLastTodoWrite: number;
  lastMarkdown?: string;
  todos: PilotDeckTodoItem[];
};

export type PlanTodoStateManager = {
  forSession(sessionId: string): PilotDeckPlanTodoStateHandle;
};

const TODO_WRITE_TOOL_NAME = "todo_write";
const VALID_TODO_STATUSES = new Set<PilotDeckTodoItem["status"]>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

function normalizeTodoItem(item: PilotDeckTodoItem, index: number): PilotDeckTodoItem {
  const content = item.content.trim() || "(no description)";
  const status = VALID_TODO_STATUSES.has(item.status) ? item.status : "pending";
  return {
    id: item.id?.trim() || `todo-${index + 1}`,
    content,
    status,
    ...(item.priority?.trim() ? { priority: item.priority.trim() } : {}),
  };
}

function dedupeById(todos: PilotDeckTodoItem[]): PilotDeckTodoItem[] {
  const lastIndex = new Map<string, number>();
  todos.forEach((todo, index) => {
    const id = todo.id?.trim() || `todo-${index + 1}`;
    lastIndex.set(id, index);
  });
  return [...lastIndex.values()].sort((a, b) => a - b).map((index) => todos[index]!);
}

function replaceTodos(todos: PilotDeckTodoItem[]): PilotDeckTodoItem[] {
  return dedupeById(todos).map((todo, index) => normalizeTodoItem(todo, index));
}

function mergeTodos(existingTodos: PilotDeckTodoItem[], updates: PilotDeckTodoItem[]): PilotDeckTodoItem[] {
  const existingById = new Map<string, PilotDeckTodoItem>();
  for (const [index, todo] of existingTodos.entries()) {
    const normalized = normalizeTodoItem(todo, index);
    existingById.set(normalized.id!, normalized);
  }

  const append: PilotDeckTodoItem[] = [];
  for (const update of dedupeById(updates)) {
    const id = update.id?.trim();
    if (id && existingById.has(id)) {
      const current = existingById.get(id)!;
      existingById.set(id, {
        ...current,
        ...(update.content.trim() ? { content: update.content.trim() } : {}),
        ...(VALID_TODO_STATUSES.has(update.status) ? { status: update.status } : {}),
        ...(update.priority?.trim() ? { priority: update.priority.trim() } : {}),
      });
      continue;
    }
    append.push(update);
  }

  const merged: PilotDeckTodoItem[] = [];
  const seen = new Set<string>();
  for (const [index, todo] of existingTodos.entries()) {
    const id = todo.id?.trim() || `todo-${index + 1}`;
    const current = existingById.get(id) ?? normalizeTodoItem(todo, index);
    if (!seen.has(current.id!)) {
      merged.push(current);
      seen.add(current.id!);
    }
  }
  const firstNewIndex = merged.length;
  append.forEach((todo, index) => {
    const normalized = normalizeTodoItem(todo, firstNewIndex + index);
    if (!seen.has(normalized.id!)) {
      merged.push(normalized);
      seen.add(normalized.id!);
    }
  });
  return merged;
}

export function createPlanTodoStateManager(): PlanTodoStateManager {
  const states = new Map<string, SessionPlanTodoState>();

  function ensureState(sessionId: string): SessionPlanTodoState {
    let state = states.get(sessionId);
    if (!state) {
      state = {
        requiresInitialization: false,
        toolCallsSinceLastTodoWrite: 0,
        todos: [],
      };
      states.set(sessionId, state);
    }
    return state;
  }

  function snapshot(state: SessionPlanTodoState): PilotDeckPlanTodoStateSnapshot {
    return {
      approvedPlan: state.approvedPlan,
      requiresInitialization: state.requiresInitialization,
      toolCallsSinceLastTodoWrite: state.toolCallsSinceLastTodoWrite,
      lastMarkdown: state.lastMarkdown,
      todos: state.todos,
    };
  }

  function buildPromptAddendum(state: SessionPlanTodoState): string | undefined {
    if (!state.approvedPlan) return undefined;
    if (state.requiresInitialization) {
      return [
        "You are executing an approved plan.",
        `Before using any non-read-only tool, you MUST call \`${TODO_WRITE_TOOL_NAME}\` with a markdown checklist derived from the approved plan.`,
        "Represent completed items as `- [x]` and remaining items as `- [ ]`.",
      ].join("\n");
    }
    if (state.toolCallsSinceLastTodoWrite >= 10) {
      return [
        `You haven't updated the todo list in a while (${state.toolCallsSinceLastTodoWrite} tool calls since last update).`,
        `Consider calling \`${TODO_WRITE_TOOL_NAME}\` to reflect your current progress.`,
        "This is a gentle reminder — ignore if not applicable.",
      ].join(" ");
    }
    return undefined;
  }

  function blockingMessageFor(
    state: SessionPlanTodoState,
    toolName: string,
    isReadOnly: boolean,
  ): string | undefined {
    if (toolName === TODO_WRITE_TOOL_NAME || isReadOnly) {
      return undefined;
    }
    if (state.requiresInitialization) {
      return [
        "An approved plan is active, but the todo list has not been initialized yet.",
        `Call \`${TODO_WRITE_TOOL_NAME}\` first with a markdown checklist based on the approved plan, then retry this tool.`,
      ].join(" ");
    }
    return undefined;
  }

  return {
    forSession(sessionId: string): PilotDeckPlanTodoStateHandle {
      const state = ensureState(sessionId);
      return {
        getSnapshot: () => snapshot(state),
        markPlanApproved(plan: string) {
          state.approvedPlan = plan.trim() || undefined;
          state.requiresInitialization = Boolean(state.approvedPlan);
          state.toolCallsSinceLastTodoWrite = 0;
          state.lastMarkdown = undefined;
          state.todos = [];
        },
        recordTodoWrite(markdown: string, todos: PilotDeckTodoItem[]) {
          state.lastMarkdown = markdown;
          state.todos = replaceTodos(todos);
          state.requiresInitialization = false;
          state.toolCallsSinceLastTodoWrite = 0;
        },
        writeTodos(todos: PilotDeckTodoItem[], options?: { markdown?: string; merge?: boolean }) {
          state.todos = options?.merge ? mergeTodos(state.todos, todos) : replaceTodos(todos);
          state.lastMarkdown = options?.markdown;
          state.requiresInitialization = false;
          state.toolCallsSinceLastTodoWrite = 0;
          return state.todos;
        },
        markToolProgressChanged(toolName: string) {
          if (!state.approvedPlan || toolName === TODO_WRITE_TOOL_NAME) {
            return;
          }
          if (state.requiresInitialization) {
            return;
          }
          state.toolCallsSinceLastTodoWrite += 1;
        },
        buildPromptAddendum: () => buildPromptAddendum(state),
        blockingMessageFor: (toolName, isReadOnly) =>
          blockingMessageFor(state, toolName, isReadOnly),
      };
    },
  };
}
