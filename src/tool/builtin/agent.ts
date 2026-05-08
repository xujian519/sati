import type { CanonicalModelRequest, CanonicalUsage } from "../../model/index.js";
import type { PermissionResult } from "../../permission/index.js";
import { PolitDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PolitDeckToolDefinition,
  PolitDeckToolExecutionOutput,
  PolitDeckToolModelClient,
  PolitDeckToolRuntimeContext,
} from "../protocol/types.js";

/**
 * Built-in subagent presets. Each preset locks the system prompt and short
 * description; the caller specifies a higher-level "what to do" via the
 * `prompt` field of the tool input.
 *
 * P0 design (matches `docs/politdeck-tool-refactor-development-guide.md` §1.6
 * P0): subagent runs a **single synchronous model call**, no nested tool loop.
 * That keeps the architecture hatch (model client in
 * `PolitDeckToolRuntimeContext`) small and avoids dragging the AgentLoop
 * recursion / fork lifecycle into this iteration. A future iteration can wrap
 * this with a real fork loop — see deferred gate `agent-subagent-fork-full`.
 */
export type AgentSubagentType =
  | "general_purpose"
  | "plan"
  | "verify"
  | "explore";

export type AgentSubagentDefinition = {
  type: AgentSubagentType;
  description: string;
  systemPrompt: string;
};

export const BUILTIN_SUBAGENTS: Record<AgentSubagentType, AgentSubagentDefinition> = {
  general_purpose: {
    type: "general_purpose",
    description:
      "General-purpose subagent for delegating bounded research / synthesis tasks. Returns a single text answer.",
    systemPrompt:
      "You are a general-purpose subagent inside PolitDeck. Read the user's instructions, reason carefully, and produce a single concise text answer. Do not ask follow-up questions; do your best with the information given.",
  },
  plan: {
    type: "plan",
    description:
      "Planning subagent. Given a task description, produce an actionable step-by-step plan without executing it.",
    systemPrompt:
      "You are a planning subagent inside PolitDeck. Given a task, return a numbered plan of concrete steps a developer or operator could follow. Be specific. Do not perform the steps yourself; return the plan only.",
  },
  verify: {
    type: "verify",
    description:
      "Verification subagent. Given a claim or proposed change, return a critique with specific concerns and recommended checks.",
    systemPrompt:
      "You are a verification subagent inside PolitDeck. Given a proposal, change, or claim, return a structured critique with: (1) specific concerns, (2) recommended checks, (3) overall verdict. Be rigorous; flag risks even if minor.",
  },
  explore: {
    type: "explore",
    description:
      "Exploration subagent. Given a topic or question, return an overview of approaches, trade-offs, and pointers.",
    systemPrompt:
      "You are an exploration subagent inside PolitDeck. Given a topic, return a structured overview: (a) common approaches, (b) trade-offs between them, (c) recommended next steps for someone unfamiliar with the area.",
  },
};

export type AgentToolInput = {
  description: string;
  prompt: string;
  subagentType?: AgentSubagentType;
};

export type AgentToolOutput = {
  subagentType: AgentSubagentType;
  description: string;
  text: string;
  usage?: CanonicalUsage;
};

export type CreateAgentToolOptions = {
  /**
   * Override the model client used for subagent calls. Falls back to
   * `context.model` (provided by AgentLoop). When neither is available the
   * tool returns `unsupported_tool`.
   */
  model?: PolitDeckToolModelClient;
  /** Override which subagent presets are available. */
  subagents?: Record<AgentSubagentType, AgentSubagentDefinition>;
  /** Provider id forwarded to `stream()` for the subagent call. */
  provider?: string;
  /** Model id forwarded to `stream()` for the subagent call. */
  model_?: string;
  /** Subagent maxOutputTokens (default 4096). */
  maxOutputTokens?: number;
  /** Subagent temperature (default 0). */
  temperature?: number;
};

const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_PROVIDER_FALLBACK = "edgeclaw";
const DEFAULT_MODEL_FALLBACK = "moonshotai/kimi-k2.6";

