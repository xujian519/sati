import { createHash } from "node:crypto";
import { buildEdgeClawMemoryPromptSection } from "edgeclaw-memory-core";
import type { CanonicalMessage, CanonicalUsage } from "../model/index.js";
import { createLogger } from "../telemetry/index.js";
import { debugLog } from "../shared/debug.js";
import { stableSerialize } from "./cache/CachePlan.js";
import { ToolResultBudget } from "./budget/ToolResultBudget.js";
import type { TokenBudgetManager, TokenBudgetSnapshot } from "./budget/TokenBudgetManager.js";
import type { AutoCompactionPolicy } from "./compaction/AutoCompactionPolicy.js";
import {
  type CompactionEngine,
  type CompactionResult,
  buildPostCompactMessages,
  isCompactionCheckpointHead,
} from "./compaction/CompactionEngine.js";
import type { CachedMicroCompactionEngine } from "./compaction/CachedMicroCompactionEngine.js";
import type { MicroCompactionEngine } from "./compaction/MicroCompactionEngine.js";
import type { SnipEngine } from "./compaction/SnipEngine.js";
import { ensureTrailingUserMessage } from "./compaction/toolPairIntegrity.js";
import type { ContextOverflowRecovery } from "./recovery/ContextOverflowRecovery.js";
import { NullExtensionResolver, type ExtensionResolver } from "./extension/ExtensionResolver.js";
import type { InstructionDiscovery, InstructionScope } from "./instructions/InstructionDiscovery.js";
import { MemoryAttachmentBuilder } from "./memory/MemoryAttachmentBuilder.js";
import type { KnowledgeProfile, MemoryResolver } from "./memory/MemoryResolver.js";
import { buildPromptDateNotice } from "./prompt/promptDateNotice.js";
import { PromptAssembler } from "./prompt/PromptAssembler.js";
import { MessageProjector } from "./projection/MessageProjector.js";
import type {
  ContextCaptureTurnInput,
  ContextDiagnostic,
  ContextPrepareInput,
  ContextRecoveryDecision,
  ContextRecoveryInput,
  ContextRuntime,
  ContextToolResultInput,
  ContextToolResultResult,
  ModelContext,
  InjectionRecord,
} from "./protocol/types.js";

const logger = createLogger("context:auto-compact");

export type CompactionTier = "micro" | "snip" | "full";

export type AutoCompactResult =
  | { type: "skipped"; snapshot: TokenBudgetSnapshot }
  | {
      type: "compacted";
      messages: CanonicalMessage[];
      tier: CompactionTier;
      snapshot: TokenBudgetSnapshot;
      result?: CompactionResult;
    };

export type DefaultContextRuntimeOptions = {
  extension?: ExtensionResolver;
  promptAssembler?: PromptAssembler;
  messageProjector?: MessageProjector;
  toolResultBudget?: ToolResultBudget;
  memoryResolver?: MemoryResolver;
  /** A2 — token budget manager (provider-aware tokenizer fallback). */
  tokenBudget?: TokenBudgetManager;
  /** A5 — full-conversation compaction engine (summarize via model call). */
  compactionEngine?: CompactionEngine;
  /** A5 — token-budget-driven policy that decides when to summarize. */
  autoCompactionPolicy?: AutoCompactionPolicy;
  /**
   * A4 — opt-in cached micro-compaction engine. Construction is gated by
   * `PilotConfig.context.cachedMicrocompactEnabled` upstream.
   */
  microcompactEngine?: CachedMicroCompactionEngine;
  /** Tier 1 — truncates old tool_result content (time-based path). */
  microCompaction?: MicroCompactionEngine;
  /** Tier 2 — prunes middle turns, keeping head + tail anchors. */
  snipEngine?: SnipEngine;
  /** Reactive overflow recovery (prompt_too_long → truncate head). */
  overflowRecovery?: ContextOverflowRecovery;
  /** SATI.md instruction file discovery (multi-scope hierarchy). */
  instructionDiscovery?: InstructionDiscovery;
  /** Project root forwarded to MemoryResolver.retrieve. */
  projectRoot?: string;
  /**
   * Maximum context window size (tokens) for the active model. Used by
   * `tryAutoCompact` to evaluate whether proactive compaction is needed.
   * Falls back to 8192 when unset.
   */
  maxContextTokens?: number;
  /**
   * keepRatio used on the first reactive truncate. Legacy hint is 0.5 — keep
   * the back half of the conversation. Decision §3.2.
   */
  truncateFirstKeepRatio?: number;
  /** Timeout budget for MemoryResolver.retrieve during prepareForModel. */
  memoryRetrievalTimeoutMs?: number;
  /** 项目知识偏好（per-project knowledge profile），透传给 MemoryResolver.retrieve。 */
  knowledgeProfile?: KnowledgeProfile;
  now?: () => Date;
};

