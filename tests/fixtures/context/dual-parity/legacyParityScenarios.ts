/**
 * Dual-parity scenarios for the context module.
 *
 * Legacy reference: `third-party/claude-code-main/src/{services,utils}/...`.
 * The legacy package cannot be imported directly (Bun-bundled, runtime deps),
 * so each scenario inlines the legacy expected output **derived from the
 * legacy source** (verified at the line numbers cited below). Updating the
 * legacy source requires bumping the cited line numbers and re-running these
 * tests.
 *
 * Every scenario carries:
 *   - id: stable identifier
 *   - parityStatus: "compare" (must match) | "intentional_difference" (with reason) | "deferred"
 *   - reason: required for non-compare entries
 *   - source: legacy source path + line range used to derive the expected behavior
 */

export type ParityStatus = "compare" | "intentional_difference" | "deferred";

export type ParityScenario = {
  id: string;
  parityStatus: ParityStatus;
  reason?: string;
  source: string;
};

export type RoughTokenScenario = ParityScenario & {
  kind: "rough_token";
  bytesPerToken: number;
  text: string;
  expectedTokens: number;
};

export type CompactBoundarySliceScenario = ParityScenario & {
  kind: "compact_boundary_slice";
  /** Expected: index of the LAST compact_boundary in the entry list. */
  entries: Array<{ type: "user" | "assistant" | "compact_boundary" | "turn_result"; tag: string }>;
  expectedBoundaryIndex: number;
};

export type PostCompactOrderScenario = ParityScenario & {
  kind: "post_compact_order";
  hasSummary: boolean;
  hasAttachments: boolean;
  hasHooks: boolean;
  expectedTags: string[];
};

export type TruncateHeadScenario = ParityScenario & {
  kind: "truncate_head";
  count: number;
  keepRatio: number;
  expectedKeptTags: string[];
};

export type PtlClassificationScenario = ParityScenario & {
  kind: "ptl_classification";
  protocol: "anthropic" | "openai";
  message: string;
  status?: number;
  expectedCode: string;
  expectedRecoverableViaCompact: boolean;
};

export type Scenario =
  | RoughTokenScenario
  | CompactBoundarySliceScenario
  | PostCompactOrderScenario
  | TruncateHeadScenario
  | PtlClassificationScenario;

export const ROUGH_TOKEN_SCENARIOS: RoughTokenScenario[] = [
  {
    id: "rough_token_empty",
    kind: "rough_token",
    parityStatus: "intentional_difference",
    reason: "TokenBudgetManager now uses tiktoken (o200k_base) instead of char/N; empty string still yields 0",
    source: "third-party/claude-code-main/src/services/tokenEstimation.ts:203-207",
    bytesPerToken: 4,
    text: "",
    expectedTokens: 0,
  },
  {
    id: "rough_token_short_text",
    kind: "rough_token",
    parityStatus: "intentional_difference",
    reason: "TokenBudgetManager now uses tiktoken (o200k_base) instead of char/N",
    source: "third-party/claude-code-main/src/services/tokenEstimation.ts:203-207",
    bytesPerToken: 4,
    text: "abcd",
    expectedTokens: 1,
  },
  {
    id: "rough_token_long_text",
    kind: "rough_token",
    parityStatus: "intentional_difference",
    reason: "TokenBudgetManager now uses tiktoken (o200k_base) instead of char/N",
    source: "third-party/claude-code-main/src/services/tokenEstimation.ts:203-207",
    bytesPerToken: 4,
    text: "x".repeat(100),
    expectedTokens: 25,
  },
  {
    id: "rough_token_json_uses_2",
    kind: "rough_token",
    parityStatus: "intentional_difference",
    reason: "TokenBudgetManager now uses tiktoken (o200k_base); ext-based bytesPerToken no longer used",
    source: "third-party/claude-code-main/src/services/tokenEstimation.ts (JSON path uses bytesPerToken=2)",
    bytesPerToken: 2,
    text: '{"a":1,"b":2}',
    expectedTokens: 7,
  },
];

export const COMPACT_BOUNDARY_SCENARIOS: CompactBoundarySliceScenario[] = [
  {
    id: "boundary_no_compact",
    kind: "compact_boundary_slice",
    parityStatus: "compare",
    source: "third-party/claude-code-main/src/utils/messages.ts (findLastCompactBoundaryIndex)",
    entries: [
      { type: "user", tag: "u1" },
      { type: "assistant", tag: "a1" },
      { type: "user", tag: "u2" },
    ],
    expectedBoundaryIndex: -1,
  },
  {
    id: "boundary_single",
    kind: "compact_boundary_slice",
    parityStatus: "compare",
    source: "third-party/claude-code-main/src/utils/messages.ts (findLastCompactBoundaryIndex)",
    entries: [
      { type: "user", tag: "before-1" },
      { type: "compact_boundary", tag: "B" },
      { type: "user", tag: "after-1" },
    ],
    expectedBoundaryIndex: 1,
  },
  {
    id: "boundary_multiple_uses_last",
    kind: "compact_boundary_slice",
    parityStatus: "compare",
    source: "third-party/claude-code-main/src/utils/messages.ts (findLastCompactBoundaryIndex returns last)",
    entries: [
      { type: "user", tag: "before-1" },
      { type: "compact_boundary", tag: "B1" },
      { type: "user", tag: "between" },
      { type: "compact_boundary", tag: "B2" },
      { type: "user", tag: "after" },
    ],
    expectedBoundaryIndex: 3,
  },
];

