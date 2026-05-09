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
  /** Decision §3.2 — char/4 estimator (legacy default, see T1 in §4.2). */
  bytesPerToken?: number;
  /** Image / pdf placeholder size (legacy IMAGE_MAX_TOKEN_SIZE = 2000, T6/T7). */
  multimediaTokens?: number;
  /** Auto-compact / warning threshold (legacy ~80%). */
  warningRatio?: number;
  /** Hard blocking threshold (legacy ~95%). */
  blockingRatio?: number;
  /**
   * Per-message overhead added by `estimateForMessage` to mirror legacy
   * `estimateMessageTokens` cost of role/wrapper boilerplate (legacy charges
   * roughly 4 tokens). T11 in §4.2.
   */
  perMessageOverhead?: number;
};

const DEFAULT_BYTES_PER_TOKEN = 4;
/**
 * IMAGE_MAX_TOKEN_SIZE — exported so callers (compaction, projection) can
 * reason about the upper bound without instantiating a manager. Matches
 * `third-party/claude-code-main/src/services/tokenEstimation.ts:IMAGE_MAX_TOKEN_SIZE`.
 */
export const IMAGE_MAX_TOKEN_SIZE = 2_000;
const DEFAULT_WARNING_RATIO = 0.8;
const DEFAULT_BLOCKING_RATIO = 0.95;
const DEFAULT_PER_MESSAGE_OVERHEAD = 4;

/**
 * Padding factor applied by `estimateForMessagesWithPadding`. Mirrors
 * legacy `roughTokenCountEstimationForMessages` which multiplies by 4/3
 * to reserve headroom for tokenizer drift between estimator and provider.
 * Source: `tokenEstimation.ts:225-227`.
 */
const ROUGH_PADDING_NUMERATOR = 4;
const ROUGH_PADDING_DENOMINATOR = 3;

/**
 * File-extension-aware bytes-per-token. Legacy `bytesPerTokenForFileType`
 * uses 2 for JSON-shaped data (tighter encoding) and 4 for everything
 * else. Match the legacy lowercase set verbatim. Behaviour T2 in §4.2.
 */
const JSON_LIKE_EXTENSIONS = new Set<string>([
  "json",
  "ndjson",
  "geojson",
  "jsonl",
  "yaml",
  "yml",
]);

export function bytesPerTokenForExt(ext: string | undefined | null): number {
  if (!ext) return DEFAULT_BYTES_PER_TOKEN;
  const lower = ext.replace(/^\./, "").toLowerCase();
  return JSON_LIKE_EXTENSIONS.has(lower) ? 2 : DEFAULT_BYTES_PER_TOKEN;
}

/**
 * Char/N token estimator. Mirrors legacy `roughTokenCountEstimation`
 * (tokenEstimation.ts:203-207):
 *   text content                 → round(length / bytesPerToken)
 *   JSON-ish file content         → round(length / 2)  via bytesPerTokenForExt
 *   image / pdf / audio blocks    → fixed multimediaTokens (= 2000)
 *   tool_call                     → round((name + JSON.stringify(input)) / 4)
 *   tool_result                   → sum of inner text estimates
 *   tool_result_reference         → round(preview / 4)  (PilotDeck-only block)
 *   thinking                      → round(text / 4)
 *
 * Behaviour alignment:
 *   T1 round (not ceil) at the leaf; matches legacy.
 *   T2 ext-aware bytesPerTokenForExt for file-type-specific budgets.
 *   T3 estimateForFileType clamps and routes through the ext map.
 *   T4 estimateForBlock branches on canonical block.type (8 PilotDeck blocks).
 *   T5 thinking blocks count text only (not signature; signature is opaque
 *      provider data, billed by provider not estimator).
 *   T6 image and T7 pdf use a fixed IMAGE_MAX_TOKEN_SIZE = 2000.
 *   T8 audio mirrors image: fixed multimediaTokens (PilotDeck-specific block;
 *      legacy lacks audio so this is intentional_difference).
 *   T9 tool_call concatenates name + serialized input as one string before
 *      round (legacy: `roughTokenCountEstimationForBlock` for tool_use).
 *   T10 tool_result recurses inner CanonicalTextBlock entries.
 *   T11 estimateForMessage adds perMessageOverhead (default 4) per message.
 *   T12 estimateForMessagesWithPadding multiplies by 4/3 (round up).
 *   T13 tool_result_reference uses preview only (intentional_difference;
 *       no legacy equivalent).
 */
