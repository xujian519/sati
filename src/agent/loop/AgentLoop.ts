import {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  createModelMessageAssemblerState,
  PROMPT_TOO_LONG_ANTHROPIC_PATTERN,
  PROMPT_TOO_LONG_OPENAI_PATTERN,
  REQUEST_TOO_LARGE_PATTERN,
  type CanonicalMessage,
  type CanonicalModelError,
  type CanonicalModelRequest,
  type CanonicalUsage,
} from "../../model/index.js";
import type { PolitDeckToolResult, PolitDeckToolRuntimeContext } from "../../tool/index.js";
import { agentError } from "../protocol/errors.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentPermissionDenial, AgentTurnResult } from "../protocol/result.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import type { LifecycleDispatchResult } from "../../lifecycle/index.js";
import { NullContextRuntime } from "../../context/NullContextRuntime.js";
import { collectToolCalls } from "./collectToolCalls.js";
import { createMissingToolResult, ensureToolResultPairing } from "./ensureToolResultPairing.js";
import { projectToolResults } from "./projectToolResults.js";

export type AgentLoopInput = {
  sessionId: string;
  turnId: string;
  messages: CanonicalMessage[];
  maxTurns?: number;
  abortSignal?: AbortSignal;
};

export type AgentLoopRunResult = {
  result: AgentTurnResult;
  messages: CanonicalMessage[];
};

export class AgentLoop {
  constructor(
    private readonly config: AgentRuntimeConfig,
    private readonly dependencies: AgentRuntimeDependencies,
  ) {}

  async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    const startedAt = this.now().toISOString();
    const messages = [...input.messages];
    let turnCount = 1;
    let usage: CanonicalUsage = {};
    let permissionDenials: AgentPermissionDenial[] = [];
    let structuredOutput: unknown;
    let finalMessage: CanonicalMessage | undefined;

