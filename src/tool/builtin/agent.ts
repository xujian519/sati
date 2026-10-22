import { randomUUID } from "node:crypto";
import { DEFAULT_MODEL_ID, type CanonicalModelRequest, type CanonicalUsage } from "../../model/index.js";
import type { PermissionResult } from "../../permission/index.js";
import { SUBAGENT_DEFINITIONS } from "../../agent/sub/builtinSubagentTypes.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type {
  SatiSubagentForkApi,
  SatiSubagentStopReason,
  SatiToolDefinition,
  SatiToolExecutionOutput,
  SatiToolModelClient,
  SatiToolRuntimeContext,
} from "../protocol/types.js";

/**
 * `agent` builtin tool — dispatches a subtask to a subagent.
 *
 * **Two execution modes**:
 *
 *   1. Full fork (C2 §6.2)  — when `context.subagent` is wired (i.e. the
 *      caller is the AgentLoop), we run a real subagent with its own
 *      `AgentLoop`, scoped tool registry, and 5-field structured report.
 *
 *   2. Single-shot legacy  — when `context.subagent` is absent (stand-alone
 *      tool runtime / unit tests), we fall back to one synchronous model
 *      call against the simple `BUILTIN_SUBAGENTS` presets so existing tests
 *      stay green.
 *
 * Mirrors the legacy upstream agent tool input schema (description / prompt /
 * subagent_type) and the 5-field
 * `Scope/Result/Key files/Files changed/Issues` output contract.
 */

export type AgentSubagentType = "general-purpose" | "plan" | "explore" | "verify";

export type AgentSubagentDefinition = {
  type: AgentSubagentType;
  description: string;
  systemPrompt: string;
};

/** Legacy P0 single-shot presets. Used only in the fallback path. */
export const BUILTIN_SUBAGENTS: Record<string, AgentSubagentDefinition> = {
  "general-purpose": {
    type: "general-purpose",
    description:
      "General-purpose subagent for delegating bounded research / synthesis tasks. Returns a single text answer.",
    systemPrompt:
      "You are a general-purpose subagent inside Sati. Read the user's instructions, reason carefully, and produce a single concise text answer. Do not ask follow-up questions; do your best with the information given.",
  },
  plan: {
    type: "plan",
    description:
      "Planning subagent. Given a task description, produce an actionable step-by-step plan without executing it.",
    systemPrompt:
      "You are a planning subagent inside Sati. Given a task, return a numbered plan of concrete steps a developer or operator could follow. Be specific. Do not perform the steps yourself; return the plan only.",
  },
  verify: {
    type: "verify",
    description:
      "Verification subagent. Given a claim or proposed change, return a critique with specific concerns and recommended checks.",
    systemPrompt:
      "You are a verification subagent inside Sati. Given a proposal, change, or claim, return a structured critique with: (1) specific concerns, (2) recommended checks, (3) overall verdict. Be rigorous; flag risks even if minor.",
  },
  explore: {
    type: "explore",
    description:
      "Exploration subagent. Given a topic or question, return an overview of approaches, trade-offs, and pointers.",
    systemPrompt:
      "You are an exploration subagent inside Sati. Given a topic, return a structured overview: (a) common approaches, (b) trade-offs between them, (c) recommended next steps for someone unfamiliar with the area.",
  },
};

export type AgentToolInput = {
  description: string;
  prompt: string;
  subagent_type?: string;
  /** @deprecated camelCase alias retained for backwards compatibility. */
  subagentType?: string;
  /** 子代理内部最大轮数（预算控制）。 */
  max_turns?: number;
  /** 子代理累计工具调用上限；超限批次不执行并按部分结果返回。 */
  max_tool_calls?: number;
  /** 本次子代理的墙钟超时（毫秒）；未指定时用会话配置/默认 1h。 */
  timeout_ms?: number;
};

export type AgentToolOutput = {
  subagentType: string;
  description: string;
  text: string;
  usage?: CanonicalUsage;
  turns?: number;
  durationMs?: number;
  parsed?: Record<string, string>;
  /** 缺省视为 completed（兼容旧输出面）。 */
  stopReason?: SatiSubagentStopReason;
  /** True when the report was cut short by a budget/timeout/abort. */
  partial?: boolean;
  toolCalls?: number;
};

