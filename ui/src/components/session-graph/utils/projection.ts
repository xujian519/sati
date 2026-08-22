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

// Real message contracts carry tool arguments in `toolInput` (live bridge
// events) or `payload` (webMessageFlatten history rows) — never in text/content.
function getToolArguments(message: NormalizedMessage): string {
  const raw = message.toolInput ?? message.payload;
  if (raw === undefined || raw === null || raw === "") return getMessageText(message);
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

// tool_result spans failures via `isError` (mapWebMessageToNormalized) or
// `ok === false` (live bridge), with an optional machine-readable `errorCode`.
function getToolError(message: NormalizedMessage): string | undefined {
  if (message.isError !== true && message.ok !== false) return undefined;
  const code = typeof message.errorCode === "string" ? message.errorCode : undefined;
  return code ? `tool_error:${code}` : "tool_error_failed";
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
        arguments: getToolArguments(message),
      });
      continue;
    }

    if (kind === "tool_result") {
      const callId = message.toolId ?? message.entryId ?? "";
      const existing = toolCalls.get(callId);
      const text = getMessageText(message);
      const error = getToolError(message);
      if (existing) {
        existing.result = text;
        if (error !== undefined) existing.error = error;
      } else {
        toolCalls.set(callId, {
          callId,
          name: message.toolName ?? "tool",
          result: text,
          ...(error !== undefined ? { error } : {}),
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