export const POST_COMPACT_ORDER_SCENARIOS: PostCompactOrderScenario[] = [
  {
    id: "post_compact_full_order",
    kind: "post_compact_order",
    parityStatus: "compare",
    source: "third-party/claude-code-main/src/services/compact/compact.ts:326-337 (buildPostCompactMessages)",
    hasSummary: true,
    hasAttachments: true,
    hasHooks: true,
    expectedTags: ["B", "S", "K", "A", "H"],
  },
  {
    id: "post_compact_no_summary",
    kind: "post_compact_order",
    parityStatus: "compare",
    source: "third-party/claude-code-main/src/services/compact/compact.ts:326-337 (buildPostCompactMessages)",
    hasSummary: false,
    hasAttachments: true,
    hasHooks: true,
    expectedTags: ["B", "K", "A", "H"],
  },
  {
    id: "post_compact_minimal",
    kind: "post_compact_order",
    parityStatus: "compare",
    source: "third-party/claude-code-main/src/services/compact/compact.ts:326-337 (buildPostCompactMessages)",
    hasSummary: false,
    hasAttachments: false,
    hasHooks: false,
    expectedTags: ["B", "K"],
  },
];

export const TRUNCATE_HEAD_SCENARIOS: TruncateHeadScenario[] = [
  {
    id: "truncate_head_first_attempt_50",
    kind: "truncate_head",
    parityStatus: "compare",
    source: "third-party/claude-code-main/src/services/compact/compact.ts (truncateHeadForPTLRetry)",
    count: 8,
    keepRatio: 0.5,
    expectedKeptTags: ["m4", "m5", "m6", "m7"],
  },
  {
    id: "truncate_head_aggressive_25",
    kind: "truncate_head",
    parityStatus: "compare",
    source: "third-party/claude-code-main/src/services/compact/compact.ts (truncateHeadForPTLRetry)",
    count: 8,
    keepRatio: 0.25,
    expectedKeptTags: ["m6", "m7"],
  },
  {
    id: "truncate_head_floor_at_one",
    kind: "truncate_head",
    parityStatus: "compare",
    source: "third-party/claude-code-main/src/services/compact/compact.ts (PilotDeck floor=1)",
    count: 3,
    keepRatio: 0.1,
    expectedKeptTags: ["m2"],
  },
];

export const PTL_CLASSIFICATION_SCENARIOS: PtlClassificationScenario[] = [
  {
    id: "ptl_anthropic_message",
    kind: "ptl_classification",
    parityStatus: "compare",
    source: "third-party/claude-code-main/src/services/api/errors.ts:560-573",
    protocol: "anthropic",
    message: "messages.0: Prompt is too long: 250000 tokens > 200000 maximum",
    expectedCode: "prompt_too_long",
    expectedRecoverableViaCompact: true,
  },
  {
    id: "ptl_anthropic_vertex_413",
    kind: "ptl_classification",
    parityStatus: "compare",
    source: "third-party/claude-code-main/src/services/api/errors.ts:560-573",
    protocol: "anthropic",
    message: "Prompt is too long",
    status: 413,
    expectedCode: "prompt_too_long",
    expectedRecoverableViaCompact: true,
  },
  {
    id: "ptl_openai_context_limit",
    kind: "ptl_classification",
    parityStatus: "compare",
    source: "third-party/claude-code-main/src/router/.../withRetry.ts (input length and max_tokens exceed context limit)",
    protocol: "openai",
    message: "Bad Request: input length and max_tokens exceed context limit: 100000 < 130000",
    expectedCode: "prompt_too_long",
    expectedRecoverableViaCompact: true,
  },
  {
    id: "request_too_large_separate",
    kind: "ptl_classification",
    parityStatus: "compare",
    source: "third-party/claude-code-main/src/services/api/errors.ts (Request too large branch)",
    protocol: "anthropic",
    message: "Request too large",
    expectedCode: "request_too_large",
    expectedRecoverableViaCompact: false,
  },
];

export const ALL_SCENARIOS: Scenario[] = [
  ...ROUGH_TOKEN_SCENARIOS,
  ...COMPACT_BOUNDARY_SCENARIOS,
  ...POST_COMPACT_ORDER_SCENARIOS,
  ...TRUNCATE_HEAD_SCENARIOS,
  ...PTL_CLASSIFICATION_SCENARIOS,
];
