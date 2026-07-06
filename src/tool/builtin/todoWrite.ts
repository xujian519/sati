import type {
  PilotDeckTodoItem,
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
} from "../protocol/types.js";

export type TodoWriteInput = {
  markdown?: string;
  todos?: PilotDeckTodoItem[];
  merge?: boolean;
  reason?: string;
};

export type TodoWriteOutput = {
  markdown?: string;
  todos: PilotDeckTodoItem[];
  mode: "read" | "markdown" | "structured";
  merge: boolean;
  reason?: string;
};

const TODO_LINE_PATTERN = /^\s*[-*]\s+\[( |x|X)\]\s+(.*?)\s*$/u;

export function parseTodoMarkdown(markdown: string): PilotDeckTodoItem[] {
  const lines = markdown.split(/\r?\n/u);
  const parsed: Array<{ checked: boolean; content: string }> = [];
  for (const line of lines) {
    const match = TODO_LINE_PATTERN.exec(line);
    if (!match) continue;
    const content = match[2]?.trim();
    if (!content) continue;
    parsed.push({
      checked: match[1].toLowerCase() === "x",
      content,
    });
  }

  let assignedInProgress = false;
  return parsed.map((item, index) => {
    let status: PilotDeckTodoItem["status"];
    if (item.checked) {
      status = "completed";
    } else if (!assignedInProgress) {
      status = "in_progress";
      assignedInProgress = true;
    } else {
      status = "pending";
    }
    return {
      id: `todo-${index + 1}`,
      content: item.content,
      status,
    };
  });
}

export function createTodoWriteTool(): PilotDeckToolDefinition<TodoWriteInput, TodoWriteOutput> {
  return {
    name: "todo_write",
    aliases: ["TodoWrite"],
    description:
      [
        "Read or update the execution todo list for the current session.",
        "Call with no arguments to read the current todo list.",
        "For editable todos, provide `todos` with stable ids and optional `merge=true` to update by id and append new items.",
        "For legacy checklist updates, provide `markdown` using `- [x]` for completed items and `- [ ]` for remaining items.",
        "Use status pending, in_progress, completed, or cancelled. Keep only one item in_progress when possible.",
        "When changing the todo structure mid-task, include `reason` so the change is auditable in the tool result.",
        "This tool only updates a checklist; it does not write files, submit, or replace a final plan.",
        "In plan mode, do not use todo_write to write the plan itself, and do not treat a todo list as the final plan.",
        "You may use todo_write in plan mode only to organize planning work such as exploration, analysis, writing a markdown plan under `.pilotdeck/plans/`, and submitting that plan with `exit_plan_mode`.",
      ].join(" "),
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        markdown: {
          type: "string",
          description: "Legacy markdown checklist content using `- [ ]` and `- [x]` items. Replaces the current list.",
        },
        todos: {
          type: "array",
          description: "Editable todo items. Omit to read current list, or provide with merge=true to update by id.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["content", "status"],
            properties: {
              id: {
                type: "string",
                description: "Stable todo identifier. Required for reliable merge updates.",
              },
              content: {
                type: "string",
                description: "Todo item description.",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "cancelled"],
                description: "Current todo status.",
              },
              priority: {
                type: "string",
                description: "Optional priority label such as high, medium, or low.",
              },
            },
          },
        },
        merge: {
          type: "boolean",
          description: "When todos are provided, true updates existing items by id and appends new items; false replaces the list.",
          default: false,
        },
        reason: {
          type: "string",
          description: "Optional reason for structural todo changes, especially added/cancelled/reordered items.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput<TodoWriteOutput>> => {
      let mode: TodoWriteOutput["mode"] = "read";
      let todos = context.planTodo?.getSnapshot().todos ?? [];
      const merge = Boolean(input.merge);

      if (Array.isArray(input.todos)) {
        mode = "structured";
        todos = context.planTodo?.writeTodos(input.todos, { merge }) ?? input.todos;
      } else if (typeof input.markdown === "string") {
        mode = "markdown";
        todos = parseTodoMarkdown(input.markdown);
        context.planTodo?.recordTodoWrite(input.markdown, todos);
      }

      return {
        content: [{ type: "text", text: mode === "read" ? "Todo list read" : "Todo list updated" }],
        data: {
          ...(typeof input.markdown === "string" ? { markdown: input.markdown } : {}),
          todos,
          mode,
          merge,
          ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        },
        metadata: {
          todoCount: todos.length,
          mode,
        },
      };
    },
  };
}