export class TokenBudgetManager {
  private readonly bytesPerToken: number;
  private readonly multimediaTokens: number;
  private readonly warningRatio: number;
  private readonly blockingRatio: number;
  private readonly perMessageOverhead: number;

  constructor(options: TokenBudgetManagerOptions = {}) {
    this.bytesPerToken = options.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN;
    this.multimediaTokens = options.multimediaTokens ?? IMAGE_MAX_TOKEN_SIZE;
    this.warningRatio = options.warningRatio ?? DEFAULT_WARNING_RATIO;
    this.blockingRatio = options.blockingRatio ?? DEFAULT_BLOCKING_RATIO;
    this.perMessageOverhead = options.perMessageOverhead ?? DEFAULT_PER_MESSAGE_OVERHEAD;
  }

  /**
   * T1: char-count / bytesPerToken with `Math.round`. Matches legacy
   * `roughTokenCountEstimation` exactly.
   */
  estimateTextTokens(text: string): number {
    if (text.length === 0) return 0;
    return Math.round(text.length / this.bytesPerToken);
  }

  /**
   * T2/T3: estimate for raw file content given a file extension or mime
   * hint. JSON-like extensions use bytesPerToken=2.
   */
  estimateForFileType(content: string, ext: string | null | undefined): number {
    if (content.length === 0) return 0;
    const bpt = bytesPerTokenForExt(ext);
    return Math.round(content.length / bpt);
  }

  /** T4: per-block estimate. Public alias retained for legacy callers. */
  estimateBlockTokens(block: CanonicalContentBlock): number {
    return this.estimateForBlock(block);
  }

  estimateForBlock(block: CanonicalContentBlock): number {
    switch (block.type) {
      case "text":
        // T1 leaf application.
        return this.estimateTextTokens(block.text);
      case "thinking":
        // T5: text only; signature is provider-opaque metadata.
        return this.estimateTextTokens(block.text);
      case "image":
        // T6.
        return this.multimediaTokens;
      case "pdf":
        // T7.
        return this.multimediaTokens;
      case "audio":
        // T8: PilotDeck-specific. Legacy lacks audio blocks
        // (intentional_difference, see §4.2 footnote).
        return this.multimediaTokens;
      case "tool_call": {
        // T9: legacy concatenates name + JSON args before counting.
        const serialized = `${block.name}${safeJsonStringify(block.input)}`;
        return this.estimateTextTokens(serialized);
      }
      case "tool_result":
        // T10: recurse inner text-only blocks.
        return block.content.reduce(
          (sum, item) => sum + this.estimateTextTokens(item.text),
          0,
        );
      case "tool_result_reference":
        // T13: PilotDeck-only block; preview only.
        return this.estimateTextTokens(block.preview);
    }
  }

  /** T11: per-message estimate including overhead. */
  estimateForMessage(message: CanonicalMessage): number {
    let total = this.perMessageOverhead;
    for (const block of message.content) {
      total += this.estimateForBlock(block);
    }
    return total;
  }

  /**
   * Sum of `estimateForMessage` across every message. Backwards-compat
   * alias `estimateMessagesTokens` is kept — both now use the same
   * per-message accounting (overhead included).
   */
  estimateForMessages(messages: CanonicalMessage[]): number {
    let total = 0;
    for (const message of messages) {
      total += this.estimateForMessage(message);
    }
    return total;
  }

  estimateMessagesTokens(messages: CanonicalMessage[]): number {
    return this.estimateForMessages(messages);
  }

  /**
   * T12: padded estimate (4/3 multiplier, ceil) used by warning / compaction
   * gates. Conservative upper bound that survives drift between our
   * estimator and the provider's tokenizer.
   */
  estimateForMessagesWithPadding(messages: CanonicalMessage[]): number {
    const raw = this.estimateForMessages(messages);
    if (raw === 0) return 0;
    return Math.ceil((raw * ROUGH_PADDING_NUMERATOR) / ROUGH_PADDING_DENOMINATOR);
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

/**
 * Stable JSON for token counting. Returns "" for undefined / null / circular
 * inputs (legacy: an unset tool_use input still costs the name string only).
 */
function safeJsonStringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
