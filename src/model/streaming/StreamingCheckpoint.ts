import type { CanonicalModelEvent } from "../protocol/canonical.js";

export interface StreamingCheckpoint {
  partialText: string;
  tokensReceived: number;
  hasToolCalls: boolean;
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

  onEvent(event: CanonicalModelEvent): void {
    switch (event.type) {
      case "text_delta":
        this.parts.push(event.text);
        this.nonWhitespaceChars += event.text.replace(WHITESPACE_RE, "").length;
        this.tokensReceived++;
        break;
      case "thinking_delta":
        this.tokensReceived++;
        break;
      case "tool_call_start":
      case "tool_call_delta":
      case "tool_call_end":
        this.hasToolCalls = true;
        this.tokensReceived++;
        break;
    }
  }

  get(): StreamingCheckpoint {
    return {
      partialText: this.parts.join(""),
      tokensReceived: this.tokensReceived,
      hasToolCalls: this.hasToolCalls,
    };
  }

  hasSubstantialContent(): boolean {
    // 与 partialText.trim().length > 0 等价：存在任一非空白字符即视为有实质内容。
    return this.nonWhitespaceChars > 0;
  }

  reset(): void {
    this.parts = [];
    this.nonWhitespaceChars = 0;
    this.tokensReceived = 0;
    this.hasToolCalls = false;
  }
}

const WHITESPACE_RE = /\s/g;