/** 一条跨 UTC 日留下的日期通知，`index` 取自投影消息坐标系。 */
type PromptDateNoticeRef = { index: number; date: string; message: CanonicalMessage };

/**
 * 会话提示时间状态：锚点时刻 + 上次提交的投影消息指纹 + 已追加的日期通知。
 * 随 runtime 生命周期存在，重建 runtime 时重新初始化。
 */
type PromptTimeState = {
  timestamp: number;
  messages: string[];
  dateUpdates: PromptDateNoticeRef[];
};

const DEFAULT_MAX_CONTEXT_TOKENS = 8192;
const DEFAULT_TRUNCATE_FIRST_RATIO = 0.5;
const DEFAULT_MEMORY_RETRIEVAL_TIMEOUT_MS = 30_000;
const RELAXED_FULL_COMPACTION_KEEP_TAIL_RATIO = 0.05;
const FULL_COMPACTION_BLOCKING_COOLDOWN_MS = 30_000;
const FULL_COMPACTION_MIN_EFFECTIVE_SAVINGS_RATIO = 0.1;
const FULL_COMPACTION_INEFFECTIVE_LIMIT = 2;

export class DefaultContextRuntime implements ContextRuntime {
  private readonly extension: ExtensionResolver;
  private readonly promptAssembler: PromptAssembler;
  private readonly messageProjector: MessageProjector;
  private readonly toolResultBudget?: ToolResultBudget;
  private readonly memoryResolver?: MemoryResolver;
  private readonly memoryAttachmentBuilder?: MemoryAttachmentBuilder;
  readonly tokenBudget?: TokenBudgetManager;
  readonly compactionEngine?: CompactionEngine;
  readonly autoCompactionPolicy?: AutoCompactionPolicy;
  readonly microcompactEngine?: CachedMicroCompactionEngine;
  private readonly microCompaction?: MicroCompactionEngine;
  private readonly snipEngine?: SnipEngine;
  private readonly overflowRecovery?: ContextOverflowRecovery;
  private readonly instructionDiscovery?: InstructionDiscovery;
  private readonly projectRoot?: string;
  private readonly maxContextTokens: number;
  private readonly truncateFirstKeepRatio: number;
  private readonly memoryRetrievalTimeoutMs: number;
  private readonly knowledgeProfile?: KnowledgeProfile;
  private readonly now: () => Date;
  /**
   * 会话提示日期锚点（上游 v2026.09.14 / PR #571 语义移植）。`<environment>now:`
   * 位于 system prompt 前缀中，是 prompt cache 的缓存键：锚定在会话首次正式组装
   * 请求，此后不因追加消息、重试、跨天而改写，整段前缀在会话内逐字稳定。跨 UTC
   * 日改为在消息尾部追加一条日期通知（见 promptDateNotice.ts），陈旧上界收敛到
   * 0 天；只有完整压缩重写前缀后才重新锚定。需要精确到分秒的工作走
   * get_current_time 工具。
   */
  private readonly promptTimeState = new Map<string, PromptTimeState>();
  private fullCompactionCooldownUntil = 0;
  private consecutiveIneffectiveFullCompactions = 0;

