import { randomUUID } from "node:crypto";
import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalUsage,
} from "../../model/index.js";
import type { TokenAccountingRuntime } from "../budget/TokenAccountingRuntime.js";
import { TokenBudgetManager } from "../budget/TokenBudgetManager.js";
import type { ContextDiagnostic } from "../protocol/types.js";
import type { AgentEventEmitter } from "../../agent/protocol/events.js";
import {
  collectToolCallIds,
  collectToolResultIds,
  ensureTrailingUserMessage,
  isRealUserRequestMessage,
  stripUnpairedToolCalls,
  stripUnpairedToolResults,
} from "./toolPairIntegrity.js";
import { collectToolNamesByCallId, protectedToolNameSet } from "./protectedContext.js";
import {
  collectProtectedGroupIndexes,
  findTailStartTurn,
  moveTailBoundaryBeforeProtectedRequest,
  splitMessagesIntoCompactionGroups,
} from "./compactionGroups.js";
import {
  buildMarkdownSummarySystemPrompt,
  buildMarkdownSummaryUserPrompt,
  COMPACT_SUMMARY_PREFIX,
  validateSummaryMarkdownStructure,
  wrapSummaryMessage,
} from "./summaryBuilders.js";
import { buildDeterministicFallbackSummary } from "./summaryFallback.js";
import { projectMessagesForSummary, projectOversizedRetainedToolResults } from "./summaryInput.js";
import { buildCompactSummaryAnchors } from "./summaryAnchors.js";

export type CompactionTrigger = "manual" | "auto" | "reactive";

export type CompactionEngineOptions = {
  /**
   * AgentLoop-supplied model runtime. CompactionEngine **does not** sit inside
   * `ContextRuntime`; the loop owns this dependency (decision §3.2).
   */
  model: { stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent> };
  tokenBudget?: TokenBudgetManager;
  tokenAccounting?: TokenAccountingRuntime;
  /** Optional lifecycle dispatcher (PreCompact / PostCompact). */
  lifecycle?: {
    dispatch(input: { event: "PreCompact" | "PostCompact"; payload: Record<string, unknown> }): void | Promise<void>;
  };
  /** Provider id forwarded to `stream()`. */
  provider: string;
  /** Model id forwarded to `stream()`. */
  model_: string;
  /** Optional summary system prompt override (default: cache-friendly rubric). */
  systemPrompt?: string;
  /** Max output tokens for the summary call (legacy default 20_000). */
  maxOutputTokens?: number;
  /** Tool names whose turns should be preserved verbatim across full compaction. */
  protectedToolNames?: Iterable<string>;
  now?: () => Date;
  /** Stable identity factory for correlating live and persisted compaction events. */
  uuid?: () => string;
  eventEmitter?: AgentEventEmitter;
};

export const COMPACT_SYSTEM_PROMPT_DEFAULT =
  "You are a conversation summarizer for a coding agent. Your summary will replace " +
  "the early conversation history, so it MUST preserve all information the agent " +
  "needs to continue working without repeating past steps.";
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000;

const COMPACT_SUMMARY_FAILURE_COOLDOWN_MS = 60_000;

export type CompactionResult = {
  /** Stable identity shared by live and persisted representations of this pass. */
  compactionId: string;
  trigger: CompactionTrigger;
  preTokens: number;
  postTokens?: number;
  /** Number of messages actually summarized by this compaction pass. */
  messagesSummarized: number;
  /**
   * 被遮蔽（摘要替代）消息在压缩输入 messages 中的原始索引（升序）。
   * 供 transcript 持久化 shadowedRanges 使用——压缩不删历史，只遮蔽；
   * 重放可据此恢复被摘要替代的完整原文（对应 dsh surface replace 语义）。
   */
  shadowedMessageIndexes?: number[];
  summaryMessage?: CanonicalMessage;
  boundaryMarker: CanonicalMessage;
  /** Messages preserved verbatim across the boundary (kept tail). */
  messagesToKeep: CanonicalMessage[];
  /** Attachments to be re-injected post-compact (memory / hooks). */
  attachments: CanonicalMessage[];
  /** Hook output messages to follow the attachments. */
  hookResults: CanonicalMessage[];
  diagnostics: ContextDiagnostic[];
  error?: string;
};