export type CreateAgentToolOptions = {
  /**
   * Override the model client for the *fallback* single-shot path. The full
   * fork path uses `context.subagent.fork(...)` and ignores this option.
   */
  model?: SatiToolModelClient;
  /** Override which fallback subagent presets are available. */
  subagents?: Record<string, AgentSubagentDefinition>;
  provider?: string;
  model_?: string;
  maxOutputTokens?: number;
  temperature?: number;
};

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;
const DEFAULT_PROVIDER_FALLBACK = "sati";
// 模型 id 缺省值与 web_fetch / patent_workflow_run 共用（见 src/model/defaults.ts）
const DEFAULT_MODEL_FALLBACK = DEFAULT_MODEL_ID;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 60 * 60_000;
const PUBLIC_SUBAGENT_TYPES = ["general-purpose", "explore", "plan"] as const;

export function createAgentTool(
  options: CreateAgentToolOptions = {},
): SatiToolDefinition<AgentToolInput, AgentToolOutput> {
  const fallbackPresets = options.subagents ?? BUILTIN_SUBAGENTS;
  const description = buildAgentToolDescription();

  return {
    name: "agent",
    outputSchema: {
      type: "object",
      required: ["subagentType", "description", "text"],
      properties: {
        subagentType: { type: "string" },
        description: { type: "string" },
        text: { type: "string" },
        usage: { type: "object" },
      },
    },
    aliases: ["Agent", "Task"],
    description,
    kind: "agent",
    inputSchema: {
      type: "object",
      required: ["description", "prompt"],
      additionalProperties: false,
      properties: {
        description: {
          type: "string",
          description: "Short 3-5 word task summary used to label the subagent run.",
        },
        prompt: {
          type: "string",
          description:
            "Detailed directive for the subagent. Include the goal, relevant context, constraints, and desired output; do not assume the subagent already knows why the task matters.",
        },
        subagent_type: {
          type: "string",
          description:
            "Optional subagent preset. Public built-ins: 'general-purpose' (full tool access), 'explore' (read-only investigation with read_file/grep/glob/bash), or 'plan' (read-only planning with read_file/grep/glob). Some runtimes may also expose additional presets such as 'verify'. Defaults to 'general-purpose' when omitted. Legacy 'general_purpose' is still accepted for compatibility.",
        },
        subagentType: {
          type: "string",
          description: "Deprecated legacy alias for subagent_type. Prefer subagent_type.",
        },
        max_turns: {
          type: "integer",
          minimum: 1,
          description:
            "Optional cap on the subagent's internal turns. The subagent stops early with a partial report when the cap is reached. Use a small budget (e.g. 8-16) for review/critique tasks.",
        },
        max_tool_calls: {
          type: "integer",
          minimum: 1,
          description:
            "Optional cap on the subagent's cumulative tool calls (file reads, searches, bash, etc.). When the next batch would exceed the cap it is not executed and the subagent returns a partial report. Prefer an explicit budget for review tasks to avoid unbounded re-searching.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          description:
            "Optional wall-clock timeout in milliseconds for this subagent run. Defaults to the session's agent.subagents.timeoutMs (1 hour when unset). On timeout the subagent returns a partial report instead of being discarded.",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "allow",
      reason: {
        type: "tool",
        toolName: "agent",
        message: "Subagent invocation is allowed without prompting.",
      },
    }),
    execute: async (input, context) => {
      const explicit = normalizeRequestedSubagentType(input.subagent_type ?? input.subagentType);
      const directive = input.prompt;
      const maxTurns = readPositiveInteger(input.max_turns, "max_turns");
      const maxToolCalls = readPositiveInteger(input.max_tool_calls, "max_tool_calls");
      const requestedTimeoutMs = readPositiveInteger(input.timeout_ms, "timeout_ms");

      // Full fork path (C2): preferred when AgentLoop wired the fork API.
      if (context.subagent) {
        let requestedType = explicit ?? "general-purpose";
        if (
          (context.permissionContext?.mode === "plan" || context.runMode === "ask") &&
          requestedType === "general-purpose"
        ) {
          requestedType = "explore";
        }
        return runFullFork({
          input,
          context,
          requestedType,
          directive,
          maxTurns,
          maxToolCalls,
          requestedTimeoutMs,
          fork: context.subagent,
        });
      }
      let requestedType = explicit ?? "general-purpose";
      if (
        (context.permissionContext?.mode === "plan" || context.runMode === "ask") &&
        requestedType === "general-purpose"
      ) {
        requestedType = "explore";
      }

      return runFallback({
        input,
        context,
        requestedType,
        directive,
        presets: fallbackPresets,
        model: options.model,
        provider: options.provider ?? DEFAULT_PROVIDER_FALLBACK,
        modelId: options.model_ ?? DEFAULT_MODEL_FALLBACK,
        maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: options.temperature ?? 0,
      });
    },
  };
}

function buildAgentToolDescription(): string {
  const publicTypes = PUBLIC_SUBAGENT_TYPES.map(id => {
    const definition = SUBAGENT_DEFINITIONS[id];
    const tools =
      definition.allowedTools[0] === "*"
        ? "all parent tools except nested agent launch"
        : definition.allowedTools.join(", ");
    return `- ${id}: ${definition.description} Tools: ${tools}.`;
  }).join("\n");

  return [
    "Launch a new subagent to handle a focused multi-step task.",
    "",
    "Use this tool when a bounded piece of work would benefit from an autonomous helper instead of keeping every intermediate step in the parent agent's context. Multiple independent agent calls in one assistant message may run concurrently; batch sibling investigations when their scopes do not depend on each other.",
    "",
    "For review / critique / adversarial-check tasks, dispatch a registered read-only reviewer through `subagent_type` (e.g. `patent-reviewer`, `adversarial-reviewer`) instead of `general-purpose`, and do not merely name the role inside `prompt` — the subagent type determines its tools and write permissions.",
    "",
    "Bound the run with `max_turns` / `max_tool_calls` (and optionally `timeout_ms`). If the budget or timeout is hit, the subagent returns a partial report explicitly marked `partial`; treat it as provisional rather than a complete verdict.",
    "",
    "Available built-in subagent types:",
    publicTypes,
    "",
    "The subagent returns one structured report with these sections: `Scope`, `Result`, `Key files`, `Files changed`, and `Issues`.",
  ].join("\n");
}

const ASK_MODE_SUBAGENT_TYPES = ["explore", "plan", "verify"] as const;

export function buildAskModeAgentToolSchema(): {
  description: string;
  inputSchema: Record<string, unknown>;
} {
  const typeLines = ASK_MODE_SUBAGENT_TYPES.map(id => {
    const definition = SUBAGENT_DEFINITIONS[id];
    return `- ${id}: ${definition.description} Tools: ${definition.allowedTools.join(", ")}.`;
  }).join("\n");

  const description = [
    "Launch a read-only subagent for investigation, planning, or verification.",
    "",
    "In ask mode, subagents inherit ask mode and the same permission setting. Only read-only subagent types are available; 'general-purpose' is treated as 'explore'.",
    "",
    "Provide:",
    "- `description`: a short 3-5 word label for the task.",
    "- `prompt`: the full directive for the subagent. Include goal, context, constraints, and what good output looks like. The subagent can only read and search; it cannot modify files.",
    "- `subagent_type` (optional): 'explore', 'plan', or 'verify'. Defaults to 'explore'.",
    "- `max_turns` / `max_tool_calls` / `timeout_ms` (optional): explicit budgets. A budget/timeout stop returns a partial report marked `partial`.",
    "",
    "Available subagent types:",
    typeLines,
    "",
    "The subagent returns one structured report with these sections: `Scope`, `Result`, `Key files`, `Files changed`, and `Issues`.",
  ].join("\n");

  const inputSchema: Record<string, unknown> = {
    type: "object",
    required: ["description", "prompt"],
    additionalProperties: false,
    properties: {
      description: {
        type: "string",
        description: "Short 3-5 word task summary used to label the subagent run.",
      },
      prompt: {
        type: "string",
        description:
          "Detailed directive for the subagent. Include the goal, relevant context, constraints, and desired output. The subagent can only read and search; it cannot modify files.",
      },
      subagent_type: {
        type: "string",
        description:
          "Subagent preset. In ask mode only 'explore', 'plan', and 'verify' are available. Defaults to 'explore'.",
      },
      subagentType: {
        type: "string",
        description: "Deprecated legacy alias for subagent_type. Prefer subagent_type.",
      },
      max_turns: {
        type: "integer",
        minimum: 1,
        description: "Optional cap on the subagent's internal turns; partial report when reached.",
      },
      max_tool_calls: {
        type: "integer",
        minimum: 1,
        description: "Optional cap on cumulative tool calls; the over-budget batch is not executed.",
      },
      timeout_ms: {
        type: "integer",
        minimum: 1,
        description: "Optional wall-clock timeout in milliseconds; partial report on timeout.",
      },
    },
  };

  return { description, inputSchema };
}

/**
 * 手册名 → 真实注册角色别名（cap01-orchestrator.md §3.5 的下划线命名 →
 * skills 目录下 SKILL.md type: role 注册的 kebab 命名）。与手册同步维护；
 * check-patent-sop-references.mjs 校验两侧一致性。
 */
const SUBAGENT_TYPE_ALIASES: Readonly<Record<string, string>> = {
  technical_analyzer: "patent-analyzer",
  novelty_checker: "patent-novelty-checker",
  creativity_checker: "patent-creativity-checker",
  infringement_checker: "patent-infringement-checker",
  invalidity_checker: "patent-invalidity-checker",
  retriever: "patent-retriever",
  quality_checker: "patent-quality-checker",
  reviewer: "patent-reviewer",
};

function normalizeRequestedSubagentType(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "general-purpose" || normalized === "general_purpose" || normalized === "general purpose") {
    return "general-purpose";
  }
  if (normalized === "explore" || normalized === "explorer") {
    return "explore";
  }
  if (normalized === "plan" || normalized === "verify") {
    return normalized;
  }
  // 手册旧名（下划线）→ 真实注册角色（kebab）；命中映射即转换，未命中保持原样。
  const alias = SUBAGENT_TYPE_ALIASES[normalized];
  return alias ?? trimmed;
}

