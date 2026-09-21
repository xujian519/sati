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
  /**
   * 工作区专利判据结果（#450）。`false` 时技能/角色清单不列专利条目；缺省 = `true`
   * （保持既有行为，判据由 `projectRuntimeFactory` 装配时算出）。
   */
  patentDomainEnabled?: boolean;
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
/** 全量压缩之间至少要有的真实工具轮数：不足即视为空转（补 token 比例之外的正交判据）。 */
const FULL_COMPACTION_MIN_TOOL_TURNS = 1;
/** 连续空转到该次数即熔断全量压缩（有界：不再无限烧摘要调用）。 */
const FULL_COMPACTION_RAPID_REFILL_LIMIT = 2;

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
  /** 会话提示日期锚点与已追加的跨日通知；解析与提交规则见 `resolvePromptTime`。 */
  private readonly promptTimeState = new Map<string, PromptTimeState>();
  private fullCompactionCooldownUntil = 0;
  private consecutiveIneffectiveFullCompactions = 0;
  /**
   * 会话级：自上次全量压缩以来完成的真实工具轮数（由 agent loop 经 `noteToolTurn` 上报）。
   * 与 `consecutiveIneffectiveFullCompactions`（只看省下的 token 比例）正交：比例判据识别不出
   * 「省下来了、但没换来推进」——连续两次压缩之间若没有任何工具轮，模型只是把同样的内容
   * 又读了回来，继续压缩只会烧摘要调用并丢历史。
   */
  private toolTurnsSinceLastCompaction = 0;
  /** 会话级：连续「压缩之间没有工具轮」的次数。达到上限即熔断，直到出现一次真实工具轮。 */
  private consecutiveRapidRefills = 0;

  constructor(options: DefaultContextRuntimeOptions = {}) {
    this.extension = options.extension ?? new NullExtensionResolver();
    this.promptAssembler =
      options.promptAssembler ??
      new PromptAssembler(this.extension, { patentDomainEnabled: options.patentDomainEnabled });
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

    // 提示日期锚点 + 跨日通知（提交时机与重定位规则见 resolvePromptTime）。
    const promptTime = this.resolvePromptTime(input, projection.messages);

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
      now: () => new Date(promptTime.timestamp),
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
        // 中止路径不提交提示时间状态（提交在方法末尾）：本次装配不发给模型。
        return {
          messages: promptTime.messages,
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
        // 指令发现抛错（内层 tryAdd 已吞掉 ENOENT/EACCES 等常规失败，此处为兜底）→ 记 warning 诊断并整段跳过 <project-instructions>，本轮装配照常发出。
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
      messages: promptTime.messages,
    });

    // 请求确实要发出时才提交提示时间状态：预演与中止的装配都会被丢弃，提前提交会让
    // 真实请求继承未发出装配的下标。
    if (promptTime.state !== undefined) {
      this.promptTimeState.set(input.sessionId, promptTime.state);
    }

    return {
      messages: promptTime.messages,
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

  /**
   * 解析本次组装的提示日期锚点与跨日通知（上游 PilotDeck v2026.09.14 / PR #571
   * 语义移植）。
   *
   * `<environment>now:` 位于 system prompt 前缀中、是 prompt cache 的缓存键，故
   * 日期锚定在会话首次正式组装请求，此后追加消息、重试、跨天都不改写，整段前缀在
   * 会话内逐字稳定；只有完整压缩产生新 checkpoint（前缀本来就要重写）才重新锚定。
   * 跨 UTC 日改为在消息尾部追加一条日期通知告知真实日期（见 promptDateNotice.ts），
   * 陈旧上界收敛到 0 天。需要精确到分秒的工作走 get_current_time 工具。
   *
   * 非 `previewOnly` 时把本次锚点与通知位置一并以 `state` 返回，由调用方在请求确实
   * 要发出时提交；被丢弃的装配（预演、中止）不得提交，否则真实请求会继承它们的下标。
   *
   * @param input - 组装输入（取其 sessionId 与 previewOnly）。
   * @param messages - 投影后的消息序列。
   * @returns 模型可见的请求消息（投影 + 通知）、system prompt 用的锚点时刻，以及待提交
   *   的会话状态（预演时为 undefined）。
   */
  private resolvePromptTime(
    input: ContextPrepareInput,
    messages: CanonicalMessage[],
  ): { messages: CanonicalMessage[]; timestamp: number; state?: PromptTimeState } {
    const fingerprints = fingerprintMessages(messages);
    const previous = this.promptTimeState.get(input.sessionId);
    const unchangedPrefixLength = countUnchangedPrefix(fingerprints, previous?.messages);
    // 前两条未变说明头部仍是上次那个 checkpoint，不能借它刷新日期。
    const newCheckpoint = previous !== undefined && isCompactionCheckpointHead(messages) && unchangedPrefixLength < 2;
    const refreshTime = newCheckpoint && !input.previewOnly;
    const now = this.now();
    const currentDate = utcDay(now);
    const timestamp = previous === undefined || refreshTime ? now.getTime() : previous.timestamp;
    // 通知保留在原始位置，让后续请求在前缀上继续累积；下标超出未变前缀的（被重写
    // 波及）丢弃，随后按需在新末尾补一条当前日期。
    const dateUpdates = refreshTime
      ? []
      : (previous?.dateUpdates ?? []).filter(update => update.index <= unchangedPrefixLength);
    const lastDate = dateUpdates.at(-1)?.date ?? utcDay(new Date(timestamp));
    if (currentDate !== lastDate) {
      dateUpdates.push({
        index: messages.length,
        date: currentDate,
        message: buildPromptDateNotice(currentDate),
      });
    }
    const state = input.previewOnly ? undefined : { timestamp, messages: fingerprints, dateUpdates };
    return { messages: withDateNotices(messages, dateUpdates), timestamp, state };
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

  /**
   * 记一次真实工具轮（`AgentLoop` 每执行完一批工具调用上报一次）。
   *
   * 只增计数、不做决策：熔断判定在 `tryAutoCompact` 的 Tier 3 门口读这两个计数器。
   */
  noteToolTurn(): void {
    this.toolTurnsSinceLastCompaction += 1;
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
      // 空转熔断（在冷却判定之前，两者的原因不同、日志要分得开）。门开条件包含
      // 「距上次压缩仍无工具轮」——出现真实工具轮后门即自行打开（否则一旦熔断
      // 就再无法恢复，用户后续的正当压缩需求会被永久拒绝）。
      if (
        this.consecutiveRapidRefills >= FULL_COMPACTION_RAPID_REFILL_LIMIT &&
        this.toolTurnsSinceLastCompaction < FULL_COMPACTION_MIN_TOOL_TURNS
      ) {
        log("full_compaction_circuit_open", {
          consecutiveRapidRefills: this.consecutiveRapidRefills,
          toolTurnsSinceLastCompaction: this.toolTurnsSinceLastCompaction,
          snapshot: decision.snapshot,
        });
        return { type: "skipped", snapshot: decision.snapshot };
      }
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
      // 空转记账：本次全量压缩与上次之间是否有真实工具轮（走了这里就确实压了一次）。
      if (this.toolTurnsSinceLastCompaction < FULL_COMPACTION_MIN_TOOL_TURNS) {
        this.consecutiveRapidRefills += 1;
        log("full_compaction_rapid_refill", {
          consecutiveRapidRefills: this.consecutiveRapidRefills,
          snapshot: snapshot,
        });
      } else {
        this.consecutiveRapidRefills = 0;
      }
      this.toolTurnsSinceLastCompaction = 0;
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
 * UTC 日期（`YYYY-MM-DD`），与 PromptAssembler 取 `<environment>now:` 的口径一致。
 *
 * @param time - 待取日的时刻。
 * @returns UTC 日期字符串。
 */
function utcDay(time: Date): string {
  return time.toISOString().slice(0, 10);
}

/**
 * 投影消息的逐条内容指纹，用于识别两次组装之间未变的头部。只存摘要，不保留内容副本。
 *
 * @param messages - 投影后的消息序列。
 * @returns 与消息一一对应的 sha256 摘要。
 */
function fingerprintMessages(messages: CanonicalMessage[]): string[] {
  return messages.map(message =>
    createHash("sha256")
      .update(stableSerialize({ role: message.role, content: message.content }))
      .digest("hex"),
  );
}

/**
 * 两次组装的共同前缀长度：头部被重写（裁剪/微压缩/完整压缩）的位置。
 *
 * @param next - 本次投影的逐条指纹。
 * @param previous - 上次提交的逐条指纹；无上次提交时为 undefined。
 * @returns 逐条相同的消息条数。
 */
function countUnchangedPrefix(next: readonly string[], previous: readonly string[] | undefined): number {
  if (previous === undefined) return 0;
  let length = 0;
  while (length < next.length && next[length] === previous[length]) {
    length += 1;
  }
  return length;
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
    // payload 不可 JSON 序列化（循环引用 / BigInt）→ 丢弃字段只记 stage，诊断日志不得反过来打断 auto-compact。
    if (level === "debug") {
      debugLog(`[context:auto-compact] ${stage}`);
      return;
    }
    logger.warn(`${stage}`);
  }
}