export type CompactionInput = {
  trigger: CompactionTrigger;
  messages: CanonicalMessage[];
  /** Optional ratio of messages to preserve verbatim past the boundary. */
  keepTailRatio?: number;
  /** Override protected tool names for this compaction pass; null disables protection. */
  protectedToolNames?: Iterable<string> | null;
  /** Provider summarize prompt addition (e.g. "user wants you to focus on X"). */
  userInstruction?: string;
  /** Free-form attachments to fold into post-compact messages. */
  attachments?: CanonicalMessage[];
  /** Hook output messages to fold in after attachments (decision §3.1 #9 order). */
  hookResults?: CanonicalMessage[];
  signal?: AbortSignal;
  sessionId?: string;
  turnId?: string;
};

const DEFAULT_KEEP_TAIL_RATIO = 0.35;
const DEFAULT_MIN_TAIL_MESSAGES = 3;
const RELAXED_MIN_TAIL_MESSAGES = 1;

/**
 * Owned by `AgentLoop`, not by `ContextRuntime`. Performs the second model
 * call required to summarize a conversation, writes the summary message and
 * boundary marker, and assembles `buildPostCompactMessages` in legacy order
 * (decision §3.1 #9).
 */
export class CompactionEngine {
  private readonly tokenBudget: TokenBudgetManager;
  private readonly options: CompactionEngineOptions;
  private readonly protectedToolNames: ReadonlySet<string>;
  private summaryFailureCooldownUntil = 0;
  private summaryFailureError?: string;

  constructor(options: CompactionEngineOptions) {
    this.options = options;
    this.tokenBudget = options.tokenBudget ?? new TokenBudgetManager();
    this.protectedToolNames = protectedToolNameSet(options.protectedToolNames);
  }

  async run(input: CompactionInput): Promise<CompactionResult> {
    const compactionId = this.options.uuid?.() ?? randomUUID();
    const preTokens = this.estimateMessages(input.messages);
    const tailRatio = clamp(input.keepTailRatio ?? DEFAULT_KEEP_TAIL_RATIO, 0, 1);
    const tailTokenBudget = Math.max(1, Math.floor(preTokens * tailRatio));
    const protectedToolNames =
      input.protectedToolNames === null ? new Set<string>() : (input.protectedToolNames ?? this.protectedToolNames);
    const minTailMessages = input.protectedToolNames === null ? RELAXED_MIN_TAIL_MESSAGES : DEFAULT_MIN_TAIL_MESSAGES;
    const compactPlan = planFullCompactionMessages(
      input.messages,
      tailTokenBudget,
      protectedToolNames,
      minTailMessages,
      turnMessages => this.estimateMessages(turnMessages),
    );
    const messagesToSummarize = compactPlan.messagesToSummarize;
    const retainedTailExceededBudget = this.estimateMessages(compactPlan.messagesToKeep) > tailTokenBudget;
    const messagesToKeep = retainedTailExceededBudget
      ? projectOversizedRetainedToolResults(compactPlan.messagesToKeep, collectToolNamesByCallId(input.messages))
      : compactPlan.messagesToKeep;

    await this.options.lifecycle?.dispatch({
      event: "PreCompact",
      payload: {
        trigger: input.trigger,
        preTokens,
        messagesSummarized: messagesToSummarize.length,
      },
    });
    this.options.eventEmitter?.({
      type: "compact_started",
      sessionId: input.sessionId ?? "",
      turnId: input.turnId ?? "",
      compactionId,
      trigger: input.trigger,
      preTokens,
    });

    let summaryMessage: CanonicalMessage | undefined;
    let summaryError: string | undefined;
    let summaryUsage: CanonicalUsage | undefined;

    if (messagesToSummarize.length === 0) {
      // Nothing to summarize: still emit a boundary so the transcript captures
      // the intent, but no model call happens.
    } else {
      const summaryAnchors =
        input.protectedToolNames === null
          ? buildCompactSummaryAnchors(messagesToSummarize, this.protectedToolNames)
          : undefined;
      const summaryInput = projectMessagesForSummary(messagesToSummarize);
      if (this.isSummaryFailureCooldownActive()) {
        summaryError = this.summaryFailureError ?? "context summary is in cooldown";
        summaryMessage = buildDeterministicFallbackSummary(messagesToSummarize, summaryError);
      } else {
        try {
          const result = await this.summarize(summaryInput, input.userInstruction, input.signal, summaryAnchors);
          summaryMessage = wrapSummaryMessage(result.message);
          summaryUsage = result.usage;
          this.summaryFailureCooldownUntil = 0;
          this.summaryFailureError = undefined;
        } catch (error) {
          summaryError = error instanceof Error ? error.message : String(error);
          this.summaryFailureCooldownUntil = Date.now() + COMPACT_SUMMARY_FAILURE_COOLDOWN_MS;
          this.summaryFailureError = summaryError;
          summaryMessage = buildDeterministicFallbackSummary(messagesToSummarize, summaryError);
        }
      }
    }

    const boundaryMarker = this.createBoundaryMarker({
      trigger: input.trigger,
      preTokens,
      messagesSummarized: messagesToSummarize.length,
      summarySucceeded: summaryError === undefined,
    });

    const diagnostics: ContextDiagnostic[] = summaryError
      ? [
          {
            code: "compact_summary_failed",
            severity: "warning" as const,
            message: summaryError,
          },
          {
            code: "compact_summary_fallback_used",
            severity: "warning" as const,
            message:
              "A deterministic fallback summary was used because the LLM summary call failed or is cooling down.",
          },
        ]
      : summaryMessage
        ? validateSummaryMarkdownStructure(summaryMessage)
        : [];
    if (retainedTailExceededBudget && messagesToKeep !== compactPlan.messagesToKeep) {
      diagnostics.push({
        code: "compact_retained_tool_output_truncated",
        severity: "warning",
        message:
          "Oversized retained tool output was replaced with a bounded preview so the compacted context can fit the tail budget.",
      });
    }

    const result: CompactionResult = {
      compactionId,
      trigger: input.trigger,
      preTokens,
      messagesSummarized: messagesToSummarize.length,
      shadowedMessageIndexes: compactPlan.shadowedMessageIndexes,
      summaryMessage,
      boundaryMarker,
      messagesToKeep,
      attachments: input.attachments ?? [],
      hookResults: input.hookResults ?? [],
      diagnostics,
      error: summaryError,
    };

    if (summaryMessage) {
      result.postTokens = this.estimateMessages(buildPostCompactMessages(result));
    }

    await this.options.lifecycle?.dispatch({
      event: "PostCompact",
      payload: {
        trigger: input.trigger,
        status: summaryError ? "fallback" : "success",
        error: summaryError,
        preTokens,
        postTokens: result.postTokens,
        summaryUsage,
      },
    });
    this.options.eventEmitter?.({
      type: "compact_completed",
      sessionId: input.sessionId ?? "",
      turnId: input.turnId ?? "",
      compactionId,
      trigger: input.trigger,
      status: summaryError ? "fallback" : "success",
      preTokens,
      postTokens: result.postTokens,
      messagesSummarized: messagesToSummarize.length,
    });

    return result;
  }

