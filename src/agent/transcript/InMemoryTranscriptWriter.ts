import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../protocol/result.js";
import type { AgentTranscriptWriter } from "./TranscriptWriter.js";

export type InMemoryTranscriptEntry =
  | { type: "accepted_input"; sessionId: string; turnId: string; messages: CanonicalMessage[] }
  | { type: "durable_message"; sessionId: string; turnId: string; message: CanonicalMessage }
  | { type: "turn_result"; sessionId: string; turnId: string; result: AgentTurnResult };

export class InMemoryTranscriptWriter implements AgentTranscriptWriter {
  readonly entries: InMemoryTranscriptEntry[] = [];

  recordAcceptedInput(sessionId: string, turnId: string, messages: CanonicalMessage[]): void {
    this.entries.push({ type: "accepted_input", sessionId, turnId, messages });
  }

  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): void {
    this.entries.push({ type: "durable_message", sessionId, turnId, message });
  }

  recordTurnResult(sessionId: string, turnId: string, result: AgentTurnResult): void {
    this.entries.push({ type: "turn_result", sessionId, turnId, result });
  }
}
