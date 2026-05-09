import { randomUUID } from "node:crypto";
import type { CanonicalModelRequest, CanonicalUsage } from "../../model/index.js";
import type { PermissionResult } from "../../permission/index.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PilotDeckSubagentForkApi,
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolModelClient,
  PilotDeckToolRuntimeContext,
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
 * Mirrors legacy `third-party/claude-code-main/src/tools/AgentTool/AgentTool.ts`
 * input schema (description / prompt / subagent_type) and the 5-field
 * `Scope/Result/Key files/Files changed/Issues` output contract.
 */

export type AgentSubagentType =
  | "general_purpose"
  | "general-purpose"
  | "plan"
  | "explore"
  | "verify";

export type AgentSubagentDefinition = {
  type: AgentSubagentType;
  description: string;
  systemPrompt: string;
};

/** Legacy P0 single-shot presets. Used only in the fallback path. */
export const BUILTIN_SUBAGENTS: Record<string, AgentSubagentDefinition> = {
  general_purpose: {
    type: "general_purpose",
    description:
      "General-purpose subagent for delegating bounded research / synthesis tasks. Returns a single text answer.",
    systemPrompt:
      "You are a general-purpose subagent inside PilotDeck. Read the user's instructions, reason carefully, and produce a single concise text answer. Do not ask follow-up questions; do your best with the information given.",
  },
  plan: {
    type: "plan",
    description:
      "Planning subagent. Given a task description, produce an actionable step-by-step plan without executing it.",
    systemPrompt:
      "You are a planning subagent inside PilotDeck. Given a task, return a numbered plan of concrete steps a developer or operator could follow. Be specific. Do not perform the steps yourself; return the plan only.",
  },
  verify: {
    type: "verify",
    description:
      "Verification subagent. Given a claim or proposed change, return a critique with specific concerns and recommended checks.",
    systemPrompt:
      "You are a verification subagent inside PilotDeck. Given a proposal, change, or claim, return a structured critique with: (1) specific concerns, (2) recommended checks, (3) overall verdict. Be rigorous; flag risks even if minor.",
  },
  explore: {
    type: "explore",
    description:
      "Exploration subagent. Given a topic or question, return an overview of approaches, trade-offs, and pointers.",
    systemPrompt:
      "You are an exploration subagent inside PilotDeck. Given a topic, return a structured overview: (a) common approaches, (b) trade-offs between them, (c) recommended next steps for someone unfamiliar with the area.",
  },
};

export type AgentToolInput = {
  description: string;
  prompt: string;
  subagent_type?: string;
  /** @deprecated camelCase alias retained for backwards compatibility. */
  subagentType?: string;
};

export type AgentToolOutput = {
  subagentType: string;
  description: string;
  text: string;
  usage?: CanonicalUsage;
  turns?: number;
  durationMs?: number;
  parsed?: Record<string, string>;
};

export type CreateAgentToolOptions = {
  /**
   * Override the model client for the *fallback* single-shot path. The full
   * fork path uses `context.subagent.fork(...)` and ignores this option.
   */
  model?: PilotDeckToolModelClient;
  /** Override which fallback subagent presets are available. */
  subagents?: Record<string, AgentSubagentDefinition>;
  provider?: string;
  model_?: string;
  maxOutputTokens?: number;
  temperature?: number;
};

const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_PROVIDER_FALLBACK = "edgeclaw";
const DEFAULT_MODEL_FALLBACK = "moonshotai/kimi-k2.6";

