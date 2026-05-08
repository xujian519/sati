import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";

export type AgentTranscriptEntryType =
  | "accepted_input"
  | "assistant_message"
  | "tool_result_message"
  | "durable_message"
  | "turn_result"
  | "control_boundary"
  | "session_metadata";

export type AgentTranscriptEntryBase = {
  type: AgentTranscriptEntryType;
  sessionId: string;
  turnId: string;
  sequence: number;
  createdAt: string;
  entryId?: string;
  parentEntryId?: string | null;
};

export type AgentAcceptedInputTranscriptEntry = AgentTranscriptEntryBase & {
  type: "accepted_input";
  messages: CanonicalMessage[];
};

export type AgentMessageTranscriptEntry = AgentTranscriptEntryBase & {
  type: "assistant_message" | "tool_result_message" | "durable_message";
  message: CanonicalMessage;
};

export type AgentTurnResultTranscriptEntry = AgentTranscriptEntryBase & {
  type: "turn_result";
  result: AgentTurnResult;
};

export type AgentControlBoundaryTranscriptEntry = AgentTranscriptEntryBase & {
  type: "control_boundary";
  boundary: {
    kind: "compact" | "resume" | "manual";
    metadata?: Record<string, unknown>;
  };
};

export type SessionMetadataValue = {
  title?: string;
  aiTitle?: string;
  tag?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  gitBranch?: string;
  mode?: "normal" | "coordinator";
  linkedPullRequest?: {
    number: number;
    url: string;
    repository: string;
  };
  updatedAt?: string;
};

export type AgentSessionMetadataTranscriptEntry = AgentTranscriptEntryBase & {
  type: "session_metadata";
  metadata: SessionMetadataValue;
};

export type AgentTranscriptEntry =
  | AgentAcceptedInputTranscriptEntry
  | AgentMessageTranscriptEntry
  | AgentTurnResultTranscriptEntry
  | AgentControlBoundaryTranscriptEntry
  | AgentSessionMetadataTranscriptEntry;

export type AgentTranscriptDiagnostic = {
  code: "transcript_missing" | "transcript_too_large" | "transcript_line_invalid" | "transcript_entry_invalid";
  severity: "warning" | "error";
  message: string;
  line?: number;
};

export function classifyDurableMessageEntry(message: CanonicalMessage): AgentMessageTranscriptEntry["type"] {
  if (message.role === "assistant") {
    return "assistant_message";
  }

  if (message.content.some((block) => block.type === "tool_result")) {
    return "tool_result_message";
  }

  return "durable_message";
}
