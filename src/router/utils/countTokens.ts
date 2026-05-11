import type { CanonicalMessage, CanonicalModelEvent } from "../../model/index.js";

let _encoding: import("tiktoken").Tiktoken | null | undefined;

function getEncoding(): import("tiktoken").Tiktoken | null {
  if (_encoding !== undefined) return _encoding;
  try {
    const { get_encoding } = require("tiktoken") as typeof import("tiktoken");
    _encoding = get_encoding("cl100k_base");
    return _encoding;
  } catch {
    _encoding = null;
    return null;
  }
}

export function countTokens(text: string): number {
  const enc = getEncoding();
  if (enc) {
    try {
      return enc.encode(text).length;
    } catch { /* fall through */ }
  }
  return Math.ceil(text.length / 3);
}

export function countMessagesTokens(messages: CanonicalMessage[]): number {
  const chunks: string[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          chunks.push(block.text);
          break;
        case "tool_call":
          if (block.input !== undefined) {
            chunks.push(typeof block.input === "string" ? block.input : JSON.stringify(block.input));
          }
          break;
        case "tool_result":
          for (const tb of block.content) {
            chunks.push(tb.text);
          }
          break;
      }
    }
  }
  return countTokens(chunks.join("\n"));
}

export function countResponseTokens(events: CanonicalModelEvent[]): number {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.type === "text_delta") {
      chunks.push(event.text);
    } else if (event.type === "thinking_delta") {
      chunks.push(event.text);
    } else if (event.type === "tool_call_delta") {
      chunks.push(event.delta);
    }
  }
  if (chunks.length === 0) return 0;
  return countTokens(chunks.join(""));
}

export function dispose(): void {
  if (_encoding) {
    try { _encoding.free(); } catch { /* ok */ }
    _encoding = null;
  }
}