    while (true) {
      if (input.abortSignal?.aborted) {
        const result = this.createTurnResult(input, {
          type: "aborted",
          stopReason: "aborted_streaming",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
        });
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      const request = await this.createModelRequest(messages);
      yield {
        type: "model_request_started",
        sessionId: input.sessionId,
        turnId: input.turnId,
        model: request.model,
        provider: request.provider,
      };

      const assembler = createModelMessageAssemblerState();
      try {
        for await (const event of this.dependencies.router.stream(request, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          abortSignal: input.abortSignal,
          isMainAgent: !this.config.isSubagent,
        })) {
          yield { type: "model_event", sessionId: input.sessionId, turnId: input.turnId, event };
          applyModelEventToAssembler(assembler, event);
          if (event.type === "error") {
            break;
          }
        }
      } catch (error) {
        await this.dispatchLifecycle(input, "StopFailure", {
          error: error instanceof Error ? error.message : String(error),
        });
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "model_error",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          errors: [agentError("agent_model_error", error instanceof Error ? error.message : String(error))],
        });
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      const assembled = assembleAssistantMessage(assembler);
      usage = mergeUsage(usage, assembled.usage);
      finalMessage = assembled.message;
      messages.push(assembled.message);
      yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: assembled.message };

      const toolCalls = collectToolCalls(assembled.message);
      if (assembled.error) {
        if (toolCalls.length > 0) {
          const projected = projectToolResults(
            toolCalls.map((call) => createMissingToolResult(call, this.now, "Model error interrupted tool execution.")),
          );
          messages.push(projected);
          yield { type: "tool_results_projected", sessionId: input.sessionId, turnId: input.turnId, message: projected };
        }
        const classified = classifyModelError(assembled.error);
        await this.dispatchLifecycle(input, "StopFailure", {
          error: assembled.error,
        });
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: classified.stopReason,
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          errors: [classified.error],
        });
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      if (toolCalls.length === 0) {
        const stopHooks = await this.dispatchLifecycle(input, "Stop", {
          stopHookActive: false,
          lastAssistantMessage: textFromMessage(assembled.message),
        });
        messages.push(...stopHooks.messages);
        const stopBlock = findLifecycleBlock(stopHooks);
        if (stopBlock) {
          const result = this.createTurnResult(input, {
            type: "error",
            stopReason: "tool_error",
            usage,
            permissionDenials,
            turns: turnCount,
            startedAt,
            finalMessage,
            structuredOutput,
            errors: [agentError("agent_unsupported_feature", stopBlock.reason)],
          });
          yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
          yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
          return { result, messages };
        }
        const result = this.createTurnResult(input, {
          type: "success",
          stopReason: "completed",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
        });
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      yield { type: "tool_calls_detected", sessionId: input.sessionId, turnId: input.turnId, calls: toolCalls };
      let results: PolitDeckToolResult[];
      try {
        results = await this.dependencies.tools.scheduler.executeAll(toolCalls, this.createToolContext(input));
      } catch (error) {
        results = toolCalls.map((call) =>
          createMissingToolResult(call, this.now, error instanceof Error ? error.message : String(error)),
        );
      }

      const pairedResults = ensureToolResultPairing(toolCalls, results, this.now);
      permissionDenials = [...permissionDenials, ...collectPermissionDenials(pairedResults)];
      for (const result of pairedResults) {
        if (result.type === "success" && result.metadata?.structuredOutput) {
          structuredOutput = result.data;
        }
        const requestedMode = readRequestedMode(result.type === "success" ? result.data : undefined);
        if (requestedMode) {
          this.config.permissionMode = requestedMode;
          this.config.permissionContext.mode = requestedMode;
          yield { type: "mode_change_requested", sessionId: input.sessionId, turnId: input.turnId, mode: requestedMode };
        }
        yield { type: "tool_result", sessionId: input.sessionId, turnId: input.turnId, result };
      }

      const projected = projectToolResults(pairedResults);
      messages.push(projected);
      yield { type: "tool_results_projected", sessionId: input.sessionId, turnId: input.turnId, message: projected };

      const lifecycleBlock = findToolLifecycleBlock(pairedResults);
      if (lifecycleBlock) {
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "tool_error",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [agentError("agent_unsupported_feature", lifecycleBlock.reason)],
        });
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      if (this.config.stopOnStructuredOutput && structuredOutput !== undefined) {
        const result = this.createTurnResult(input, {
          type: "success",
          stopReason: "completed",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          structuredOutput,
        });
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      const nextTurnCount = turnCount + 1;
      if (input.maxTurns && nextTurnCount > input.maxTurns) {
        const result = this.createTurnResult(input, {
          type: "max_turns",
          stopReason: "max_turns",
          usage,
          permissionDenials,
          turns: nextTurnCount,
          startedAt,
          finalMessage,
          structuredOutput,
          errors: [agentError("agent_max_turns_reached", `Reached maximum number of turns (${input.maxTurns}).`)],
        });
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      turnCount = nextTurnCount;
      yield { type: "turn_continued", sessionId: input.sessionId, turnId: input.turnId, reason: "next_turn" };
    }
  }

  private async createModelRequest(messages: CanonicalMessage[]): Promise<CanonicalModelRequest> {
    const contextRuntime = this.dependencies.context ?? new NullContextRuntime();
    const prepared = await contextRuntime.prepareForModel({
      messages: cloneMessages(messages),
      tools: this.dependencies.tools.registry.toCanonicalSchemas(),
      maxMessages: this.config.maxContextMessages,
    });

    return {
      provider: this.config.provider,
      model: this.config.model,
      messages: prepared.messages,
      systemPrompt: this.config.systemPrompt,
      tools: prepared.tools,
      toolChoice: this.config.toolChoice,
      maxOutputTokens: this.config.maxOutputTokens,
      temperature: this.config.temperature,
      thinking: this.config.thinking,
      stream: true,
      metadata: this.config.metadata,
    };
  }

  private createToolContext(input: AgentLoopInput): PolitDeckToolRuntimeContext {
    return {
      sessionId: input.sessionId,
      turnId: input.turnId,
      cwd: this.config.cwd,
      abortSignal: input.abortSignal,
      permissionMode: this.config.permissionMode,
      permissionContext: this.config.permissionContext,
      auditRecorder: this.dependencies.auditRecorder,
      now: this.now,
      env: this.config.env,
      maxResultBytes: this.config.maxResultBytes,
    };
  }

  private async dispatchLifecycle(
    input: AgentLoopInput,
    event: "Stop" | "StopFailure",
    payload: Record<string, unknown>,
  ): Promise<LifecycleDispatchResult> {
    return this.dependencies.lifecycle?.dispatch({
      event,
      baseInput: {
        sessionId: input.sessionId,
        transcriptPath: "",
        cwd: this.config.cwd,
        permissionMode: this.config.permissionMode,
      },
      payload,
      matchQuery: event,
      signal: input.abortSignal,
      env: this.config.env,
    }) ?? {
      effects: [],
      messages: [],
      events: [],
      blockingErrors: [],
      nonBlockingErrors: [],
    };
  }

  private createTurnResult(
    input: AgentLoopInput,
    options: Omit<AgentTurnResult, "sessionId" | "turnId" | "completedAt">,
  ): AgentTurnResult {
    return {
      ...options,
      sessionId: input.sessionId,
      turnId: input.turnId,
      completedAt: this.now().toISOString(),
    };
  }

  private readonly now = (): Date => this.dependencies.now?.() ?? new Date();
}