  private estimateMessages(messages: CanonicalMessage[]): number {
    return (
      this.options.tokenAccounting?.estimateMessages(messages) ?? this.tokenBudget.estimateMessagesTokens(messages)
    );
  }

  private async summarize(
    messages: CanonicalMessage[],
    userInstruction: string | undefined,
    signal: AbortSignal | undefined,
    summaryAnchors: string | undefined,
  ): Promise<{ message: CanonicalMessage; usage?: CanonicalUsage }> {
    const trailingPrompt: CanonicalMessage = {
      role: "user",
      metadata: {
        synthetic: true,
        purpose: "context-summary-control",
      },
      content: [
        {
          type: "text",
          text: buildMarkdownSummaryUserPrompt(userInstruction, summaryAnchors),
        },
      ],
    };
    const request: CanonicalModelRequest = {
      provider: this.options.provider,
      model: this.options.model_,
      messages: [...messages, trailingPrompt],
      // Custom and default prompts both funnel through the same rubric builder
      // so runtime intent-isolation constraints always apply.
      systemPrompt: buildMarkdownSummarySystemPrompt(this.options.systemPrompt ?? COMPACT_SYSTEM_PROMPT_DEFAULT),
      maxOutputTokens: this.options.maxOutputTokens ?? COMPACT_MAX_OUTPUT_TOKENS,
      stream: true,
      thinking: { enabled: false },
      cacheBreakpoints: [],
    };

    // 摘要可长达 20K token：用数组累积 + 末尾 join，避免每 delta 一次 O(n²) 字符串拼接。
    const textParts: string[] = [];
    let usage: CanonicalUsage | undefined;
    for await (const event of this.options.model.stream(request, signal)) {
      switch (event.type) {
        case "text_delta":
          textParts.push(event.text);
          break;
        case "usage":
          usage = event.usage;
          break;
        case "error":
          throw new Error(event.error.message);
        default:
          break;
      }
    }
    const text = textParts.join("");

    return {
      message: {
        role: "assistant",
        content: [{ type: "text", text: text.trim().length > 0 ? text.trim() : "(empty summary)" }],
      },
      usage,
    };
  }

