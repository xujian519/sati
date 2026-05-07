import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../protocol/result.js";

export type AgentTranscriptWriter = {
  recordAcceptedInput(sessionId: string, turnId: string, messages: CanonicalMessage[]): void | Promise<void>;
  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): void | Promise<void>;
  recordTurnResult(sessionId: string, turnId: string, result: AgentTurnResult): void | Promise<void>;
};
