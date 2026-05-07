import {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  createModelMessageAssemblerState,
  type CanonicalMessage,
  type CanonicalModelRequest,
  type CanonicalUsage,
} from "../../model/index.js";
import type { PolitDeckToolResult, PolitDeckToolRuntimeContext } from "../../tool/index.js";
import { agentError } from "../protocol/errors.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentPermissionDenial, AgentTurnResult } from "../protocol/result.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
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

      const request = this.createModelRequest(messages);
      yield {
        type: "model_request_started",
        sessionId: input.sessionId,
        turnId: input.turnId,
        model: request.model,
        provider: request.provider,
      };

      const assembler = createModelMessageAssemblerState();
      try {
        for await (const event of this.dependencies.model.stream(request, input.abortSignal)) {
          yield { type: "model_event", sessionId: input.sessionId, turnId: input.turnId, event };
          applyModelEventToAssembler(assembler, event);
          if (event.type === "error") {
            break;
          }
        }
      } catch (error) {
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
        const result = this.createTurnResult(input, {
          type: "error",
          stopReason: "model_error",
          usage,
          permissionDenials,
          turns: turnCount,
          startedAt,
          finalMessage,
          errors: [agentError("agent_model_error", assembled.error.message, assembled.error)],
        });
        yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages };
      }

      if (toolCalls.length === 0) {
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
        yield { type: "tool_result", sessionId: input.sessionId, turnId: input.turnId, result };
      }

      const projected = projectToolResults(pairedResults);
      messages.push(projected);
      yield { type: "tool_results_projected", sessionId: input.sessionId, turnId: input.turnId, message: projected };

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

  private createModelRequest(messages: CanonicalMessage[]): CanonicalModelRequest {
    return {
      provider: this.config.provider,
      model: this.config.model,
      messages: cloneMessages(messages),
      systemPrompt: this.config.systemPrompt,
      tools: this.dependencies.tools.registry.toCanonicalSchemas(),
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