export function createAgentTool(
  options: CreateAgentToolOptions = {},
): PilotDeckToolDefinition<AgentToolInput, AgentToolOutput> {
  const fallbackPresets = options.subagents ?? BUILTIN_SUBAGENTS;

  return {
    name: "agent",
    aliases: ["Agent", "Task"],
    description:
      "Delegate a bounded subtask to a subagent. When invoked from the AgentLoop, runs a real subagent with its own tool loop; otherwise issues a single model call. Returns the subagent's structured report.",
    kind: "agent",
    inputSchema: {
      type: "object",
      required: ["description", "prompt"],
      additionalProperties: false,
      properties: {
        description: {
          type: "string",
          description: "Short label used in audit / progress (3-5 words).",
        },
        prompt: {
          type: "string",
          description: "Detailed directive for the subagent (free-form text).",
        },
        subagent_type: {
          type: "string",
          description:
            "Subagent preset id. Full-fork mode: 'general-purpose' | 'explore' | 'plan'. Fallback mode: 'general_purpose' | 'plan' | 'verify' | 'explore'.",
        },
        subagentType: {
          type: "string",
          description: "Deprecated camelCase alias for subagent_type.",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isOpenWorld: () => true,
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "ask",
      reason: {
        type: "tool",
        toolName: "agent",
        message: "Subagent invocation requires permission.",
      },
      request: {
        toolCallId: "",
        toolName: "agent",
        inputSummary: "subagent invocation",
        reason: {
          type: "tool",
          toolName: "agent",
          message: "Subagent invocation requires permission.",
        },
        options: [
          { id: "allow_once", label: "Allow subagent" },
          { id: "deny", label: "Deny" },
        ],
      },
    }),
    execute: async (input, context) => {
      const explicit = input.subagent_type ?? input.subagentType;
      const directive = input.prompt;

      // Full fork path (C2): preferred when AgentLoop wired the fork API.
      if (context.subagent) {
        const requestedType = explicit ?? "general-purpose";
        return runFullFork({
          input,
          context,
          requestedType,
          directive,
          fork: context.subagent,
        });
      }
      // Fallback path keeps the legacy `general_purpose` underscore default.
      const requestedType = explicit ?? "general_purpose";

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

async function runFullFork(args: {
  input: AgentToolInput;
  context: PilotDeckToolRuntimeContext;
  requestedType: string;
  directive: string;
  fork: PilotDeckSubagentForkApi;
}): Promise<PilotDeckToolExecutionOutput<AgentToolOutput>> {
  const { input, context, requestedType, directive, fork } = args;

  if (!fork.isAllowedDefinition(requestedType)) {
    const allowed = fork.listDefinitions().map((d) => d.id).join(", ");
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `Unknown subagent_type "${requestedType}". Available: ${allowed}.`,
    );
  }
  const currentDepth = context.subagentDepth ?? fork.depth ?? 0;
  if (currentDepth >= fork.maxSubagentDepth) {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `subagent_depth_exceeded (depth=${currentDepth}, max=${fork.maxSubagentDepth}); nested fork rejected.`,
      { errorCode: "subagent_depth_exceeded" },
    );
  }
  const subagentId = randomUUID();
  const report = await fork.fork({
    definitionId: requestedType,
    directive,
    subagentId,
    abortSignal: context.abortSignal,
  });
  if (context.abortSignal?.aborted) {
    throw new PilotDeckToolRuntimeError(
      "tool_aborted",
      "agent subagent aborted before completion.",
    );
  }
  const output: AgentToolOutput = {
    subagentType: requestedType,
    description: input.description,
    text: report.markdown,
    usage: report.usage,
    turns: report.turns,
    durationMs: report.durationMs,
    parsed: report.parsed,
  };
  return {
    content: [
      {
        type: "text",
        text: `[${requestedType}] ${input.description}\n\n${report.markdown}`,
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
    },
  };
}

async function runFallback(args: {
  input: AgentToolInput;
  context: PilotDeckToolRuntimeContext;
  requestedType: string;
  directive: string;
  presets: Record<string, AgentSubagentDefinition>;
  model?: PilotDeckToolModelClient;
  provider: string;
  modelId: string;
  maxOutputTokens: number;
  temperature: number;
}): Promise<PilotDeckToolExecutionOutput<AgentToolOutput>> {
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
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `Unknown subagent_type "${requestedType}". Available: ${Object.keys(
        presets,
      ).join(", ")}.`,
    );
  }
  const model = explicitModel ?? context.model;
  if (!model) {
    throw new PilotDeckToolRuntimeError(
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
      throw new PilotDeckToolRuntimeError(
        "tool_aborted",
        "agent subagent aborted before completion.",
      );
    }
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "usage":
        usage = event.usage;
        break;
      case "error":
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          `agent subagent model error: ${event.error.message}`,
          { errorCode: event.error.code },
        );
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
