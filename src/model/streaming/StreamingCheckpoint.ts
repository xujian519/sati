import type { CanonicalModelEvent } from "../protocol/canonical.js";
import type { StreamInterruption } from "../protocol/errors.js";
import { hasTextToolCallSyntax } from "./parseTextToolCalls.js";

export interface StreamingCheckpoint {
  partialText: string;
  tokensReceived: number;
  hasToolCalls: boolean;
  hasReasoning: boolean;
  activeToolCalls: Map<string, { name: string; argumentChars: number }>;
}

/**
 * Lightweight tracker that accumulates partial assistant content from a
 * streaming model response. Used by the stream-retry logic in `streamModel`
 * to decide whether a mid-stream failure has enough partial content to
 * warrant a continuation retry (as opposed to a full from-scratch retry).
 *
 * Accumulation uses a parts array + lazy join instead of per-delta string
 * concatenation, so thousands of text_delta events do not trigger O(n²)
 * string copying.
 */
export class StreamingCheckpointManager {
  private parts: string[] = [];
  private nonWhitespaceChars = 0;
  private tokensReceived = 0;
  private hasToolCalls = false;
  private hasReasoning = false;
  private activeToolCalls = new Map<string, { name: string; argumentChars: number }>();

  onEvent(event: CanonicalModelEvent): void {
    switch (event.type) {
      case "text_delta":
        this.parts.push(event.text);
        this.nonWhitespaceChars += event.text.replace(WHITESPACE_RE, "").length;
        this.tokensReceived++;
        break;
      case "thinking_delta":
        this.hasReasoning = true;
        this.tokensReceived++;
        break;
      case "tool_call_start":
        this.hasToolCalls = true;
        this.activeToolCalls.set(event.id, { name: event.name, argumentChars: 0 });
        this.tokensReceived++;
        break;
      case "tool_call_delta": {
        this.hasToolCalls = true;
        const active = this.activeToolCalls.get(event.id) ?? { name: "", argumentChars: 0 };
        active.argumentChars += event.delta.length;
        this.activeToolCalls.set(event.id, active);
        this.tokensReceived++;
        break;
      }
      case "tool_call_end":
        this.hasToolCalls = true;
        this.activeToolCalls.delete(event.toolCall.id);
        this.tokensReceived++;
        break;
    }
  }

  get(): StreamingCheckpoint {
    return {
      partialText: this.parts.join(""),
      tokensReceived: this.tokensReceived,
      hasToolCalls: this.hasToolCalls,
      hasReasoning: this.hasReasoning,
      activeToolCalls: new Map(this.activeToolCalls),
    };
  }

  hasSubstantialContent(): boolean {
    // 与 partialText.trim().length > 0 等价：存在任一非空白字符即视为有实质内容。
    return this.nonWhitespaceChars > 0;
  }

  /** True when partial text is safe to continue: real text, no tool-call syntax, no reasoning. */
  canContinueText(): boolean {
    return (
      this.hasSubstantialContent() &&
      !hasTextToolCallSyntax(this.parts.join("")) &&
      !this.hasReasoning &&
      !this.hasToolCalls
    );
  }

  /** Safe metadata about how the stream ended. Tool argument text is never retained. */
  interruption(): StreamInterruption {
    const activeToolCalls = [...this.activeToolCalls.entries()].map(([id, call]) => ({ id, ...call }));
    if (this.hasToolCalls) {
      return { phase: "tool_call", activeToolCalls };
    }
    if (this.nonWhitespaceChars > 0) {
      return { phase: "text" };
    }
    if (this.hasReasoning) {
      return { phase: "reasoning" };
    }
    return { phase: "empty" };
  }

  reset(): void {
    this.parts = [];
    this.nonWhitespaceChars = 0;
    this.tokensReceived = 0;
    this.hasToolCalls = false;
    this.hasReasoning = false;
    this.activeToolCalls = new Map();
  }
}

const WHITESPACE_RE = /\s/g;
