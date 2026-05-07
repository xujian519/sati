import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../protocol/result.js";

export type AgentTranscriptEntryType =
  | "accepted_input"
  | "assistant_message"
  | "tool_result_message"
  | "durable_message"
  | "turn_result"
  | "control_boundary";

export type AgentTranscriptEntryBase = {
  type: AgentTranscriptEntryType;
  sessionId: string;
  turnId: string;
  sequence: number;
  createdAt: string;
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

export type AgentTranscriptEntry =
  | AgentAcceptedInputTranscriptEntry
  | AgentMessageTranscriptEntry
  | AgentTurnResultTranscriptEntry
  | AgentControlBoundaryTranscriptEntry;

export type AgentTranscriptDiagnostic = {
  code: "transcript_missing" | "transcript_line_invalid" | "transcript_entry_invalid";
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
