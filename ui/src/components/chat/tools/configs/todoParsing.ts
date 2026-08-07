/**
 * UI-side todo parsing for tool config panels (todo_write / TodoWrite input
 * rendering). Extracted from toolConfigs.ts so the parser is independently
 * testable and toolConfigs stays a thin registry.
 */

export type ParsedTodoItem = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
};

/**
 * Legacy checklist line format: `- [ ]` / `- [x]` / `- [X]` with optional
 * leading whitespace and either `-` or `*` bullet. This is the canonical
 * markdown checklist contract shared with the backend tool:
 *   src/tool/builtin/todoWrite.ts (parseTodoMarkdown)
 * The two implementations MUST stay in sync — change the regex or the
 * parse/status-assignment behavior here AND there, and keep the shared
 * spec cases in todoParsing.spec.ts and tests/tool/builtin/todoWrite.spec.ts
 * aligned (same inputs → same content/status sequences).
 */
const TODO_LINE_PATTERN = /^\s*[-*]\s+\[( |x|X)\]\s+(.*?)\s*$/u;

/** UI 支持渲染的 todo 状态；其余输入状态（如 cancelled）归一为 pending。 */
function isTodoStatus(value: string): value is ParsedTodoItem["status"] {
  return value === "pending" || value === "in_progress" || value === "completed";
}

/** 统一兜底规范化：id 生成、content 空兜底、status 校验归一。 */
function normalizeTodoItem(raw: Record<string, unknown>, index: number): ParsedTodoItem {
  const status = String(raw.status ?? "pending");
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `todo-${index + 1}`,
    content: typeof raw.content === "string" ? raw.content.trim() || "(no description)" : "(no description)",
    status: isTodoStatus(status) ? status : "pending",
    ...(typeof raw.priority === "string" && raw.priority.trim() ? { priority: raw.priority.trim() } : {}),
  };
}

export function parseTodoMarkdown(markdown: unknown): ParsedTodoItem[] {
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    return [];
  }

  const rawItems: Array<Record<string, unknown>> = [];
  let assignedInProgress = false;
  for (const line of markdown.split(/\r?\n/u)) {
    const match = TODO_LINE_PATTERN.exec(line);
    if (!match) continue;
    const content = match[2]?.trim();
    if (!content) continue;
    const checked = match[1].toLowerCase() === "x";
    let status: ParsedTodoItem["status"];
    if (checked) {
      status = "completed";
    } else if (!assignedInProgress) {
      status = "in_progress";
      assignedInProgress = true;
    } else {
      status = "pending";
    }
    rawItems.push({ content, status });
  }
  return rawItems.map((raw, index) => normalizeTodoItem(raw, index));
}

export function parseStructuredTodos(todos: unknown): ParsedTodoItem[] {
  if (!Array.isArray(todos)) {
    return [];
  }

  return todos
    .filter((todo): todo is Record<string, unknown> => typeof todo === "object" && todo !== null)
    .map((todo, index) => normalizeTodoItem(todo, index));
}
