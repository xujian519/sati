import type { CanonicalMessage, CanonicalModelEvent, CanonicalToolCall } from "../../model/index.js";
import type { PolitDeckToolResult } from "../../tool/index.js";
import type { AgentError } from "./errors.js";
import type { AgentTurnResult } from "./result.js";
import type { AgentLoopTransition } from "./state.js";

export type AgentEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "turn_started"; sessionId: string; turnId: string }
  | { type: "input_accepted"; sessionId: string; turnId: string; messages: CanonicalMessage[] }
  | { type: "model_request_started"; sessionId: string; turnId: string; model: string; provider: string }
  | { type: "model_event"; sessionId: string; turnId: string; event: CanonicalModelEvent }
  | { type: "assistant_message"; sessionId: string; turnId: string; message: CanonicalMessage }
  | { type: "tool_calls_detected"; sessionId: string; turnId: string; calls: CanonicalToolCall[] }
  | { type: "tool_result"; sessionId: string; turnId: string; result: PolitDeckToolResult }
  | { type: "tool_results_projected"; sessionId: string; turnId: string; message: CanonicalMessage }
  | { type: "turn_continued"; sessionId: string; turnId: string; reason: AgentLoopTransition["reason"] }
  | { type: "turn_completed"; sessionId: string; turnId: string; result: AgentTurnResult }
  | { type: "turn_failed"; sessionId: string; turnId: string; error: AgentError }
  | { type: "session_aborted"; sessionId: string; reason?: string };