  constructor(options: DefaultContextRuntimeOptions = {}) {
    this.extension = options.extension ?? new NullExtensionResolver();
    this.promptAssembler = options.promptAssembler ?? new PromptAssembler(this.extension);
    this.messageProjector = options.messageProjector ?? new MessageProjector();
    this.toolResultBudget = options.toolResultBudget;
    this.memoryResolver = options.memoryResolver;
    this.memoryAttachmentBuilder = options.memoryResolver
      ? new MemoryAttachmentBuilder(options.memoryResolver)
      : undefined;
    this.tokenBudget = options.tokenBudget;
    this.compactionEngine = options.compactionEngine;
    this.autoCompactionPolicy = options.autoCompactionPolicy;
    this.microcompactEngine = options.microcompactEngine;
    this.microCompaction = options.microCompaction;
    this.snipEngine = options.snipEngine;
    this.overflowRecovery = options.overflowRecovery;
    this.instructionDiscovery = options.instructionDiscovery;
    this.projectRoot = options.projectRoot;
    this.maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    this.truncateFirstKeepRatio = options.truncateFirstKeepRatio ?? DEFAULT_TRUNCATE_FIRST_RATIO;
    this.memoryRetrievalTimeoutMs = options.memoryRetrievalTimeoutMs ?? DEFAULT_MEMORY_RETRIEVAL_TIMEOUT_MS;
    this.knowledgeProfile = options.knowledgeProfile;
    this.now = options.now ?? (() => new Date());
  }