type SubagentSummary = ReturnType<SatiSubagentForkApi["listDefinitions"]>[number];

/**
 * 复核角色的权限由 `subagent_type` 决定，prompt 里写角色名只会得到通用代理
 * 的写权限与工具面。命中角色委派语句（而非单纯提及角色名）时拒绝，避免
 * “名为复核、实为可写通用代理”的静默降级。
 */
function findImpersonatedReadOnlyRole(directive: string, definitions: SubagentSummary[]): string | undefined {
  for (const definition of definitions) {
    if (definition.readOnly !== true) continue;
    const escaped = definition.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`(?:你是|您作为|您将担任|扮演|担任)\\s*[\`"'“”]?${escaped}(?![\\w-])`, "iu"),
      new RegExp(`以\\s*[\`"'“”]?${escaped}[\`"'“”]?\\s*(?:的)?(?:身份|角色)`, "iu"),
      new RegExp(`\\byou\\s+are\\s+(?:an?\\s+|the\\s+)?[\`"']?${escaped}\\b`, "iu"),
      new RegExp(
        `\\b(?:act|acting|serve|serving|work|working)\\s+as\\s+(?:an?\\s+|the\\s+)?[\`"']?${escaped}\\b`,
        "iu",
      ),
      new RegExp(`\\brole\\s*[:：]\\s*[\`"']?${escaped}\\b`, "iu"),
    ];
    if (patterns.some(pattern => pattern.test(directive))) {
      return definition.id;
    }
  }
  return undefined;
}

