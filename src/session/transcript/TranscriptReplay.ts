import type { CanonicalMessage, CanonicalUsage } from "../../model/index.js";
import type { AgentEvent } from "../../agent/protocol/events.js";
import type { AgentPermissionDenial, AgentTurnResult } from "../../agent/protocol/result.js";
import type { AgentTranscriptDiagnostic, AgentTranscriptEntry, SessionMetadataValue } from "./TranscriptEntry.js";

export type AgentTranscriptReplayResult = {
  messages: CanonicalMessage[];
  usage: CanonicalUsage;
  permissionDenials: AgentPermissionDenial[];
  events: AgentEvent[];
  metadata: SessionMetadataValue;
  diagnostics: AgentTranscriptDiagnostic[];
};

export function replayTranscriptEntries(entries: AgentTranscriptEntry[]): AgentTranscriptReplayResult {
  const messages: CanonicalMessage[] = [];
  const events: AgentEvent[] = [];
  const diagnostics: AgentTranscriptDiagnostic[] = [];
  let metadata: SessionMetadataValue = {};
  let usage: CanonicalUsage = {};
  let permissionDenials: AgentPermissionDenial[] = [];

  const completedTurnIds = new Set(
    entries.filter((entry) => entry.type === "turn_result").map((entry) => entry.turnId),
  );

  for (const entry of entries) {
    switch (entry.type) {
      case "accepted_input":
        messages.push(...cloneMessages(entry.messages));
        events.push({
          type: "input_accepted",
          sessionId: entry.sessionId,
          turnId: entry.turnId,
          messages: cloneMessages(entry.messages),
        });
        break;
      case "assistant_message":
      case "tool_result_message":
      case "durable_message":
        if (!completedTurnIds.has(entry.turnId)) {
          diagnostics.push({
            code: "transcript_entry_invalid",
            severity: "warning",
            message: `Skipping durable message for incomplete turn ${entry.turnId}.`,
          });
          break;
        }
        messages.push(cloneMessage(entry.message));
        events.push(projectMessageEvent(entry.sessionId, entry.turnId, entry.message));
        break;
      case "turn_result":
        usage = mergeUsage(usage, entry.result.usage);
        permissionDenials = [...permissionDenials, ...entry.result.permissionDenials];
        events.push({
          type: "turn_completed",
          sessionId: entry.sessionId,
          turnId: entry.turnId,
          result: cloneTurnResult(entry.result),
        });
        break;
      case "control_boundary":
        break;
      case "session_metadata":
        metadata = mergeMetadata(metadata, entry.metadata);
        break;
    }
  }

  return { messages, usage, permissionDenials, events, metadata, diagnostics };
}

function projectMessageEvent(sessionId: string, turnId: string, message: CanonicalMessage): AgentEvent {
  if (message.role === "assistant") {
    return { type: "assistant_message", sessionId, turnId, message: cloneMessage(message) };
  }
  return { type: "tool_results_projected", sessionId, turnId, message: cloneMessage(message) };
}

function cloneMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map(cloneMessage);
}

function cloneMessage(message: CanonicalMessage): CanonicalMessage {
  return {
    ...message,
    content: message.content.map((block) => ({ ...block })),
  };
}

function cloneTurnResult(result: AgentTurnResult): AgentTurnResult {
  return {
    ...result,
    usage: { ...result.usage },
    permissionDenials: result.permissionDenials.map((denial) => ({ ...denial })),
    errors: result.errors?.map((error) => ({ ...error })),
  };
}

function mergeUsage(first: CanonicalUsage, second: CanonicalUsage): CanonicalUsage {
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

function mergeMetadata(first: SessionMetadataValue, second: SessionMetadataValue): SessionMetadataValue {
  return {
    ...first,
    ...second,
    title: second.title ?? first.title,
    linkedPullRequest: second.linkedPullRequest ?? first.linkedPullRequest,
  };
}
