import { logWarn } from "../../../../utils/logging";
import { parseStructuredTodos, parseTodoMarkdown } from "./todoParsing";

/**
 * Centralized tool configuration registry
 * Defines display behavior for all tool types
 */

/**
 * 工具载荷的对象视图：字段值形状未知（JSON），读取处逐字段收窄。
 * 本注册表覆盖 17+ 个异构工具，其参数/结果形状各不相同且随工具协议演进，
 * 故不做逐工具静态建模，而是以「对象视图 + 逐字段收窄」消费（见 field/text/
 * optionalText/payloadOf），禁止 any 透传。
 */
export type ToolPayload = Record<string, unknown>;

/** 将未知载荷收窄为对象视图；非对象载荷（字符串/数组/null/undefined）得到空视图。 */
function payloadOf(payload: unknown): ToolPayload {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as ToolPayload) : {};
}

/** 读取对象载荷的字段；非对象载荷视为无该字段。 */
function field(payload: unknown, key: string): unknown {
  return payloadOf(payload)[key];
}

/** 读取字段的文本值；非字符串（含缺失）回退空串。 */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 读取字段的可选文本值；非字符串（含缺失）视为未提供（下游据此不渲染次要行）。 */
function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export interface ToolDisplayConfig {
  input: {
    type: "one-line" | "collapsible" | "hidden";
    // One-line config
    icon?: string;
    label?: string;
    getValue?: (input: unknown) => string;
    getSecondary?: (input: unknown) => string | undefined;
    action?: "copy" | "open-file" | "jump-to-results" | "none";
    style?: string;
    wrapText?: boolean;
    colorScheme?: {
      primary?: string;
      secondary?: string;
      background?: string;
      border?: string;
      icon?: string;
    };
    // Collapsible config
    title?: string | ((input: unknown, helpers?: unknown) => string);
    defaultOpen?: boolean;
    contentType?: "diff" | "markdown" | "file-list" | "todo-list" | "text" | "task" | "question-answer";
    getContentProps?: (input: unknown, helpers?: unknown) => unknown;
    actionButton?: "file-button" | "none";
  };
  result?: {
    hidden?: boolean;
    hideOnSuccess?: boolean;
    type?: "one-line" | "collapsible" | "special" | "card";
    title?: string | ((result: unknown) => string);
    defaultOpen?: boolean;
    // Special result handlers
    contentType?:
      | "markdown"
      | "file-list"
      | "todo-list"
      | "text"
      | "success-message"
      | "task"
      | "question-answer"
      | "plan-card";
    getMessage?: (result: unknown) => string;
    getContentProps?: (result: unknown, helpers?: unknown) => unknown;
  };
}

/**
 * 工具显示配置的宽松视图（合并 input/result 两段的可选字段），供 ToolRenderer
 * 鸭子类型读取渲染所需的字段。字段值仍按需局部收窄；本质是异构配置注册表。
 */
export type ToolDisplaySection = {
  type?: string;
  icon?: string;
  label?: string;
  action?: "copy" | "open-file" | "jump-to-results" | "none";
  style?: string;
  wrapText?: boolean;
  colorScheme?: {
    primary?: string;
    secondary?: string;
    background?: string;
    border?: string;
    icon?: string;
  };
  title?: string | ((input: unknown, helpers?: unknown) => string);
  defaultOpen?: boolean;
  contentType?: string;
  getValue?: (input: unknown) => string;
  getSecondary?: (input: unknown) => string | undefined;
  getMessage?: (result: unknown) => string;
  getContentProps?: (input: unknown, helpers?: unknown) => unknown;
};

type SearchToolResultData = {
  files?: unknown;
  filenames?: unknown;
  count?: unknown;
  numFiles?: unknown;
};

export function getSearchToolResultFiles(result: unknown): unknown[] {
  const toolData = ((result as { toolUseResult?: SearchToolResultData } | undefined)?.toolUseResult ||
    {}) as SearchToolResultData;
  if (Array.isArray(toolData.files)) return toolData.files;
  if (Array.isArray(toolData.filenames)) return toolData.filenames;
  return [];
}

