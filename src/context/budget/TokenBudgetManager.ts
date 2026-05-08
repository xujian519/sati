import type { CanonicalContentBlock, CanonicalMessage } from "../../model/index.js";

export type TokenWarningState = "ok" | "warning" | "blocking";

export type TokenBudgetSnapshot = {
  tokens: number;
  maxContextTokens: number;
  warningRatio: number;
  blockingRatio: number;
  state: TokenWarningState;
  ratio: number;
};

export type TokenBudgetManagerOptions = {
  /** Decision §3.2 — char/4 estimator (legacy default). */
  bytesPerToken?: number;
  /** Image / pdf placeholder size (legacy IMAGE_MAX_TOKEN_SIZE = 2000). */
  multimediaTokens?: number;
  /** Auto-compact / warning threshold (legacy ~80%). */
  warningRatio?: number;
  /** Hard blocking threshold (legacy ~95%). */
  blockingRatio?: number;
};

const DEFAULT_BYTES_PER_TOKEN = 4;
const DEFAULT_MULTIMEDIA_TOKENS = 2_000;
const DEFAULT_WARNING_RATIO = 0.8;
const DEFAULT_BLOCKING_RATIO = 0.95;

/**
 * Char/4 token estimator. Mirrors legacy `roughTokenCountEstimation`:
 *   text content                 → ceil(length / bytesPerToken)
 *   JSON-ish tool args            → ceil(length / 2)  (handled by callers)
 *   image / pdf blocks            → fixed multimediaTokens
 *   tool_call / tool_result_text  → counted via included text
 */
export class TokenBudgetManager {
  private readonly bytesPerToken: number;
  private readonly multimediaTokens: number;
  private readonly warningRatio: number;
  private readonly blockingRatio: number;

  constructor(options: TokenBudgetManagerOptions = {}) {
    this.bytesPerToken = options.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN;
    this.multimediaTokens = options.multimediaTokens ?? DEFAULT_MULTIMEDIA_TOKENS;
    this.warningRatio = options.warningRatio ?? DEFAULT_WARNING_RATIO;
    this.blockingRatio = options.blockingRatio ?? DEFAULT_BLOCKING_RATIO;
  }

  estimateTextTokens(text: string): number {
    if (text.length === 0) return 0;
    return Math.ceil(text.length / this.bytesPerToken);
  }

  estimateBlockTokens(block: CanonicalContentBlock): number {
    switch (block.type) {
      case "text":
      case "thinking":
        return this.estimateTextTokens(block.text);
      case "image":
      case "pdf":
      case "audio":
        return this.multimediaTokens;
      case "tool_call":
        return this.estimateTextTokens(JSON.stringify(block.input ?? {})) + this.estimateTextTokens(block.name);
      case "tool_result":
        return block.content.reduce((sum, item) => sum + this.estimateTextTokens(item.text), 0);
      case "tool_result_reference":
        return this.estimateTextTokens(block.preview);
    }
  }

  estimateMessagesTokens(messages: CanonicalMessage[]): number {
    let total = 0;
    for (const message of messages) {
      // message overhead — legacy adds a constant per role; approximate by 4 tokens.
      total += 4;
      for (const block of message.content) {
        total += this.estimateBlockTokens(block);
      }
    }
    return total;
  }

  evaluate(messages: CanonicalMessage[], maxContextTokens: number): TokenBudgetSnapshot {
    const tokens = this.estimateMessagesTokens(messages);
    const ratio = maxContextTokens > 0 ? tokens / maxContextTokens : 0;
    let state: TokenWarningState = "ok";
    if (ratio >= this.blockingRatio) {
      state = "blocking";
    } else if (ratio >= this.warningRatio) {
      state = "warning";
    }
    return {
      tokens,
      maxContextTokens,
      warningRatio: this.warningRatio,
      blockingRatio: this.blockingRatio,
      state,
      ratio,
    };
  }
}