async function runFullFork(args: {
  input: AgentToolInput;
  context: SatiToolRuntimeContext;
  requestedType: string;
  directive: string;
  maxTurns?: number;
  maxToolCalls?: number;
  requestedTimeoutMs?: number;
  fork: SatiSubagentForkApi;
}): Promise<SatiToolExecutionOutput<AgentToolOutput>> {
  const { input, context, requestedType, directive, maxTurns, maxToolCalls, requestedTimeoutMs, fork } = args;

  if (!fork.isAllowedDefinition(requestedType)) {
    const allowed = fork
      .listDefinitions()
      .map(d => d.id)
      .join(", ");
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      `Unknown subagent_type "${requestedType}". Available: ${allowed}.`,
    );
  }
  if (requestedType === "general-purpose") {
    const impersonatedRole = findImpersonatedReadOnlyRole(directive, fork.listDefinitions());
    if (impersonatedRole !== undefined) {
      throw new SatiToolRuntimeError(
        "invalid_tool_input",
        `Directive assigns the read-only role "${impersonatedRole}" but subagent_type is "general-purpose". ` +
          `Dispatch the role itself (subagent_type: "${impersonatedRole}") so its tool allowlist, write restrictions, and output contract apply; ` +
          "naming a role only inside the prompt does not restrict the subagent.",
        { errorCode: "subagent_role_mismatch", suggestedSubagentType: impersonatedRole },
      );
    }
  }
  const currentDepth = context.subagentDepth ?? fork.depth ?? 0;
  if (currentDepth >= fork.maxSubagentDepth) {
    throw new SatiToolRuntimeError(
      "tool_execution_failed",
      `subagent_depth_exceeded (depth=${currentDepth}, max=${fork.maxSubagentDepth}); nested fork rejected.`,
      { errorCode: "subagent_depth_exceeded" },
    );
  }
  const subagentId = randomUUID();
  const timeoutMs = requestedTimeoutMs ?? context.subagentTimeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  let report;
  try {
    report = await fork.fork({
      definitionId: requestedType,
      directive,
      subagentId,
      toolCallId: context.currentToolCallId,
      abortSignal: context.abortSignal,
      timeoutMs,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
    });
  } catch (error) {
    if (context.abortSignal?.aborted) {
      throw new SatiToolRuntimeError("tool_aborted", "agent subagent aborted before completion.");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new SatiToolRuntimeError("tool_execution_failed", `agent subagent failed: ${message}`, {
      errorCode: "subagent_execution_failed",
    });
  }
  if (context.abortSignal?.aborted) {
    throw new SatiToolRuntimeError("tool_aborted", "agent subagent aborted before completion.");
  }
  const stopReason = report.stopReason ?? "completed";
  const partial = report.partial === true || stopReason !== "completed";
  const body =
    report.markdown.trim().length > 0
      ? report.markdown
      : partial
        ? `(no textual report produced before ${stopReason})`
        : "(empty subagent response)";
  // 部分结果必须在工具结果里显式标注：父代理不能把预算耗尽前的半成品
  // 当成完整复核结论继续下游（降级但不静默）。
  const partialNotice = partial
    ? `\n\n[partial: ${stopReason}; turns=${report.turns}; toolCalls=${report.toolCalls ?? "?"}] ` +
      "Treat the report above as provisional; narrow the scope or raise the budget before relying on it."
    : "";
  const output: AgentToolOutput = {
    subagentType: requestedType,
    description: input.description,
    text: report.markdown,
    usage: report.usage,
    turns: report.turns,
    durationMs: report.durationMs,
    parsed: report.parsed,
    stopReason,
    partial,
    ...(report.toolCalls !== undefined ? { toolCalls: report.toolCalls } : {}),
  };
  return {
    content: [
      {
        type: "text",
        text: `[${requestedType}] ${input.description}\n\n${body}${partialNotice}`,
      },
      { type: "json", value: output },
    ],
    data: output,
    metadata: {
      subagent: requestedType,
      subagentId,
      forkMode: "full",
      turns: report.turns,
      durationMs: report.durationMs,
      stopReason,
      partial,
      ...(report.toolCalls !== undefined ? { toolCalls: report.toolCalls } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
      timeoutMs,
    },
  };
}

function readPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new SatiToolRuntimeError("invalid_tool_input", `${field} must be a positive integer.`);
  }
  return value;
}

