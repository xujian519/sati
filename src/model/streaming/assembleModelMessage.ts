import type {
  CanonicalContentBlock,
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalTextBlock,
  CanonicalThinkingBlock,
  CanonicalToolCall,
  CanonicalUsage,
} from "../protocol/canonical.js";
import type { CanonicalModelError } from "../protocol/errors.js";

export type ModelMessageAssemblerState = {
  content: CanonicalContentBlock[];
  textBuffer: string;
  thinkingBuffer: string;
  usage: CanonicalUsage;
  finishReason?: CanonicalFinishReason;
  error?: CanonicalModelError;
  toolCalls: CanonicalToolCall[];
};

export type AssembledAssistantMessage = {
  message: CanonicalMessage;
  finishReason: CanonicalFinishReason;
  usage?: CanonicalUsage;
  toolCalls: CanonicalToolCall[];
  error?: CanonicalModelError;
};

export function createModelMessageAssemblerState(): ModelMessageAssemblerState {
  return {
    content: [],
    textBuffer: "",
    thinkingBuffer: "",
    usage: {},
    toolCalls: [],
  };
}

export function applyModelEventToAssembler(
  state: ModelMessageAssemblerState,
  event: CanonicalModelEvent,
): void {
  switch (event.type) {
    case "request_started":
    case "message_start":
    case "tool_call_start":
    case "tool_call_delta":
      return;
    case "text_delta":
      state.textBuffer += event.text;
      return;
    case "thinking_delta":
      state.thinkingBuffer += event.text;
      return;
    case "tool_call_end":
      flushTextBuffers(state);
      state.toolCalls.push(event.toolCall);
      state.content.push({
        type: "tool_call",
        ...event.toolCall,
      });
      return;
    case "message_end":
      flushTextBuffers(state);
      state.finishReason = event.finishReason;
      return;
    case "usage":
      state.usage = mergeUsage(state.usage, event.usage);
      return;
    case "error":
      flushTextBuffers(state);
      state.error = event.error;
      state.finishReason = "error";
      return;
  }
}

export function assembleAssistantMessage(state: ModelMessageAssemblerState): AssembledAssistantMessage {
  flushTextBuffers(state);
  return {
    message: {
      role: "assistant",
      content: [...state.content],
    },
    finishReason: state.finishReason ?? (state.error ? "error" : "unknown"),
    usage: hasUsage(state.usage) ? state.usage : undefined,
    toolCalls: [...state.toolCalls],
    error: state.error,
  };
}

function flushTextBuffers(state: ModelMessageAssemblerState): void {
  if (state.thinkingBuffer.length > 0) {
    state.content.push({
      type: "thinking",
      text: state.thinkingBuffer,
    } satisfies CanonicalThinkingBlock);
    state.thinkingBuffer = "";
  }

  if (state.textBuffer.length > 0) {
    state.content.push({
      type: "text",
      text: state.textBuffer,
    } satisfies CanonicalTextBlock);
    state.textBuffer = "";
  }
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

function hasUsage(usage: CanonicalUsage): boolean {
  return Object.values(usage).some((value) => value !== undefined);
}