  async prepareForModel(input: ContextPrepareInput): Promise<ModelContext> {
    const diagnostics: ContextDiagnostic[] = [];

    const projection = this.messageProjector.project({
      messages: input.messages,
      maxMessages: input.maxMessages,
    });

    for (const warning of projection.warnings) {
      diagnostics.push({
        code: warning.code,
        severity: "warning",
        message: warning.message,
      });
    }

    // 提示日期锚点 + 跨日通知。逐条指纹只用于算「未变前缀长度」：头部被重写
    // （裁剪/微压缩/完整压缩）时，落在重写区内的旧通知必须丢弃，否则下标会指向
    // 错位的消息。指纹只存摘要，不保留一份内容副本。
    const messageFingerprints = projection.messages.map(message =>
      createHash("sha256")
        .update(stableSerialize({ role: message.role, content: message.content }))
        .digest("hex"),
    );
    const previousTime = this.promptTimeState.get(input.sessionId);
    let unchangedPrefixLength = 0;
    while (
      previousTime !== undefined &&
      unchangedPrefixLength < messageFingerprints.length &&
      messageFingerprints[unchangedPrefixLength] === previousTime.messages[unchangedPrefixLength]
    ) {
      unchangedPrefixLength += 1;
    }
    // 只有完整压缩产生新 checkpoint 才允许刷新 system 日期——那时前缀本来就要
    // 重写；微压缩、头部裁剪、中间删减都不得改写 system 前缀（否则整段缓存失效）。
    const newCheckpoint =
      previousTime !== undefined && isCompactionCheckpointHead(projection.messages) && unchangedPrefixLength < 2;
    const refreshTime = !input.previewOnly && newCheckpoint;
    const currentTime = this.now();
    const currentDate = currentTime.toISOString().slice(0, 10);
    const promptTimestamp = !previousTime || refreshTime ? currentTime.getTime() : previousTime.timestamp;
    // 通知保留在原始位置，让后续请求在前缀上继续累积；下标超出未变前缀的（被
    // 重写波及）丢弃，随后按需在新末尾补一条当前日期。
    const dateUpdates = refreshTime
      ? []
      : (previousTime?.dateUpdates ?? []).filter(update => update.index <= unchangedPrefixLength);
    const lastDate = dateUpdates.at(-1)?.date ?? new Date(promptTimestamp).toISOString().slice(0, 10);
    if (currentDate !== lastDate) {
      dateUpdates.push({
        index: projection.messages.length,
        date: currentDate,
        message: buildPromptDateNotice(currentDate),
      });
    }
    const requestMessages = withDateNotices(projection.messages, dateUpdates);

    // 提前并行启动记忆检索：build 内部是异步的 memory-gate LLM 调用 + 语义
    // 检索（EdgeClawMemoryProvider 命中 TTL 缓存时几乎零成本），让它在后续
    // 同步的 prompt 组装与本地文件读取期间执行，避免串行等待拖慢首 token。
    const memoryPromise = this.memoryAttachmentBuilder
      ? this.memoryAttachmentBuilder.build({
          query: extractRecentUserText(projection.messages) ?? "",
          sessionId: input.sessionId,
          projectRoot: this.projectRoot ?? input.cwd,
          recentMessages: projection.messages,
          signal: input.abortSignal,
          timeoutMs: this.memoryRetrievalTimeoutMs,
          knowledgeProfile: this.knowledgeProfile,
        })
      : undefined;

    const prompt = this.promptAssembler.assemble({
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      permissionMode: input.permissionMode,
      runMode: input.runMode,
      additionalWorkingDirectories: input.additionalWorkingDirectories,
      tools: input.tools,
      customSystemPrompt: input.customSystemPrompt,
      appendSystemPrompt: input.appendSystemPrompt,
      now: () => new Date(promptTimestamp),
    });

    const parts = [...prompt.parts];
    // 「模型可见 = 已记录」：动态注入段落的来源清单，随 ModelContext 返回，
    // 由调用方作为带 source 标记的参考条目落 transcript（不进入重放投影）。
    const injections: InjectionRecord[] = [];
    if (memoryPromise) {
      const memory = await memoryPromise;
      for (const block of memory.attachments) {
        for (const content of block.content) {
          if (content.type === "text" && content.text.trim().length > 0) {
            parts.push(content.text);
            injections.push({ source: "memory", text: content.text });
          }
        }
      }
      for (const diagnostic of memory.diagnostics) {
        diagnostics.push({
          code: diagnostic.code,
          severity: diagnostic.severity,
          message: diagnostic.message,
        });
      }
      if (input.abortSignal?.aborted) {
        // 中止路径不提交锚点状态：锚点由「已提交状态 + 实时时钟」确定性推导，
        // 下一次组装会重算出同样的值。
        return {
          messages: requestMessages,
          systemPrompt: parts.join("\n\n"),
          systemPromptParts: parts,
          injections,
          tools: input.tools,
          diagnostics,
          boundaries: [],
          metadata: {
            droppedCount: projection.droppedCount,
            toolCount: input.tools.length,
          },
        };
      }
    }

    // ClawXMemory agent 记忆工具提示段：仅当注册了 memory_* 工具时输出，
    // 未启用记忆（无 memory service → 工具未注册）时返回 null，不产生段落。
    const memoryPromptSection = buildEdgeClawMemoryPromptSection({
      availableTools: input.tools.map(tool => tool.name),
    });
    if (memoryPromptSection) {
      parts.push(memoryPromptSection);
      injections.push({ source: "clawx_memory", text: memoryPromptSection });
    }

    if (this.instructionDiscovery) {
      try {
        const layers = await this.instructionDiscovery.discover();
        if (layers.length > 0) {
          const blocks = layers.map(l => {
            const desc = instructionScopeDescription(l.scope);
            return `Contents of ${l.path}${desc}:\n\n${l.content}`;
          });
          const instructionText =
            `<project-instructions>\nProject instructions are shown below. Adhere to these instructions. ` +
            `IMPORTANT: These instructions OVERRIDE any default behavior.\n\n` +
            `${blocks.join("\n\n")}\n</project-instructions>`;
          parts.push(instructionText);
          injections.push({ source: "project_instructions", text: instructionText });
        }
      } catch {
        diagnostics.push({
          code: "instruction_discovery_failed",
          severity: "warning",
          message: "Failed to discover SATI.md instruction files.",
        });
      }
    }

    const joined = parts.join("\n\n");

    // 断点与 messages 必须同一坐标系：通知插入后仍在最终数组上计算微压缩断点，
    // 否则下标右移会把 cache_control 打到错误的块上。
    const microcompactResult = this.microcompactEngine?.apply({
      messages: requestMessages,
    });

    // 预算预演（previewOnly）不得提交锚点与通知位置：候选请求喂的是假设历史，
    // 提交会让随后的真实请求继承错误下标。
    if (!input.previewOnly) {
      this.promptTimeState.set(input.sessionId, {
        timestamp: promptTimestamp,
        messages: messageFingerprints,
        dateUpdates,
      });
    }

    return {
      messages: requestMessages,
      systemPrompt: joined,
      systemPromptParts: parts,
      injections,
      tools: input.tools,
      diagnostics,
      boundaries: [],
      metadata: {
        droppedCount: projection.droppedCount,
        toolCount: input.tools.length,
      },
      cacheBreakpoints: microcompactResult?.cacheBreakpoints,
    };
  }

