export type NormalizedMessage = {
  entryId?: string;
  kind?: string;
  role?: string;
  content?: string;
  text?: string;
  toolId?: string;
  toolName?: string;
  timestamp?: string;
  [key: string]: unknown;
};

export type FoldedToolProcess = {
  callId: string;
  name: string;
  arguments?: string;
  result?: string;
  error?: string | null;
};

export type SessionTurn = {
  turnId: string;
  question: string;
  answer: string | null;
  pending?: boolean;
  error?: string | null;
  process: FoldedToolProcess[];
  at?: string;
};

const RUNTIME_CONTEXT_KINDS = new Set([
  "system_prompt",
  "runtime_context",
  "turn_result",
  "request_header",
  "retry_schedule",
]);

function getMessageText(message: NormalizedMessage): string {
  return String(message.text ?? message.content ?? "").trim();
}

export function messagesToTurns(messages: NormalizedMessage[]): SessionTurn[] {
  const turns: SessionTurn[] = [];
  const toolCalls = new Map<string, FoldedToolProcess>();

  for (const message of messages) {
    if (!message || RUNTIME_CONTEXT_KINDS.has(message.kind ?? "")) continue;

    const kind = message.kind ?? "";
    const role = message.role ?? "";

    if (kind === "tool_use" || kind === "tool_call") {
      const callId = message.toolId ?? message.entryId ?? String(Math.random());
      toolCalls.set(callId, {
        callId,
        name: message.toolName ?? "tool",
        arguments: getMessageText(message),
      });
      continue;
    }

    if (kind === "tool_result") {
      const callId = message.toolId ?? message.entryId ?? "";
      const existing = toolCalls.get(callId);
      const text = getMessageText(message);
      if (existing) {
        existing.result = text;
      } else {
        toolCalls.set(callId, {
          callId,
          name: message.toolName ?? "tool",
          result: text,
        });
      }
      continue;
    }

    if (role === "user") {
      turns.push({
        turnId: message.entryId ?? `turn-${turns.length}`,
        question: getMessageText(message),
        answer: null,
        pending: false,
        error: null,
        process: [],
        at: message.timestamp,
      });
      toolCalls.clear();
      continue;
    }

    if (role === "assistant" || role === "model") {
      if (turns.length === 0) continue;
      const current = turns[turns.length - 1];
      if (current.answer == null) {
        current.answer = getMessageText(message);
      } else {
        current.answer += "\n" + getMessageText(message);
      }
      current.process = Array.from(toolCalls.values());
      current.pending = kind === "status" || kind === "thinking";
      current.error = kind === "error" ? getMessageText(message) : current.error;
      toolCalls.clear();
    }
  }

  return turns;
}