function findLifecycleBlock(result: LifecycleDispatchResult): { reason: string; stopReason?: string } | undefined {
  return result.effects.find(
    (effect): effect is { type: "block"; reason: string; stopReason?: string } => effect.type === "block",
  );
}

function findToolLifecycleBlock(results: PolitDeckToolResult[]): { reason: string; stopReason?: string } | undefined {
  for (const result of results) {
    const lifecycle = result.metadata?.lifecycle;
    if (isRecord(lifecycle) && isRecord(lifecycle.blocked) && typeof lifecycle.blocked.reason === "string") {
      return {
        reason: lifecycle.blocked.reason,
        stopReason: typeof lifecycle.blocked.stopReason === "string" ? lifecycle.blocked.stopReason : undefined,
      };
    }
  }
  return undefined;
}

function textFromMessage(message: CanonicalMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((block) => ({ ...block })),
  }));
}

function collectPermissionDenials(results: PolitDeckToolResult[]): AgentPermissionDenial[] {
  return results.flatMap((result) => {
    if (
      result.type === "error" &&
      (result.error.code === "permission_denied" ||
        result.error.code === "permission_required" ||
        result.error.code === "permission_cancelled")
    ) {
      return [
        {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          errorCode: result.error.code,
        },
      ];
    }
    return [];
  });
}

function mergeUsage(first: CanonicalUsage, second: CanonicalUsage | undefined): CanonicalUsage {
  if (!second) {
    return first;
  }
  return {
    inputTokens: add(first.inputTokens, second.inputTokens),
    outputTokens: add(first.outputTokens, second.outputTokens),
    cacheReadTokens: add(first.cacheReadTokens, second.cacheReadTokens),
    cacheWriteTokens: add(first.cacheWriteTokens, second.cacheWriteTokens),
    totalTokens: add(first.totalTokens, second.totalTokens),
  };
}

function add(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined && second === undefined) {
    return undefined;
  }
  return (first ?? 0) + (second ?? 0);
}

function readRequestedMode(value: unknown): AgentRuntimeConfig["permissionMode"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const requestedMode = (value as Record<string, unknown>).requestedMode;
  return isPermissionMode(requestedMode) ? requestedMode : undefined;
}

function isPermissionMode(value: unknown): value is AgentRuntimeConfig["permissionMode"] {
  return (
    value === "default" ||
    value === "plan" ||
    value === "acceptEdits" ||
    value === "bypassPermissions" ||
    value === "dontAsk"
  );
}

function classifyModelError(error: CanonicalModelError): {
  stopReason: AgentTurnResult["stopReason"];
  error: ReturnType<typeof agentError>;
} {
  if (isPromptTooLong(error)) {
    return {
      stopReason: "prompt_too_long",
      error: agentError("agent_prompt_too_long", error.message, error),
    };
  }
  return {
    stopReason: "model_error",
    error: agentError("agent_model_error", error.message, error),
  };
}

function isPromptTooLong(error: CanonicalModelError): boolean {
  if (error.code === "prompt_too_long" || error.recoverableViaCompact) {
    return true;
  }
  if (PROMPT_TOO_LONG_ANTHROPIC_PATTERN.test(error.message)) {
    return true;
  }
  if (PROMPT_TOO_LONG_OPENAI_PATTERN.test(error.message)) {
    return true;
  }
  if (REQUEST_TOO_LARGE_PATTERN.test(error.message)) {
    return true;
  }
  return false;
}