export function getSearchToolResultCount(result: unknown): number {
  const toolData = ((result as { toolUseResult?: SearchToolResultData } | undefined)?.toolUseResult ||
    {}) as SearchToolResultData;
  if (typeof toolData.count === "number") return toolData.count;
  if (typeof toolData.numFiles === "number") return toolData.numFiles;
  return getSearchToolResultFiles(result).length;
}

export function getSearchToolResultFileCount(result: unknown): number {
  const toolData = ((result as { toolUseResult?: SearchToolResultData } | undefined)?.toolUseResult ||
    {}) as SearchToolResultData;
  if (typeof toolData.numFiles === "number") return toolData.numFiles;
  return getSearchToolResultFiles(result).length;
}

export const TOOL_CONFIGS: Record<string, ToolDisplayConfig> = {
  // ============================================================================
  // COMMAND TOOLS
  // ============================================================================

  Bash: {
    input: {
      type: "one-line",
      icon: "terminal",
      getValue: input => text(field(input, "command")),
      getSecondary: input => optionalText(field(input, "description")),
      action: "copy",
      style: "terminal",
      wrapText: true,
      colorScheme: {
        primary: "text-green-400 font-mono",
        secondary: "text-gray-400",
        background: "",
        border: "border-green-500 dark:border-green-400",
        icon: "text-green-500 dark:text-green-400",
      },
    },
    result: {
      type: "collapsible",
      title: data => {
        const content = typeof data === "string" ? data : text(field(data, "content"));
        if (!content) return "Output (empty)";
        const lines = content.split("\n").length;
        return `Output (${lines} line${lines > 1 ? "s" : ""})`;
      },
      defaultOpen: false,
      contentType: "text",
      getContentProps: data => {
        const content = typeof data === "string" ? data : text(field(data, "content"));
        return { content };
      },
    },
  },

  // ============================================================================
  // FILE OPERATION TOOLS
  // ============================================================================

  Read: {
    input: {
      type: "one-line",
      label: "Read",
      getValue: input => text(field(input, "file_path")),
      action: "open-file",
      colorScheme: {
        primary: "text-gray-700 dark:text-gray-300",
        background: "",
        border: "border-gray-300 dark:border-gray-600",
        icon: "text-gray-500 dark:text-gray-400",
      },
    },
    result: {
      hidden: true,
    },
  },

  Edit: {
    input: {
      type: "collapsible",
      title: input => {
        const filePath = text(field(input, "file_path"));
        const filename = filePath.split("/").pop() || filePath || "file";
        return `${filename}`;
      },
      defaultOpen: false,
      contentType: "diff",
      actionButton: "none",
      getContentProps: input => ({
        oldContent: field(input, "old_string"),
        newContent: field(input, "new_string"),
        filePath: field(input, "file_path"),
        badge: "Edit",
        badgeColor: "gray",
      }),
    },
    result: {
      hideOnSuccess: true,
    },
  },

  Write: {
    input: {
      type: "collapsible",
      title: input => {
        const filePath = text(field(input, "file_path"));
        const filename = filePath.split("/").pop() || filePath || "file";
        return `${filename}`;
      },
      defaultOpen: false,
      contentType: "diff",
      actionButton: "none",
      getContentProps: input => ({
        oldContent: "",
        newContent: field(input, "content"),
        filePath: field(input, "file_path"),
        badge: "New",
        badgeColor: "green",
      }),
    },
    result: {
      hideOnSuccess: true,
    },
  },

  ApplyPatch: {
    input: {
      type: "collapsible",
      title: input => {
        const filePath = text(field(input, "file_path"));
        const filename = filePath.split("/").pop() || filePath || "file";
        return `${filename}`;
      },
      defaultOpen: false,
      contentType: "diff",
      actionButton: "none",
      getContentProps: input => ({
        oldContent: field(input, "old_string"),
        newContent: field(input, "new_string"),
        filePath: field(input, "file_path"),
        badge: "Patch",
        badgeColor: "gray",
      }),
    },
    result: {
      hideOnSuccess: true,
    },
  },

  // ============================================================================
  // SEARCH TOOLS
  // ============================================================================

  Grep: {
    input: {
      type: "one-line",
      label: "Grep",
      getValue: input => text(field(input, "pattern")),
      getSecondary: input => {
        const path = text(field(input, "path"));
        return path ? `in ${path}` : undefined;
      },
      action: "jump-to-results",
      colorScheme: {
        primary: "text-gray-700 dark:text-gray-300",
        secondary: "text-gray-500 dark:text-gray-400",
        background: "",
        border: "border-gray-400 dark:border-gray-500",
        icon: "text-gray-500 dark:text-gray-400",
      },
    },
    result: {
      type: "collapsible",
      defaultOpen: false,
      title: result => {
        const count = getSearchToolResultFileCount(result);
        return `Found ${count} ${count === 1 ? "file" : "files"}`;
      },
      contentType: "file-list",
      getContentProps: result => {
        return {
          files: getSearchToolResultFiles(result),
        };
      },
    },
  },

  Glob: {
    input: {
      type: "one-line",
      label: "Glob",
      getValue: input => text(field(input, "pattern")),
      getSecondary: input => {
        const path = text(field(input, "path"));
        return path ? `in ${path}` : undefined;
      },
      action: "jump-to-results",
      colorScheme: {
        primary: "text-gray-700 dark:text-gray-300",
        secondary: "text-gray-500 dark:text-gray-400",
        background: "",
        border: "border-gray-400 dark:border-gray-500",
        icon: "text-gray-500 dark:text-gray-400",
      },
    },
    result: {
      type: "collapsible",
      defaultOpen: false,
      title: result => {
        const count = getSearchToolResultCount(result);
        return `Found ${count} ${count === 1 ? "file" : "files"}`;
      },
      contentType: "file-list",
      getContentProps: result => {
        return {
          files: getSearchToolResultFiles(result),
        };
      },
    },
  },

  // ============================================================================
  // TODO TOOLS
  // ============================================================================

  TodoWrite: {
    input: {
      type: "collapsible",
      title: "Updating todo list",
      defaultOpen: false,
      contentType: "todo-list",
      getContentProps: input => {
        const todos = field(input, "todos");
        return {
          todos:
            Array.isArray(todos) && todos.length > 0
              ? parseStructuredTodos(todos)
              : parseTodoMarkdown(field(input, "markdown")),
        };
      },
    },
    result: {
      type: "collapsible",
      contentType: "success-message",
      getMessage: () => "Todo list updated",
    },
  },

  todo_write: {
    input: {
      type: "collapsible",
      title: "Updating todo list",
      defaultOpen: false,
      contentType: "todo-list",
      getContentProps: input => {
        const todos = field(input, "todos");
        return {
          todos:
            Array.isArray(todos) && todos.length > 0
              ? parseStructuredTodos(todos)
              : parseTodoMarkdown(field(input, "markdown")),
        };
      },
    },
    result: {
      type: "collapsible",
      contentType: "success-message",
      getMessage: () => "Todo list updated",
    },
  },

  TodoRead: {
    input: {
      type: "one-line",
      label: "TodoRead",
      getValue: () => "reading list",
      action: "none",
      colorScheme: {
        primary: "text-gray-500 dark:text-gray-400",
        border: "border-violet-400 dark:border-violet-500",
      },
    },
    result: {
      type: "collapsible",
      contentType: "todo-list",
      getContentProps: result => {
        try {
          const content = String(field(result, "content") || "");
          let todos = null;
          if (content.startsWith("[")) {
            todos = JSON.parse(content);
          }
          return { todos, isResult: true };
        } catch (e) {
          logWarn("Failed to parse todo list content:", e);
          return { todos: [], isResult: true };
        }
      },
    },
  },

  // ============================================================================
  // CRON TOOLS
  // ============================================================================

  CronCreate: {
    input: {
      type: "one-line",
      label: "CronCreate",
      getValue: input => text(field(input, "prompt")) || "schedule job",
      getSecondary: input => {
        const payload = payloadOf(input);
        const cadence = payload.recurring === false ? "one-shot" : "recurring";
        const storage = payload.durable ? "durable" : "session";
        const cron = text(payload.cron);
        return cron ? `${cron} · ${cadence} · ${storage}` : `${cadence} · ${storage}`;
      },
      action: "none",
      colorScheme: {
        primary: "text-gray-700 dark:text-gray-300",
        secondary: "text-gray-500 dark:text-gray-400",
        border: "border-amber-400 dark:border-amber-500",
        icon: "text-amber-500 dark:text-amber-400",
      },
    },
    result: {
      type: "collapsible",
      defaultOpen: false,
      title: result => {
        const toolData = payloadOf(field(result, "toolUseResult"));
        const job = payloadOf(field(toolData, "data") || toolData);
        const jobId = text(job.id);
        const id = jobId ? `Scheduled ${jobId}` : "Scheduled job";
        const humanSchedule = text(job.humanSchedule);
        return humanSchedule ? `${id} · ${humanSchedule}` : id;
      },
      contentType: "text",
      getContentProps: result => ({
        content: String(field(result, "content") || ""),
        format: "plain",
      }),
    },
  },

  CronDelete: {
    input: {
      type: "one-line",
      label: "CronDelete",
      getValue: input => text(field(input, "id")) || "cancel scheduled job",
      action: "none",
      colorScheme: {
        primary: "text-gray-700 dark:text-gray-300",
        border: "border-amber-400 dark:border-amber-500",
        icon: "text-amber-500 dark:text-amber-400",
      },
    },
    result: {
      type: "collapsible",
      defaultOpen: false,
      title: result => {
        const toolData = payloadOf(field(result, "toolUseResult"));
        const job = payloadOf(field(toolData, "data") || toolData);
        const jobId = text(job.id);
        return jobId ? `Cancelled ${jobId}` : "Cancelled scheduled job";
      },
      contentType: "text",
      getContentProps: result => ({
        content: String(field(result, "content") || ""),
        format: "plain",
      }),
    },
  },

  CronList: {
    input: {
      type: "one-line",
      label: "CronList",
      getValue: () => "listing scheduled jobs",
      action: "none",
      colorScheme: {
        primary: "text-gray-700 dark:text-gray-300",
        border: "border-amber-400 dark:border-amber-500",
        icon: "text-amber-500 dark:text-amber-400",
      },
    },
    result: {
      type: "collapsible",
      defaultOpen: false,
      title: result => {
        const toolData = payloadOf(field(result, "toolUseResult"));
        const jobs = field(field(toolData, "data"), "jobs") || field(toolData, "jobs") || [];
        const count = Array.isArray(jobs) ? jobs.length : 0;
        return `${count} scheduled ${count === 1 ? "job" : "jobs"}`;
      },
      contentType: "text",
      getContentProps: result => ({
        content: String(field(result, "content") || ""),
        format: "plain",
      }),
    },
  },

  // ============================================================================
  // TASK TOOLS (TaskCreate, TaskUpdate, TaskList, TaskGet)
  // ============================================================================

  TaskCreate: {
    input: {
      type: "one-line",
      label: "Task",
      getValue: input => text(field(input, "subject")) || "Creating task",
      getSecondary: input => optionalText(field(input, "status")),
      action: "none",
      colorScheme: {
        primary: "text-gray-700 dark:text-gray-300",
        border: "border-violet-400 dark:border-violet-500",
        icon: "text-violet-500 dark:text-violet-400",
      },
    },
    result: {
      hideOnSuccess: true,
    },
  },

  TaskUpdate: {
    input: {
      type: "one-line",
      label: "Task",
      getValue: input => {
        const payload = payloadOf(input);
        const taskId = text(payload.taskId);
        const status = text(payload.status);
        const subject = text(payload.subject);
        const parts: string[] = [];
        if (taskId) parts.push(`#${taskId}`);
        if (status) parts.push(status);
        if (subject) parts.push(`"${subject}"`);
        return parts.join(" → ") || "updating";
      },
      action: "none",
      colorScheme: {
        primary: "text-gray-700 dark:text-gray-300",
        border: "border-violet-400 dark:border-violet-500",
        icon: "text-violet-500 dark:text-violet-400",
      },
    },
    result: {
      hideOnSuccess: true,
    },
  },

  TaskList: {
    input: {
      type: "one-line",
      label: "Tasks",
      getValue: () => "listing tasks",
      action: "none",
      colorScheme: {
        primary: "text-gray-500 dark:text-gray-400",
        border: "border-violet-400 dark:border-violet-500",
        icon: "text-violet-500 dark:text-violet-400",
      },
    },
    result: {
      type: "collapsible",
      defaultOpen: true,
      title: "Task list",
      contentType: "task",
      getContentProps: result => ({
        content: String(field(result, "content") || ""),
      }),
    },
  },

  TaskGet: {
    input: {
      type: "one-line",
      label: "Task",
      getValue: input => {
        const taskId = text(field(input, "taskId"));
        return taskId ? `#${taskId}` : "fetching";
      },
      action: "none",
      colorScheme: {
        primary: "text-gray-700 dark:text-gray-300",
        border: "border-violet-400 dark:border-violet-500",
        icon: "text-violet-500 dark:text-violet-400",
      },
    },
    result: {
      type: "collapsible",
      defaultOpen: true,
      title: "Task details",
      contentType: "task",
      getContentProps: result => ({
        content: String(field(result, "content") || ""),
      }),
    },
  },

  // ============================================================================
  // SUBAGENT TASK TOOL
  // ============================================================================

  Task: {
    input: {
      type: "collapsible",
      title: input => {
        const subagentType = text(field(input, "subagent_type")) || "Agent";
        const description = text(field(input, "description")) || "Running task";
        return `Subagent / ${subagentType}: ${description}`;
      },
      defaultOpen: false,
      contentType: "markdown",
      getContentProps: input => {
        const payload = payloadOf(input);
        const prompt = text(payload.prompt);
        const model = text(payload.model);
        const resume = text(payload.resume);

        // If only prompt exists (and required fields), show just the prompt
        // Otherwise show all available fields
        const hasOnlyPrompt = prompt && !model && !resume;

        if (hasOnlyPrompt) {
          return {
            content: prompt || "",
          };
        }

        // Format multiple fields
        const parts: string[] = [];

        if (model) {
          parts.push(`**Model:** ${model}`);
        }

        if (prompt) {
          parts.push(`**Prompt:**\n${prompt}`);
        }

        if (resume) {
          parts.push(`**Resuming from:** ${resume}`);
        }

        return {
          content: parts.join("\n\n"),
        };
      },
      colorScheme: {
        border: "border-purple-500 dark:border-purple-400",
        icon: "text-purple-500 dark:text-purple-400",
      },
    },
    result: {
      type: "collapsible",
      title: "Subagent result",
      defaultOpen: false,
      contentType: "markdown",
      getContentProps: result => {
        // Handle agent results which may have complex structure
        const rawContent = field(result, "content");
        if (rawContent) {
          let content: unknown = rawContent;
          // If content is a JSON string, try to parse it (agent results may arrive serialized)
          if (typeof content === "string") {
            try {
              const parsed = JSON.parse(content);
              if (Array.isArray(parsed)) {
                content = parsed;
              }
            } catch {
              // Not JSON — use as-is
              return { content };
            }
          }
          // If content is an array (typical for agent responses with multiple text blocks)
          if (Array.isArray(content)) {
            const textContent = content
              .filter(item => field(item, "type") === "text")
              .map(item => text(field(item, "text")))
              .join("\n\n");
            return { content: textContent || "No response text" };
          }
          return { content: String(content) };
        }
        // Fallback to string representation
        return { content: String(result || "No response") };
      },
    },
  },

  // ============================================================================
  // INTERACTIVE TOOLS
  // ============================================================================

  AskUserQuestion: {
    input: {
      type: "collapsible",
      title: (input, helpers) => {
        const rawQuestions = field(input, "questions");
        const questions = Array.isArray(rawQuestions) ? rawQuestions : [];
        const count = questions.length;
        const resultAnswers = field(field(field(helpers, "toolResult"), "toolUseResult"), "answers");
        const answers = field(input, "answers") || resultAnswers;
        const hasAnswers =
          answers && typeof answers === "object" && !Array.isArray(answers) && Object.keys(answers).length > 0;
        if (count === 1) {
          const header = text(field(questions[0], "header")) || "Question";
          return hasAnswers ? `${header} — answered` : header;
        }
        if (count === 0 && rawQuestions) {
          return "Question payload";
        }
        return hasAnswers ? `${count} questions — answered` : `${count} questions`;
      },
      defaultOpen: true,
      contentType: "question-answer",
      getContentProps: (input, helpers) => {
        const resultAnswers = field(field(field(helpers, "toolResult"), "toolUseResult"), "answers");
        return {
          questions: field(input, "questions"),
          answers: field(input, "answers") || resultAnswers || {},
        };
      },
    },
    result: {
      hideOnSuccess: true,
    },
  },

  // ============================================================================
  // PLAN TOOLS
  // ============================================================================

  exit_plan_mode: {
    input: {
      type: "hidden",
    },
    result: {
      type: "card",
      contentType: "plan-card",
      getContentProps: result => ({
        planTitle: text(field(result, "planTitle")) || "Implementation Plan",
        planSummary: text(field(result, "planSummary")),
        planFilePath: text(field(result, "planFilePath")),
      }),
    },
  },

  ExitPlanMode: {
    input: {
      type: "hidden",
    },
    result: {
      type: "card",
      contentType: "plan-card",
      getContentProps: result => ({
        planTitle: text(field(result, "planTitle")) || "Implementation Plan",
        planSummary: text(field(result, "planSummary")),
        planFilePath: text(field(result, "planFilePath")),
      }),
    },
  },

  // ============================================================================
  // DEFAULT FALLBACK
  // ============================================================================

  Default: {
    input: {
      type: "collapsible",
      title: "Parameters",
      defaultOpen: false,
      contentType: "text",
      getContentProps: input => ({
        content: typeof input === "string" ? input : JSON.stringify(input, null, 2),
        format: "code",
      }),
    },
    result: {
      type: "collapsible",
      contentType: "text",
      getContentProps: result => ({
        content: String(field(result, "content") || ""),
        format: "plain",
      }),
    },
  },
};