  private isSummaryFailureCooldownActive(): boolean {
    return this.summaryFailureCooldownUntil > Date.now();
  }

  private createBoundaryMarker(opts: {
    trigger: CompactionTrigger;
    preTokens: number;
    messagesSummarized: number;
    summarySucceeded: boolean;
  }): CanonicalMessage {
    const status = opts.summarySucceeded ? "ok" : "summary_failed";
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: `<compact-boundary trigger="${opts.trigger}" preTokens="${opts.preTokens}" messagesSummarized="${opts.messagesSummarized}" status="${status}" />`,
        },
      ],
    };
  }
}

/**
 * Decision §3.1 #9 — exact legacy order:
 *   boundaryMarker → summary → keep → attachments → hookResults
 */
export function buildPostCompactMessages(result: CompactionResult): CanonicalMessage[] {
  const out: CanonicalMessage[] = [result.boundaryMarker];
  if (result.summaryMessage) {
    out.push(result.summaryMessage);
  }
  out.push(...result.messagesToKeep);
  out.push(...result.attachments);
  out.push(...result.hookResults);
  return ensureTrailingUserMessage(out);
}

function planFullCompactionMessages(
  messages: CanonicalMessage[],
  tailTokenBudget: number,
  protectedToolNames: Iterable<string>,
  minTailMessages: number,
  estimateTurnTokens: (turnMessages: CanonicalMessage[]) => number,
): { messagesToSummarize: CanonicalMessage[]; messagesToKeep: CanonicalMessage[]; shadowedMessageIndexes: number[] } {
  const turns = splitMessagesIntoCompactionGroups(messages);
  const tailStartTurn = moveTailBoundaryBeforeProtectedRequest(
    turns,
    findTailStartTurn(turns, tailTokenBudget, minTailMessages, estimateTurnTokens),
    protectedToolNames,
  );
  const prefixTurns = turns.slice(0, tailStartTurn);
  const tail = turns.slice(tailStartTurn).flatMap(turn => turn.messages);
  const protectedIndexes = collectProtectedGroupIndexes(prefixTurns, { protectedToolNames });
  // 保留被遮蔽区段中最近的用户请求组：压缩后尾部若无请求锚点，模型失去
  // "这次任务是谁发起的"上下文，恢复请求无法定位当前任务（#513）。
  const requestAnchorIndex = findLatestUserRequestGroupIndex(turns, tailStartTurn);
  if (requestAnchorIndex !== undefined && requestAnchorIndex < tailStartTurn) {
    protectedIndexes.add(requestAnchorIndex);
  }
  const protectedMessages: CanonicalMessage[] = [];
  const messagesToSummarize: CanonicalMessage[] = [];
  // 被遮蔽消息的原始索引（分组保序切分原始数组，游标累计即原始位置）。
  const shadowedMessageIndexes: number[] = [];
  let cursor = 0;

  for (const turn of prefixTurns) {
    if (protectedIndexes.has(turn.index)) {
      protectedMessages.push(...turn.messages);
      cursor += turn.messages.length;
    } else {
      messagesToSummarize.push(...turn.messages);
      for (let i = 0; i < turn.messages.length; i += 1) {
        shadowedMessageIndexes.push(cursor + i);
      }
      cursor += turn.messages.length;
    }
  }
  // Tool pair integrity: the summarized portion will be replaced by a summary
  // message, so any tool_result in the preserved portion whose tool_call was
  // summarized away (and vice versa) must be stripped.
  const preserved = [...protectedMessages, ...tail];
  const preservedToolResultIds = collectToolResultIds(preserved);
  const withoutDanglingCalls = stripUnpairedToolCalls(preserved, preservedToolResultIds);
  const pairedToolCallIds = collectToolCallIds(withoutDanglingCalls);
  const messagesToKeep = stripUnpairedToolResults(withoutDanglingCalls, pairedToolCallIds);

  return { messagesToSummarize, messagesToKeep, shadowedMessageIndexes };
}

/**
 * 把升序消息索引压缩为连续范围列表（含端）。
 * 例：[0,1,2,5,6] → [{fromIndex:0,toIndex:2},{fromIndex:5,toIndex:6}]。
 * 供 compactMetadata.shadowedRanges 持久化（比存原始索引数组更紧凑）。
 */
export function compressIndexRanges(indexes: readonly number[]): Array<{ fromIndex: number; toIndex: number }> {
  const ranges: Array<{ fromIndex: number; toIndex: number }> = [];
  for (const index of indexes) {
    const last = ranges.at(-1);
    if (last !== undefined && index === last.toIndex + 1) {
      last.toIndex = index;
    } else {
      ranges.push({ fromIndex: index, toIndex: index });
    }
  }
  return ranges;
}

