import type { CanonicalModelEvent, CanonicalToolCall } from "../../protocol/canonical.js";
import { ModelProviderError } from "../../protocol/errors.js";
import { normalizeOpenAIFinishReason } from "../../response/normalizeFinishReason.js";
import { normalizeOpenAIUsage } from "../../response/normalizeUsage.js";

export type ThinkFsmMode = "NORMAL" | "THINKING";

export type OpenAIStreamState = {
  started: boolean;
  toolCalls: Map<number, Partial<CanonicalToolCall> & { argumentsBuffer?: string }>;
  thinkFsm: ThinkFsmMode;
  tagBuffer: string;
};

export function createOpenAIStreamState(): OpenAIStreamState {
  return {
    started: false,
    toolCalls: new Map(),
    thinkFsm: "NORMAL",
    tagBuffer: "",
  };
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * FSM-based parser that splits `<think>...</think>` tags from streamed
 * `delta.content` into separate `thinking_delta` / `text_delta` events.
 * Handles tags split across multiple chunks via `state.tagBuffer`.
 *
 * Modelled after edgeclaw-opc's ForceReasoningTransformer.
 */
export function splitThinkContent(
  content: string,
  state: OpenAIStreamState,
  raw: unknown,
): CanonicalModelEvent[] {
  const events: CanonicalModelEvent[] = [];
  let current = state.tagBuffer + content;
  state.tagBuffer = "";

  while (current.length > 0) {
    if (state.thinkFsm === "NORMAL") {
      const idx = current.indexOf(THINK_OPEN);
      if (idx !== -1) {
        const before = current.substring(0, idx);
        if (before.length > 0) {
          events.push({ type: "text_delta", text: before, raw });
        }
        current = current.substring(idx + THINK_OPEN.length);
        state.thinkFsm = "THINKING";
      } else {
        // Check if the tail could be a partial `<think>` open tag
        const buffered = bufferPartialTag(current, THINK_OPEN);
        if (buffered > 0) {
          state.tagBuffer = current.substring(current.length - buffered);
          const safe = current.substring(0, current.length - buffered);
          if (safe.length > 0) {
            events.push({ type: "text_delta", text: safe, raw });
          }
        } else {
          events.push({ type: "text_delta", text: current, raw });
        }
        current = "";
      }
    } else {
      // THINKING state
      const idx = current.indexOf(THINK_CLOSE);
      if (idx !== -1) {
        const before = current.substring(0, idx);
        if (before.length > 0) {
          events.push({ type: "thinking_delta", text: before, raw });
        }
        current = current.substring(idx + THINK_CLOSE.length);
        state.thinkFsm = "NORMAL";
      } else {
        // Check if the tail could be a partial `</think>` close tag
        const buffered = bufferPartialTag(current, THINK_CLOSE);
        if (buffered > 0) {
          state.tagBuffer = current.substring(current.length - buffered);
          const safe = current.substring(0, current.length - buffered);
          if (safe.length > 0) {
            events.push({ type: "thinking_delta", text: safe, raw });
          }
        } else {
          events.push({ type: "thinking_delta", text: current, raw });
        }
        current = "";
      }
    }
  }

  return events;
}

/**
 * Returns the number of characters at the end of `text` that match a
 * prefix of `tag`. Used to detect partial tags split across chunks.
 */
function bufferPartialTag(text: string, tag: string): number {
  const maxCheck = Math.min(tag.length - 1, text.length);
  for (let i = maxCheck; i > 0; i--) {
    if (text.endsWith(tag.substring(0, i))) {
      return i;
    }
  }
  return 0;
}

export function normalizeOpenAIStreamEvent(
  raw: unknown,
  state: OpenAIStreamState = createOpenAIStreamState(),
): CanonicalModelEvent[] {
  const chunk = asRecord(raw);
  const events: CanonicalModelEvent[] = [];

  if (!state.started) {
    state.started = true;
    events.push({ type: "message_start", role: "assistant", raw });
  }

  const usage = normalizeOpenAIUsage(chunk.usage);
  if (usage) {
    events.push({ type: "usage", usage, raw });
  }

  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  for (const choice of choices) {
    const choiceRecord = asRecord(choice);
    const delta = asRecord(choiceRecord.delta);

    if (typeof delta.content === "string" && delta.content.length > 0) {
      events.push(...splitThinkContent(delta.content, state, raw));
    }

    // Reasoning-model chain-of-thought comes in two non-standard fields:
    //   - `delta.reasoning`         — OpenRouter / DeepInfra / Parasail
    //   - `delta.reasoning_content` — DeepSeek native API (V4 series)
    const reasoning = delta.reasoning ?? delta.reasoning_content;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      events.push({ type: "thinking_delta", text: reasoning, raw });
    }

    // DeepSeek official API uses `reasoning_content` instead of `reasoning`.
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      events.push({ type: "thinking_delta", text: delta.reasoning_content, raw });
    }

    if (Array.isArray(delta.tool_calls)) {
      events.push(...toolCallEvents(delta.tool_calls, state, raw));
    }

    if (choiceRecord.finish_reason) {
      events.push(...finishToolCalls(state, raw));
      events.push({
        type: "message_end",
        finishReason: normalizeOpenAIFinishReason(choiceRecord.finish_reason),
        raw,
      });
    }
  }

  return events;
}

function toolCallEvents(
  deltas: unknown[],
  state: OpenAIStreamState,
  raw: unknown,
): CanonicalModelEvent[] {
  const events: CanonicalModelEvent[] = [];

  for (const delta of deltas) {
    const record = asRecord(delta);
    const index = typeof record.index === "number" ? record.index : 0;
    const fn = asRecord(record.function);
    const current = state.toolCalls.get(index) ?? {};

    if (typeof record.id === "string") {
      current.id = record.id;
    }
    if (typeof fn.name === "string") {
      current.name = fn.name;
    }

    if (!state.toolCalls.has(index)) {
      state.toolCalls.set(index, current);
      events.push({
        type: "tool_call_start",
        id: current.id ?? String(index),
        name: current.name ?? "",
        raw,
      });
    }

    if (typeof fn.arguments === "string") {
      current.argumentsBuffer = `${current.argumentsBuffer ?? ""}${fn.arguments}`;
      events.push({
        type: "tool_call_delta",
        id: current.id ?? String(index),
        delta: fn.arguments,
        raw,
      });
    }

    state.toolCalls.set(index, current);
  }

  return events;
}

function finishToolCalls(state: OpenAIStreamState, raw: unknown): CanonicalModelEvent[] {
  const events: CanonicalModelEvent[] = [];

  for (const [index, toolCall] of state.toolCalls.entries()) {
    const rawArguments = toolCall.argumentsBuffer ?? "{}";
    let input: unknown;
    try {
      input = JSON.parse(rawArguments);
    } catch {
      throw new ModelProviderError({
        provider: "openai",
        protocol: "openai",
        code: "invalid_tool_arguments",
        message: "OpenAI stream tool call arguments are not valid JSON.",
        retryable: false,
        raw,
      });
    }

    events.push({
      type: "tool_call_end",
      toolCall: {
        id: toolCall.id ?? String(index),
        name: toolCall.name ?? "",
        input,
        raw,
      },
      raw,
    });
  }

  state.toolCalls.clear();
  return events;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