async function runFallback(args: {
  input: AgentToolInput;
  context: SatiToolRuntimeContext;
  requestedType: string;
  directive: string;
  presets: Record<string, AgentSubagentDefinition>;
  model?: SatiToolModelClient;
  provider: string;
  modelId: string;
  maxOutputTokens: number;
  temperature: number;
}): Promise<SatiToolExecutionOutput<AgentToolOutput>> {
  const {
    input,
    context,
    requestedType,
    directive,
    presets,
    model: explicitModel,
    provider,
    modelId,
    maxOutputTokens,
    temperature,
  } = args;

  const preset = presets[requestedType];
  if (!preset) {
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      `Unknown subagent_type "${requestedType}". Available: ${Object.keys(presets).join(", ")}.`,
    );
  }
  const model = explicitModel ?? context.model;
  if (!model) {
    throw new SatiToolRuntimeError(
      "unsupported_tool",
      "agent tool requires a model client. Configure dependencies.model on AgentRuntimeDependencies, pass createAgentTool({ model }), or wire context.subagent for full-fork mode.",
    );
  }
  const request: CanonicalModelRequest = {
    provider,
    model: modelId,
    messages: [{ role: "user", content: [{ type: "text", text: directive }] }],
    systemPrompt: preset.systemPrompt,
    maxOutputTokens,
    temperature,
    stream: true,
    metadata: { subagent: preset.type, description: input.description },
  };
  let text = "";
  let usage: CanonicalUsage | undefined;
  for await (const event of model.stream(request, context.abortSignal)) {
    if (context.abortSignal?.aborted) {
      throw new SatiToolRuntimeError("tool_aborted", "agent subagent aborted before completion.");
    }
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "usage":
        usage = event.usage;
        break;
      case "error":
        throw new SatiToolRuntimeError("tool_execution_failed", `agent subagent model error: ${event.error.message}`, {
          errorCode: event.error.code,
        });
      default:
        break;
    }
  }
  const trimmed = text.trim();
  const output: AgentToolOutput = {
    subagentType: requestedType,
    description: input.description,
    text: trimmed.length > 0 ? trimmed : "(empty subagent response)",
    usage,
  };
  return {
    content: [
      {
        type: "text",
        text: `[${requestedType}] ${input.description}\n\n${output.text}`,
      },
      { type: "json", value: output },
    ],
    data: output,
    metadata: {
      subagent: requestedType,
      forkMode: "fallback",
      provider,
      model: modelId,
      promptBytes: Buffer.byteLength(directive, "utf8"),
    },
  };
}