/**
 * Last-resort head truncation: keep the trailing `keepRatio` portion (legacy
 * `truncateHeadForPTLRetry` 25% slice). Single-shot per turn (decision §3.1 #8).
 */
export function truncateHead(messages: CanonicalMessage[], keepRatio: number): CanonicalMessage[] {
  const ratio = clamp(keepRatio, 0.05, 1);
  const keep = Math.max(1, Math.floor(messages.length * ratio));
  return messages.slice(-keep);
}

/**
 * Tail truncation that keeps the most recent user request that initiated the
 * kept suffix. Without the anchor, the model loses "who started this task"
 * context and cannot locate the current task after head truncation (#513).
 */
function truncateTailPreservingToolPairs(messages: CanonicalMessage[], keepRatio: number): CanonicalMessage[] {
  if (messages.length === 0) return [];
  const rawTail = truncateHead(messages, keepRatio);
  const tailStartIndex = messages.length - rawTail.length;
  let requestAnchorIndex: number | undefined;
  for (let index = tailStartIndex; index >= 0; index -= 1) {
    if (isRealUserRequestMessage(messages[index]!)) {
      requestAnchorIndex = index;
      break;
    }
  }
  const liveTail =
    requestAnchorIndex !== undefined && requestAnchorIndex < tailStartIndex
      ? [messages[requestAnchorIndex]!, ...rawTail]
      : rawTail;
  const resultIds = collectToolResultIds(liveTail);
  const pairedCalls = stripUnpairedToolCalls(liveTail, resultIds);
  const callIds = collectToolCallIds(pairedCalls);
  return stripUnpairedToolResults(pairedCalls, callIds);
}

/**
 * Emergency projection that keeps accepted checkpoint messages before the
 * newest live suffix. Used only after summary and snip could not fit.
 */
export function truncateHeadPreservingCheckpoint(messages: CanonicalMessage[], keepRatio: number): CanonicalMessage[] {
  const checkpoint = splitCheckpointPrefix(messages);
  if (checkpoint.stablePrefix.length === 0) {
    return ensureTrailingUserMessage(truncateTailPreservingToolPairs(messages, keepRatio));
  }
  return ensureTrailingUserMessage([
    ...checkpoint.stablePrefix,
    ...truncateTailPreservingToolPairs(checkpoint.liveMessages, keepRatio),
  ]);
}

/**
 * Split the accepted checkpoint prefix (boundary + summary pairs) from the
 * live messages. Legacy snapshots may contain multiple boundary/summary
 * pairs; collect every accepted summary so the next successful pass can
 * replace them with one rolling checkpoint.
 */
function splitCheckpointPrefix(messages: CanonicalMessage[]): {
  stablePrefix: CanonicalMessage[];
  previousSummaries: CanonicalMessage[];
  liveMessages: CanonicalMessage[];
} {
  let index = 0;
  const previousSummaries: CanonicalMessage[] = [];
  while (
    index + 1 < messages.length &&
    isCompactBoundaryMessage(messages[index]!) &&
    isWrappedSummaryMessage(messages[index + 1]!)
  ) {
    previousSummaries.push(messages[index + 1]!);
    index += 2;
  }
  return {
    stablePrefix: messages.slice(0, index),
    previousSummaries,
    liveMessages: messages.slice(index),
  };
}

function isCompactBoundaryMessage(message: CanonicalMessage): boolean {
  return (
    message.role === "user" &&
    message.content.some(block => block.type === "text" && block.text.startsWith("<compact-boundary"))
  );
}

function isWrappedSummaryMessage(message: CanonicalMessage): boolean {
  return (
    message.role === "assistant" &&
    message.content.some(block => block.type === "text" && block.text.startsWith(COMPACT_SUMMARY_PREFIX))
  );
}

/**
 * Find the most recent group (at or before `atOrBefore`) that contains a
 * real end-user request, so truncation can keep the request that initiated
 * the retained tail.
 */
function findLatestUserRequestGroupIndex(
  groups: Array<{ index: number; messages: CanonicalMessage[] }>,
  atOrBefore: number,
): number | undefined {
  for (let index = Math.min(atOrBefore, groups.length - 1); index >= 0; index -= 1) {
    if (groups[index]!.messages.some(isRealUserRequestMessage)) {
      return groups[index]!.index;
    }
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}