const TOOL_NAME_ALIASES: Record<string, string> = {
  agent: "Task",
  ask_user_question: "AskUserQuestion",
  bash: "Bash",
  edit_file: "Edit",
  glob: "Glob",
  grep: "Grep",
  read_file: "Read",
  write_file: "Write",
};

export function getCanonicalToolName(toolName: string): string {
  return TOOL_NAME_ALIASES[toolName] || toolName;
}

/**
 * Get configuration for a tool, with fallback to default
 */
export function getToolConfig(toolName: string): ToolDisplayConfig {
  const canonicalToolName = getCanonicalToolName(toolName);
  return TOOL_CONFIGS[canonicalToolName] || TOOL_CONFIGS.Default;
}

/**
 * Check if a tool result should be hidden
 */
export function shouldHideToolResult(toolName: string, toolResult: unknown): boolean {
  const config = getToolConfig(toolName);

  if (!config.result) return false;

  // Hide successful noise (for example read_file content already appears in
  // the model context), but never hide failures: users need the exact tool
  // error and recovery hint to understand why the turn got stuck.
  if (config.result.hidden && !field(toolResult, "isError")) return true;

  // Hide on success only
  if (config.result.hideOnSuccess && toolResult && !field(toolResult, "isError")) {
    return true;
  }

  return false;
}
