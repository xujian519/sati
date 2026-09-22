import { randomUUID } from "node:crypto";
import {
  isPromptTooLong,
  type CanonicalMessage,
  type CanonicalModelError,
  type CanonicalModelEvent,
  type CanonicalModelRequest,
  type CanonicalUsage,
} from "../../model/index.js";
import type { TokenAccountingRuntime } from "../budget/TokenAccountingRuntime.js";
import { TokenBudgetManager } from "../budget/TokenBudgetManager.js";
import type { ContextDiagnostic } from "../protocol/types.js";
import type { AgentEventEmitter } from "../../agent/protocol/events.js";
import {
  collectToolCallIds,
  collectToolResultIds,
  ensureTrailingUserMessage,
  findLatestUserRequestGroupIndex,
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
/**
 * 摘要调用次数上限：第一次按既定尾比例；仅在 PTL（摘要请求自己超窗）时反向重选
 * 再试一次。有界一次，避免在失败边缘反复烧模型调用。
 */
const MAX_SUMMARY_ATTEMPTS = 2;

/**
 * 压缩终止状态。`fallback` = 摘要模型调用失败或不可用，改用确定性摘要降级
 * （压缩本身仍然生效）；`cancelled` = 用户中断；`failed` = 压缩流程自身抛错，
 * 未产出边界。UI 据此区分「已压缩」与「压缩失败/中断」。
 */
export type CompactionStatus = "success" | "fallback" | "cancelled" | "failed";

export type CompactionResult = {
  /** Stable identity shared by live and persisted representations of this pass. */
  compactionId: string;
  status: CompactionStatus;
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
    const protectedToolNames =
      input.protectedToolNames === null ? new Set<string>() : (input.protectedToolNames ?? this.protectedToolNames);
    const minTailMessages = input.protectedToolNames === null ? RELAXED_MIN_TAIL_MESSAGES : DEFAULT_MIN_TAIL_MESSAGES;
    /**
     * 计划（要总结什么、保留什么）必须能在本次 run 内重算，且**先于**任何落盘/事件生效：
     * 先落一条失败边界再落一条重算边界会让 shadowedRanges 与被遮蔽原文错位。
     */
    const planAt = (ratio: number): FullCompactionPlanState => {
      const tailTokenBudget = Math.max(1, Math.floor(preTokens * clamp(ratio, 0, 1)));
      const compactPlan = planFullCompactionMessages(
        input.messages,
        tailTokenBudget,
        protectedToolNames,
        minTailMessages,
        turnMessages => this.estimateMessages(turnMessages),
      );
      const retainedTailExceededBudget = this.estimateMessages(compactPlan.messagesToKeep) > tailTokenBudget;
      const messagesToKeep = retainedTailExceededBudget
        ? projectOversizedRetainedToolResults(compactPlan.messagesToKeep, collectToolNamesByCallId(input.messages))
        : compactPlan.messagesToKeep;
      return { ratio, compactPlan, messagesToKeep, retainedTailExceededBudget };
    };
    let plan = planAt(tailRatio);
    /** 反向重选：目标尾比例必须**更大**（多留原文），算不出更大值就不重试。 */
    const widenRetainedTail = (
      current: FullCompactionPlanState,
      modelError: CanonicalModelError,
    ): FullCompactionPlanState | undefined => {
      const nextRatio = nextTailRatioForPromptTooLong({
        currentRatio: current.ratio,
        preTokens,
        promptTooLongMaxContextTokens: modelError.maxContextTokens,
      });
      return nextRatio > current.ratio ? planAt(nextRatio) : undefined;
    };

    await this.options.lifecycle?.dispatch({
      event: "PreCompact",
      payload: {
        trigger: input.trigger,
        preTokens,
        messagesSummarized: plan.compactPlan.messagesToSummarize.length,
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
    let summaryCancelled = false;
    /** 重选留下的诊断：与摘要失败诊断同一通道，随结果落盘/展示。 */
    const replanDiagnostics: ContextDiagnostic[] = [];

    try {
      if (plan.compactPlan.messagesToSummarize.length === 0) {
        // Nothing to summarize: still emit a boundary so the transcript captures
        // the intent, but no model call happens.
      } else if (this.isSummaryFailureCooldownActive()) {
        summaryError = this.summaryFailureError ?? "context summary is in cooldown";
        summaryMessage = buildDeterministicFallbackSummary(plan.compactPlan.messagesToSummarize, summaryError);
      } else {
        // 失败冷却未生效时最多两次摘要调用：PTL 时反向重选（保留更多近期原文）再试一次。
        for (let attempt = 1; attempt <= MAX_SUMMARY_ATTEMPTS; attempt += 1) {
          const messagesToSummarize = plan.compactPlan.messagesToSummarize;
          if (messagesToSummarize.length === 0) {
            // 重选后尾预算吃下全部历史：无需总结，也不再调用模型。
            break;
          }
          const summaryAnchors =
            input.protectedToolNames === null
              ? buildCompactSummaryAnchors(messagesToSummarize, this.protectedToolNames)
              : undefined;
          const summaryInput = projectMessagesForSummary(messagesToSummarize);
          try {
            const result = await this.summarize(summaryInput, input.userInstruction, input.signal, summaryAnchors);
            summaryMessage = wrapSummaryMessage(result.message);
            summaryUsage = result.usage;
            this.summaryFailureCooldownUntil = 0;
            this.summaryFailureError = undefined;
            break;
          } catch (error) {
            // 用户中断不是摘要失败：不进入失败冷却，否则下一次压缩会被 60s 冷却
            // 挡掉、静默退化成确定性摘要。
            summaryCancelled = input.signal?.aborted === true;
            const modelError = extractModelError(error);
            // 反向重选：摘要请求**自己**超窗时，正确的反应是保留更多近期原文（少总结），
            // 而不是继续压缩更多——压得越狠，摘要输入越大，下一轮还会超窗。
            const replanned =
              !summaryCancelled &&
              attempt < MAX_SUMMARY_ATTEMPTS &&
              modelError !== undefined &&
              isPromptTooLong(modelError)
                ? widenRetainedTail(plan, modelError)
                : undefined;
            if (replanned) {
              replanDiagnostics.push({
                code: "compact_summary_prompt_too_long",
                severity: "info",
                message:
                  `The summary request itself exceeded the model context window; retrying with a larger ` +
                  `retained tail (keepTailRatio ${plan.ratio} → ${replanned.ratio}).`,
              });
              plan = replanned;
              continue;
            }
            summaryError = error instanceof Error ? error.message : String(error);
            if (!summaryCancelled) {
              this.summaryFailureCooldownUntil = Date.now() + COMPACT_SUMMARY_FAILURE_COOLDOWN_MS;
              this.summaryFailureError = summaryError;
            }
            summaryMessage = buildDeterministicFallbackSummary(messagesToSummarize, summaryError);
            break;
          }
        }
      }

      const boundaryMarker = this.createBoundaryMarker({
        trigger: input.trigger,
        preTokens,
        messagesSummarized: plan.compactPlan.messagesToSummarize.length,
        summarySucceeded: summaryError === undefined,
      });

      let diagnostics: ContextDiagnostic[];
      if (summaryError) {
        diagnostics = [
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
        ];
      } else if (summaryMessage) {
        diagnostics = validateSummaryMarkdownStructure(summaryMessage);
      } else {
        diagnostics = [];
      }
      if (plan.retainedTailExceededBudget && plan.messagesToKeep !== plan.compactPlan.messagesToKeep) {
        diagnostics.push({
          code: "compact_retained_tool_output_truncated",
          severity: "warning",
          message:
            "Oversized retained tool output was replaced with a bounded preview so the compacted context can fit the tail budget.",
        });
      }
      if (replanDiagnostics.length > 0) {
        diagnostics = [...replanDiagnostics, ...diagnostics];
      }

      const status: CompactionStatus = summaryCancelled ? "cancelled" : summaryError ? "fallback" : "success";
      const result: CompactionResult = {
        compactionId,
        status,
        trigger: input.trigger,
        preTokens,
        messagesSummarized: plan.compactPlan.messagesToSummarize.length,
        shadowedMessageIndexes: plan.compactPlan.shadowedMessageIndexes,
        summaryMessage,
        boundaryMarker,
        messagesToKeep: plan.messagesToKeep,
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
          status,
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
        status,
        preTokens,
        postTokens: result.postTokens,
        messagesSummarized: plan.compactPlan.messagesToSummarize.length,
      });

      return result;
    } catch (error: unknown) {
      // 硬失败（非摘要降级）：compact_started 已在上方发出，此处补一条带同一
      // compactionId 的终态，UI 才能把「压缩失败」与「压缩成功」区分开。异常
      // 照旧抛出——compactionExecutor 的兜底截断与 turn 失败处理依赖它。
      this.options.eventEmitter?.({
        type: "compact_completed",
        sessionId: input.sessionId ?? "",
        turnId: input.turnId ?? "",
        compactionId,
        trigger: input.trigger,
        status: "failed",
        preTokens,
        messagesSummarized: plan.compactPlan.messagesToSummarize.length,
      });
      throw error;
    }
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
          // 结构化错误必须原样保留：丢掉 code / recoverableViaCompact / maxContextTokens
          // 会让调用方无法识别 PTL，也就无法反向重选（只看到一句 message）。
          throw new SummaryModelError(event.error);
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

/**
 * 摘要调用失败时保留 provider 的结构化错误。丢成 `new Error(message)` 会丢
 * `code` / `recoverableViaCompact` / `maxContextTokens`——调用方只能看到一句话，
 * 无法判断「摘要请求自己超窗」（本引擎据此反向重选）。
 */
export class SummaryModelError extends Error {
  constructor(readonly modelError: CanonicalModelError) {
    super(modelError.message);
    this.name = "SummaryModelError";
  }
}

/** 取出可判定的模型错误：只认自己带的 `SummaryModelError`（其他异常按普通失败处理）。 */
function extractModelError(error: unknown): CanonicalModelError | undefined {
  return error instanceof SummaryModelError ? error.modelError : undefined;
}

/** `planAt` 的一次计划结果（PTL 重选会整体替换它，因此必须自洽）。 */
type FullCompactionPlanState = {
  /** 本次计划使用的尾比例（重选后是新值）。 */
  ratio: number;
  compactPlan: {
    messagesToSummarize: CanonicalMessage[];
    messagesToKeep: CanonicalMessage[];
    shadowedMessageIndexes: number[];
  };
  messagesToKeep: CanonicalMessage[];
  retainedTailExceededBudget: boolean;
};

/**
 * 反向重选的目标尾比例（只会更大）：
 * - 有报错携带的上限时，按「摘要集最多能占多少」反推：`(preTokens - 上限) / preTokens`
 *   ——用整段对话 token 保守估计（摘要输入只是其投影，按整段算不会少留原文）。
 * - 没有上限时退化为尾预算翻倍。
 * 两者取大并截到 1；比例不变（1）即表示无处可让，调用方不应重试。
 */
function nextTailRatioForPromptTooLong(input: {
  currentRatio: number;
  preTokens: number;
  promptTooLongMaxContextTokens?: number;
}): number {
  const reported = input.promptTooLongMaxContextTokens;
  const derivedFromReported =
    reported !== undefined && reported > 0 && input.preTokens > reported
      ? (input.preTokens - reported) / input.preTokens
      : 0;
  return clamp(Math.max(input.currentRatio * 2, derivedFromReported), 0, 1);
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
  // group.index 恒等于数组位置（compactionGroups.ts），位置即组索引。
  const requestAnchorIndex = findLatestUserRequestGroupIndex(
    turns.map(turn => turn.messages),
    tailStartTurn,
  );
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
function truncateHead(messages: CanonicalMessage[], keepRatio: number): CanonicalMessage[] {
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
 * pairs; all of them are preserved verbatim in the stable prefix.
 */
function splitCheckpointPrefix(messages: CanonicalMessage[]): {
  stablePrefix: CanonicalMessage[];
  liveMessages: CanonicalMessage[];
} {
  let index = 0;
  while (
    index + 1 < messages.length &&
    isCompactBoundaryMessage(messages[index]!) &&
    isWrappedSummaryMessage(messages[index + 1]!)
  ) {
    index += 2;
  }
  return {
    stablePrefix: messages.slice(0, index),
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
 * 判定消息头部是否为一次完整压缩的 checkpoint（boundary 标记 + 摘要消息）。
 *
 * 该形态意味着前缀已被整体重写，调用方可据此决定能否刷新只在稳定前缀下才成立的
 * 状态（如 system prompt 的日期锚点）。
 *
 * @param messages - 投影后的消息序列。
 * @returns 头部是 checkpoint 时为 true。
 */
export function isCompactionCheckpointHead(messages: CanonicalMessage[]): boolean {
  const [boundary, summary] = messages;
  if (boundary === undefined || summary === undefined) return false;
  return isCompactBoundaryMessage(boundary) && isWrappedSummaryMessage(summary);
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}
