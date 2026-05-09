import type { CanonicalMessage, CanonicalModelEvent, CanonicalModelRequest } from "../../model/index.js";
import type { PolitDeckToolAuditRecorder, PolitDeckToolScheduler, ToolRegistry } from "../../tool/index.js";
import type { LifecycleRuntime } from "../../lifecycle/index.js";
import type { AgentContextRuntime } from "../../context/ContextRuntime.js";

export type AgentModelRuntime = {
  stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent>;
};

/**
 * Subagent sidechain transcript hooks (C3 §6.3). The agent loop calls these
 * around a forked subagent so:
 *   - `recordSubagentStarted` writes a `subagent_started` reference into the
 *     **parent** transcript (truncated directive preview).
 *   - `recordSubagentCompleted` writes a `subagent_completed` reference into
 *     the **parent** transcript (truncated summary + usage / duration).
 *   - `subagentTranscriptResolver(subagentId)` returns a sidechain writer
 *     that captures the subagent's turn-by-turn entries into a separate
 *     `<subagentId>.jsonl` file.
 *
 * All hooks are optional — when missing, the agent loop falls back to the
 * legacy "no sidechain" behavior (subagent runs, but no persistence).
 */
export type AgentSubagentTranscriptHooks = {
  recordSubagentStarted?(args: {
    sessionId: string;
    turnId: string;
    subagentId: string;
    subagentType: string;
    prompt: string;
    transcriptRelativePath: string;
    subagentSessionId?: string;
  }): Promise<void>;
  recordSubagentCompleted?(args: {
    sessionId: string;
    turnId: string;
    subagentId: string;
    subagentType: string;
    summary: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      totalTokens?: number;
    };
    turns: number;
    durationMs: number;
    errored?: boolean;
  }): Promise<void>;
  subagentTranscriptResolver?(subagentId: string): {
    recordAcceptedInput(sessionId: string, turnId: string, messages: CanonicalMessage[]): Promise<void>;
    recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): Promise<void>;
    transcriptRelativePath: string;
  };
};

export type AgentRuntimeDependencies = {
  model: AgentModelRuntime;
  tools: {
    scheduler: PolitDeckToolScheduler;
    registry: ToolRegistry;
  };
  context?: AgentContextRuntime;
  now?: () => Date;
  uuid?: () => string;
  auditRecorder?: PolitDeckToolAuditRecorder;
  lifecycle?: LifecycleRuntime;
  /** C3 sidechain transcript hooks (optional). */
  subagentTranscript?: AgentSubagentTranscriptHooks;
};