export function createAgentTool(
  options: CreateAgentToolOptions = {},
): PolitDeckToolDefinition<AgentToolInput, AgentToolOutput> {
  const subagents = options.subagents ?? BUILTIN_SUBAGENTS;
  const subagentTypes = Object.keys(subagents) as AgentSubagentType[];

  return {
    name: "agent",
    aliases: ["Agent", "Task"],
    description:
      "Delegate a bounded research / planning / verification task to a built-in subagent. Returns the subagent's text answer.",
    kind: "agent",
    inputSchema: {
      type: "object",
      required: ["description", "prompt"],
      additionalProperties: false,
      properties: {
        description: {
          type: "string",
          description: "Short label used in audit / progress (e.g. 'plan refactor').",
        },
        prompt: {
          type: "string",
          description: "Detailed instructions for the subagent.",
        },
        subagentType: {
          type: "string",
          enum: subagentTypes,
          description: `Which built-in subagent to use. Default: general_purpose. Available: ${subagentTypes.join(", ")}.`,
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "ask",
      reason: { type: "tool", toolName: "agent", message: "Subagent invocation requires permission." },
      request: {
        toolCallId: "",
        toolName: "agent",
        inputSummary: "subagent invocation",
        reason: { type: "tool", toolName: "agent", message: "Subagent invocation requires permission." },
        options: [
          { id: "allow_once", label: "Allow subagent" },
          { id: "deny", label: "Deny" },
        ],
      },
    }),
    execute: async (input, context) => {
      const subagentType = (input.subagentType ?? "general_purpose") as AgentSubagentType;
      const subagent = subagents[subagentType];
      if (!subagent) {
        throw new PolitDeckToolRuntimeError(
          "invalid_tool_input",
          `Unknown subagent type "${subagentType}". Available: ${subagentTypes.join(", ")}.`,
        );
      }

      const model = options.model ?? context.model;
      if (!model) {
        throw new PolitDeckToolRuntimeError(
          "unsupported_tool",
          "agent tool requires a model client. Configure dependencies.model on AgentRuntimeDependencies, or pass createAgentTool({ model }).",
        );
      }

      return runSubagent({
        subagent,
        input,
        context,
        model,
        provider: options.provider ?? DEFAULT_PROVIDER_FALLBACK,
        modelId: options.model_ ?? DEFAULT_MODEL_FALLBACK,
        maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: options.temperature ?? 0,
      });
    },
  };
}

type RunSubagentInput = {
  subagent: AgentSubagentDefinition;
  input: AgentToolInput;
  context: PolitDeckToolRuntimeContext;
  model: PolitDeckToolModelClient;
  provider: string;
  modelId: string;
  maxOutputTokens: number;
  temperature: number;
};

async function runSubagent(
  args: RunSubagentInput,
): Promise<PolitDeckToolExecutionOutput<AgentToolOutput>> {
  const { subagent, input, context, model, provider, modelId, maxOutputTokens, temperature } = args;

  const request: CanonicalModelRequest = {
    provider,
    model: modelId,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: input.prompt }],
      },
    ],
    systemPrompt: subagent.systemPrompt,
    maxOutputTokens,
    temperature,
    stream: true,
    metadata: {
      subagent: subagent.type,
      description: input.description,
    },
  };

  let text = "";
  let usage: CanonicalUsage | undefined;
  for await (const event of model.stream(request, context.abortSignal)) {
    if (context.abortSignal?.aborted) {
      throw new PolitDeckToolRuntimeError("tool_aborted", "agent subagent aborted before completion.");
    }
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "usage":
        usage = event.usage;
        break;
      case "error":
        throw new PolitDeckToolRuntimeError(
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
    subagentType: subagent.type,
    description: input.description,
    text: trimmed.length > 0 ? trimmed : "(empty subagent response)",
    usage,
  };

  return {
    content: [
      {
        type: "text",
        text: `[${subagent.type}] ${input.description}\n\n${output.text}`,
      },
      { type: "json", value: output },
    ],
    data: output,
    metadata: {
      subagent: subagent.type,
      provider,
      model: modelId,
      promptBytes: Buffer.byteLength(input.prompt, "utf8"),
    },
  };
}