  async applyToolResults(input: ContextToolResultInput): Promise<ContextToolResultResult> {
    const diagnostics: ContextDiagnostic[] = [];
    let appended: CanonicalMessage = input.toolResultMessage;
    let supplementalMessages = input.supplementalMessages ?? [];
    if (this.toolResultBudget) {
      try {
        appended = await this.toolResultBudget.applyToMessage(input.toolResultMessage, { turnId: input.turnId });
        supplementalMessages = await Promise.all(
          supplementalMessages.map(async ({ toolCallId, message }) => ({
            toolCallId,
            message: await this.toolResultBudget!.applyToSupplementalMessage(message, toolCallId, {
              turnId: input.turnId,
            }),
          })),
        );
      } catch (error) {
        diagnostics.push({
          code: "tool_result_persistence_failed",
          severity: "error",
          message: `Failed to persist large tool result: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const appendedMessages = [appended, ...supplementalMessages.map(({ message }) => message)];
    return { messages: [...input.messages, ...appendedMessages], appendedMessages, diagnostics };
  }

  async captureTurn(input: ContextCaptureTurnInput): Promise<void> {
    if (!this.memoryResolver) return;
    if (isAlwaysOnSession(input.sessionId)) return;
    try {
      await this.memoryResolver.captureTurn({
        sessionId: input.sessionId,
        projectRoot: this.projectRoot ?? "",
        messages: input.messages.filter(message => !message.metadata?.forkCarryover),
        errored: input.errored,
      });
    } catch {
      // Memory capture must never break the agent turn — provider already
      // swallows in EdgeClawMemoryProvider, this catch is belt-and-suspenders.
    }
  }

  async tryAutoCompact(input: {
    sessionId?: string;
    turnId?: string;
    messages: CanonicalMessage[];
    abortSignal?: AbortSignal;
    maxContextTokens?: number;
    reservedOutputTokens?: number;
    lastUsage?: CanonicalUsage;
    budgetEvaluator?: (messages: CanonicalMessage[], lastUsage?: CanonicalUsage) => Promise<TokenBudgetSnapshot>;
  }): Promise<AutoCompactResult> {
    const sessionId = input.sessionId ?? "";
    const turnId = input.turnId ?? "";
    const log = (stage: string, details: Record<string, unknown> = {}, level?: "warn" | "debug") => {
      logAutoCompactEvent(stage, { sessionId, turnId }, details, level);
    };
    const effectiveMaxContextTokens = input.maxContextTokens ?? this.maxContextTokens;
    if (!this.autoCompactionPolicy || !this.tokenBudget) {
      log("disabled", {
        hasAutoCompactionPolicy: Boolean(this.autoCompactionPolicy),
        hasTokenBudget: Boolean(this.tokenBudget),
        maxContextTokens: effectiveMaxContextTokens,
      });
      return {
        type: "skipped",
        snapshot: {
          tokens: 0,
          maxContextTokens: effectiveMaxContextTokens,
          warningRatio: 0,
          blockingRatio: 0,
          state: "ok",
          ratio: 0,
        },
      };
    }
    let messages = input.messages;
    const budgetOptions = { reservedOutputTokens: input.reservedOutputTokens };
    const evaluateBudget = (candidate: CanonicalMessage[], lastUsage?: CanonicalUsage) =>
      input.budgetEvaluator
        ? input.budgetEvaluator(candidate, lastUsage)
        : Promise.resolve(
            this.tokenBudget!.evaluate(candidate, effectiveMaxContextTokens, {
              usePadding: true,
              ...budgetOptions,
              lastUsage,
            }),
          );
    const initialSnapshot = await evaluateBudget(messages, input.lastUsage);
    const decision = this.autoCompactionPolicy.evaluateSnapshot(initialSnapshot);
    if (decision.type !== "trigger") {
      // 未触发压缩是每个 turn 的正常信息（含完整 snapshot JSON），降 debug 避免噪音。
      log(
        "policy_skip",
        {
          decisionType: decision.type,
          snapshot: decision.snapshot,
        },
        "debug",
      );
      return { type: "skipped", snapshot: decision.snapshot };
    }
    log("policy_trigger", {
      reason: decision.reason,
      snapshot: initialSnapshot,
      messages: messages.length,
      reservedOutputTokens: input.reservedOutputTokens,
    });

    // Tier 1: MicroCompaction — truncate old tool_result content.
    if (this.microCompaction) {
      const r = this.microCompaction.apply({ messages });
      if (r.rewritten > 0) {
        messages = r.messages;
        const snap = await evaluateBudget(messages);
        log("micro_compaction", {
          rewritten: r.rewritten,
          snapshot: snap,
          stopAfterPrePrune: shouldStopAfterPrePrune(decision.reason, snap),
        });
        if (shouldStopAfterPrePrune(decision.reason, snap)) {
          log("micro_compaction_stop", {
            snapshot: snap,
          });
          return {
            type: "compacted",
            messages: ensureTrailingUserMessage(messages),
            tier: "micro",
            snapshot: snap,
          };
        }
      } else {
        log("micro_compaction_noop", {
          messages: messages.length,
        });
      }
    }

    if (decision.reason === "warning_threshold") {
      log("warning_threshold_skip", {
        snapshot: decision.snapshot,
      });
      return { type: "skipped", snapshot: decision.snapshot };
    }

    // Tier 2: SnipEngine — prune middle turns, keep head + tail.
    if (this.snipEngine) {
      const r = this.snipEngine.snip(messages);
      if (r.applied) {
        messages = r.messages;
        const snap = await evaluateBudget(messages);
        log("snip_compaction", {
          snapshot: snap,
          stopAfterPrePrune: shouldStopAfterPrePrune(decision.reason, snap),
        });
        if (shouldStopAfterPrePrune(decision.reason, snap)) {
          log("snip_compaction_stop", {
            snapshot: snap,
          });
          return {
            type: "compacted",
            messages: ensureTrailingUserMessage(messages),
            tier: "snip",
            snapshot: snap,
          };
        }
      } else {
        log("snip_compaction_noop", {
          messages: messages.length,
        });
      }
    }

    // Tier 3: CompactionEngine — full summarization via model call.
    if (this.compactionEngine) {
      const nowMs = this.now().getTime();
      if (this.fullCompactionCooldownUntil > nowMs) {
        log("full_compaction_skipped_cooldown", {
          cooldownRemainingMs: this.fullCompactionCooldownUntil - nowMs,
          consecutiveIneffectiveFullCompactions: this.consecutiveIneffectiveFullCompactions,
          snapshot: decision.snapshot,
        });
        return { type: "skipped", snapshot: decision.snapshot };
      }
      log("full_compaction_started", {
        messages: messages.length,
        snapshot: decision.snapshot,
      });
      const result = await this.compactionEngine.run({
        trigger: "auto",
        messages,
        signal: input.abortSignal,
        sessionId,
        turnId,
      });
      if (!result.summaryMessage) {
        log("full_compaction_no_summary", {
          error: result.error,
          preTokens: result.preTokens,
        });
        return { type: "skipped", snapshot: decision.snapshot };
      }
      let postCompactMessages = ensureTrailingUserMessage(buildPostCompactMessages(result));
      let snapshot = await evaluateBudget(postCompactMessages);
      let finalResult = result;
      if (snapshot.state === "blocking") {
        log("full_compaction_relaxed_retry", {
          snapshot: snapshot,
          keepTailRatio: RELAXED_FULL_COMPACTION_KEEP_TAIL_RATIO,
        });
        const relaxedResult = await this.compactionEngine.run({
          trigger: "auto",
          messages,
          signal: input.abortSignal,
          keepTailRatio: RELAXED_FULL_COMPACTION_KEEP_TAIL_RATIO,
          protectedToolNames: null,
          sessionId,
          turnId,
        });
        if (!relaxedResult.summaryMessage) {
          log("full_compaction_relaxed_no_summary", {
            error: relaxedResult.error,
            preTokens: relaxedResult.preTokens,
          });
          return { type: "skipped", snapshot };
        }
        const relaxedMessages = ensureTrailingUserMessage(buildPostCompactMessages(relaxedResult));
        const relaxedSnapshot = await evaluateBudget(relaxedMessages);
        log("full_compaction_relaxed_result", {
          previousSnapshot: snapshot,
          relaxedSnapshot: relaxedSnapshot,
        });
        if (relaxedSnapshot.tokens <= snapshot.tokens) {
          finalResult = relaxedResult;
          postCompactMessages = relaxedMessages;
          snapshot = relaxedSnapshot;
        }
      }
      if (snapshot.state === "blocking") {
        // Best-effort compaction still helps later retries, so keep the most
        // compact transcript we produced instead of discarding it.
        this.fullCompactionCooldownUntil = nowMs + FULL_COMPACTION_BLOCKING_COOLDOWN_MS;
        this.consecutiveIneffectiveFullCompactions = Math.max(
          this.consecutiveIneffectiveFullCompactions + 1,
          FULL_COMPACTION_INEFFECTIVE_LIMIT,
        );
        log("full_compaction_still_blocking", {
          snapshot: snapshot,
          cooldownUntilMs: this.fullCompactionCooldownUntil,
          consecutiveIneffectiveFullCompactions: this.consecutiveIneffectiveFullCompactions,
        });
      }
      const initialTokens = Math.max(1, decision.snapshot.tokens);
      const savingsRatio = Math.max(0, (initialTokens - snapshot.tokens) / initialTokens);
      if (savingsRatio < FULL_COMPACTION_MIN_EFFECTIVE_SAVINGS_RATIO) {
        this.consecutiveIneffectiveFullCompactions += 1;
        log("full_compaction_ineffective", {
          savingsRatio,
          consecutiveIneffectiveFullCompactions: this.consecutiveIneffectiveFullCompactions,
        });
      } else {
        this.consecutiveIneffectiveFullCompactions = 0;
        log("full_compaction_effective", {
          savingsRatio,
        });
      }
      if (this.consecutiveIneffectiveFullCompactions >= FULL_COMPACTION_INEFFECTIVE_LIMIT) {
        this.fullCompactionCooldownUntil = nowMs + FULL_COMPACTION_BLOCKING_COOLDOWN_MS;
        log("full_compaction_cooldown_set", {
          cooldownUntilMs: this.fullCompactionCooldownUntil,
          consecutiveIneffectiveFullCompactions: this.consecutiveIneffectiveFullCompactions,
        });
      }
      log("full_compaction_completed", {
        snapshot: snapshot,
        summarySucceeded: finalResult.error === undefined,
        preTokens: finalResult.preTokens,
        postTokens: finalResult.postTokens,
      });
      return {
        type: "compacted",
        messages: postCompactMessages,
        tier: "full",
        snapshot,
        result: finalResult,
      };
    }

    log("full_compaction_unavailable", {
      snapshot: decision.snapshot,
    });
    return { type: "skipped", snapshot: decision.snapshot };
  }

  async recoverFromModelError(input: ContextRecoveryInput): Promise<ContextRecoveryDecision> {
    if (this.overflowRecovery) {
      return this.overflowRecovery.decide(input);
    }
    // Fallback: inline logic when no ContextOverflowRecovery is injected.
    if (input.error.recoverableViaImageStrip) {
      return {
        type: "strip_images_and_retry",
        reason: "multimodal-processor-error",
      };
    }
    if (input.error.code === "image_too_large") {
      return {
        type: "strip_images_and_retry",
        reason: "image-too-large",
      };
    }
    const isContextError =
      input.error.code === "prompt_too_long" ||
      input.error.code === "context_overflow" ||
      input.error.recoverableViaCompact === true;
    if (!isContextError) {
      return {
        type: "give_up",
        reason: `non_recoverable_model_error:${input.error.code}`,
      };
    }
    if (input.hasAttemptedCompact) {
      return {
        type: "give_up",
        reason: "ptl-exhausted-after-two-attempts",
      };
    }
    return {
      type: "truncate_head_and_retry",
      keepRatio: this.truncateFirstKeepRatio,
      reason: "ptl-first-attempt",
    };
  }
}

function isAlwaysOnSession(sessionId: string): boolean {
  return [
    "always-on/discovery:",
    "always-on/workspace:",
    "always-on/execute:",
    "always-on/report:",
    "always-on/apply:",
  ].some(prefix => sessionId.startsWith(prefix));
}

function instructionScopeDescription(scope: InstructionScope): string {
  switch (scope) {
    case "managed":
      return " (managed instructions, set by administrator)";
    case "user":
      return " (user's global instructions for all projects)";
    case "project":
      return " (project instructions, checked into the codebase)";
    case "project-rules":
      return " (project rule, checked into the codebase)";
    case "local":
      return " (user's private project instructions, not checked in)";
  }
}

/**
 * 按记录的投影下标把会话的日期通知织回消息序列：每条通知插在「投影消息 index」
 * 之前，于是后续请求逐字扩展此前的消息前缀（缓存可复用），而不是重写它。
 *
 * @param messages - 投影后的消息序列。
 * @param notices - 会话已记录的日期通知（按插入顺序、下标单调不减）。
 * @returns 模型可见的请求消息序列。
 */
function withDateNotices(messages: CanonicalMessage[], notices: PromptDateNoticeRef[]): CanonicalMessage[] {
  if (notices.length === 0) return messages;
  const out: CanonicalMessage[] = [];
  let cursor = 0;
  for (const notice of notices) {
    out.push(...messages.slice(cursor, notice.index), notice.message);
    cursor = notice.index;
  }
  out.push(...messages.slice(cursor));
  return out;
}

function extractRecentUserText(messages: CanonicalMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim().length > 0) {
        return block.text;
      }
    }
  }
  return undefined;
}

function shouldStopAfterPrePrune(
  triggerReason: "warning_threshold" | "blocking_threshold",
  snapshot: TokenBudgetSnapshot,
): boolean {
  if (snapshot.state === "ok") {
    return true;
  }
  return triggerReason === "warning_threshold" && snapshot.state !== "blocking";
}

function logAutoCompactEvent(
  stage: string,
  context: { sessionId?: string; turnId?: string },
  details: Record<string, unknown>,
  level: "warn" | "debug" = "warn",
): void {
  const payload = {
    sessionId: context.sessionId ?? "",
    turnId: context.turnId ?? "",
    ...details,
  };
  try {
    if (level === "debug") {
      // console.debug 是 console.log 别名，无法降噪；走 SATI_DEBUG 门控。
      debugLog(`[context:auto-compact] ${stage} ${JSON.stringify(payload)}`);
      return;
    }
    logger.warn(`${stage} ${JSON.stringify(payload)}`);
  } catch {
    if (level === "debug") {
      debugLog(`[context:auto-compact] ${stage}`);
      return;
    }
    logger.warn(`${stage}`);
  }
}
