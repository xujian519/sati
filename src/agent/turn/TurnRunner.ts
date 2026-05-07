import { agentError, normalizeAgentError } from "../protocol/errors.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentInput } from "../protocol/input.js";
import type { AgentTurnResult } from "../protocol/result.js";
import type { AgentLoop } from "../loop/AgentLoop.js";
import type { AgentTranscriptWriter } from "../transcript/TranscriptWriter.js";
import { TurnInputProcessor } from "./TurnInputProcessor.js";
import type { CanonicalMessage, CanonicalUsage } from "../../model/index.js";

export type TurnRunnerOptions = {
  sessionId: string;
  turnId: string;
  messages: CanonicalMessage[];
  input: AgentInput;
  maxTurns?: number;
  abortSignal?: AbortSignal;
};

export type TurnRunnerResult = {
  result: AgentTurnResult;
  messages: CanonicalMessage[];
};

export class TurnRunner {
  constructor(
    private readonly loop: AgentLoop,
    private readonly transcript: AgentTranscriptWriter,
    private readonly inputProcessor = new TurnInputProcessor(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async *run(options: TurnRunnerOptions): AsyncGenerator<AgentEvent, TurnRunnerResult, unknown> {
    yield { type: "turn_started", sessionId: options.sessionId, turnId: options.turnId };
    const accepted = this.inputProcessor.accept(options.input);
    const messages = [...options.messages, ...accepted.messages];

    try {
      await this.transcript.recordAcceptedInput(options.sessionId, options.turnId, accepted.messages);
    } catch (error) {
      const agentTranscriptError = agentError("agent_transcript_error", "Failed to record accepted input.", error);
      const result = this.createErrorResult(options, agentTranscriptError);
      yield { type: "turn_failed", sessionId: options.sessionId, turnId: options.turnId, error: agentTranscriptError };
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
      return { result, messages: options.messages };
    }

    yield { type: "input_accepted", sessionId: options.sessionId, turnId: options.turnId, messages: accepted.messages };

    if (!accepted.shouldCallModel) {
      const result = this.createErrorResult(
        options,
        agentError("agent_unsupported_feature", "Input was accepted but model execution was not requested."),
      );
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
      return { result, messages };
    }

    try {
      const runResult = yield* this.loop.run({
        sessionId: options.sessionId,
        turnId: options.turnId,
        messages,
        maxTurns: options.maxTurns,
        abortSignal: options.abortSignal,
      });

      for (const message of durableMessagesAfter(messages.length, runResult.messages)) {
        await this.transcript.recordDurableMessage(options.sessionId, options.turnId, message);
      }
      await this.transcript.recordTurnResult(options.sessionId, options.turnId, runResult.result);
      return runResult;
    } catch (error) {
      const normalized = normalizeAgentError(error);
      const result = this.createErrorResult(options, normalized);
      yield { type: "turn_failed", sessionId: options.sessionId, turnId: options.turnId, error: normalized };
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
      return { result, messages };
    }
  }

  private createErrorResult(options: TurnRunnerOptions, error: ReturnType<typeof agentError>): AgentTurnResult {
    const timestamp = this.now().toISOString();
    return {
      type: "error",
      sessionId: options.sessionId,
      turnId: options.turnId,
      stopReason: error.code === "agent_aborted" ? "aborted_streaming" : "model_error",
      usage: emptyUsage(),
      permissionDenials: [],
      turns: 0,
      startedAt: timestamp,
      completedAt: timestamp,
      errors: [error],
    };
  }
}

function durableMessagesAfter(offset: number, messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.slice(offset);
}

function emptyUsage(): CanonicalUsage {
  return {};
}
