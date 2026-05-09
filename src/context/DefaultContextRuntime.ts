import type { CanonicalMessage } from "../model/index.js";
import { ToolResultBudget } from "./budget/ToolResultBudget.js";
import type { TokenBudgetManager } from "./budget/TokenBudgetManager.js";
import type { AutoCompactionPolicy } from "./compaction/AutoCompactionPolicy.js";
import type { CompactionEngine } from "./compaction/CompactionEngine.js";
import type { CachedMicroCompactionEngine } from "./compaction/CachedMicroCompactionEngine.js";
import { NullExtensionResolver, type ExtensionResolver } from "./extension/ExtensionResolver.js";
import { MemoryAttachmentBuilder } from "./memory/MemoryAttachmentBuilder.js";
import type { MemoryResolver } from "./memory/MemoryResolver.js";
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
} from "./protocol/types.js";

export type DefaultContextRuntimeOptions = {
  extension?: ExtensionResolver;
  promptAssembler?: PromptAssembler;
  messageProjector?: MessageProjector;
  toolResultBudget?: ToolResultBudget;
  memoryResolver?: MemoryResolver;
  /**
   * A2 — token budget manager (provider-aware tokenizer fallback).
   * Held by the runtime so future compaction decisions can probe usage.
   */
  tokenBudget?: TokenBudgetManager;
  /**
   * A5 — full-conversation compaction engine. Constructed by the host
   * (createLocalGateway) and stashed on the runtime so the loop can
   * eventually call summarize() once we wire reactive compaction.
   */
  compactionEngine?: CompactionEngine;
  /**
   * A5 — token-budget-driven policy that decides when to summarize.
   * Same lifecycle as `compactionEngine` — construction-only for now.
   */
  autoCompactionPolicy?: AutoCompactionPolicy;
  /**
   * A4 — opt-in cached micro-compaction engine. Construction is gated by
   * `PolitConfig.context.cachedMicrocompactEnabled` upstream.
   */
  microcompactEngine?: CachedMicroCompactionEngine;
  /** Project root forwarded to MemoryResolver.retrieve. */
  projectRoot?: string;
  /**
   * keepRatio used on the first reactive truncate. Legacy hint is 0.5 — keep
   * the back half of the conversation. Decision §3.2.
   */
  truncateFirstKeepRatio?: number;
  /** Aggressive ratio used after one truncate-and-retry already failed. */
  truncateSecondKeepRatio?: number;
  now?: () => Date;
};

const DEFAULT_TRUNCATE_FIRST_RATIO = 0.5;
const DEFAULT_TRUNCATE_SECOND_RATIO = 0.25;

export class DefaultContextRuntime implements ContextRuntime {
  private readonly extension: ExtensionResolver;
  private readonly promptAssembler: PromptAssembler;
  private readonly messageProjector: MessageProjector;
  private readonly toolResultBudget?: ToolResultBudget;
  private readonly memoryResolver?: MemoryResolver;
  private readonly memoryAttachmentBuilder?: MemoryAttachmentBuilder;
  /** A2/A4/A5 — held for downstream wiring (compaction loop, microcompact). */
  readonly tokenBudget?: TokenBudgetManager;
  readonly compactionEngine?: CompactionEngine;
  readonly autoCompactionPolicy?: AutoCompactionPolicy;
  readonly microcompactEngine?: CachedMicroCompactionEngine;
  private readonly projectRoot?: string;
  private readonly truncateFirstKeepRatio: number;
  private readonly truncateSecondKeepRatio: number;
  private readonly now: () => Date;

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
    this.projectRoot = options.projectRoot;
    this.truncateFirstKeepRatio = options.truncateFirstKeepRatio ?? DEFAULT_TRUNCATE_FIRST_RATIO;
    this.truncateSecondKeepRatio = options.truncateSecondKeepRatio ?? DEFAULT_TRUNCATE_SECOND_RATIO;
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

    const prompt = this.promptAssembler.assemble({
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      permissionMode: input.permissionMode,
      additionalWorkingDirectories: input.additionalWorkingDirectories,
      tools: input.tools,
      customSystemPrompt: input.customSystemPrompt,
      appendSystemPrompt: input.appendSystemPrompt,
      now: this.now,
    });

    const parts = [...prompt.parts];
    if (this.memoryAttachmentBuilder) {
      const memory = await this.memoryAttachmentBuilder.build({
        query: extractRecentUserText(projection.messages) ?? "",
        sessionId: input.sessionId,
        projectRoot: this.projectRoot ?? input.cwd,
        recentMessages: projection.messages,
      });
      for (const block of memory.attachments) {
        for (const content of block.content) {
          if (content.type === "text" && content.text.trim().length > 0) {
            parts.push(content.text);
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
    }

    const joined = parts.join("\n\n");

    return {
      messages: projection.messages,
      systemPrompt: joined,
      systemPromptParts: parts,
      tools: input.tools,
      diagnostics,
      boundaries: [],
      metadata: {
        droppedCount: projection.droppedCount,
        toolCount: input.tools.length,
      },
    };
  }

  async applyToolResults(input: ContextToolResultInput): Promise<ContextToolResultResult> {
    const diagnostics: ContextDiagnostic[] = [];
    let appended: CanonicalMessage = input.toolResultMessage;
    if (this.toolResultBudget) {
      try {
        appended = await this.toolResultBudget.applyToMessage(input.toolResultMessage);
      } catch (error) {
        diagnostics.push({
          code: "tool_result_persistence_failed",
          severity: "error",
          message: `Failed to persist large tool result: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { messages: [...input.messages, appended], diagnostics };
  }

  async captureTurn(input: ContextCaptureTurnInput): Promise<void> {
    if (!this.memoryResolver) return;
    try {
      await this.memoryResolver.captureTurn({
        sessionId: input.sessionId,
        projectRoot: this.projectRoot ?? "",
        messages: input.messages,
      });
    } catch {
      // Memory capture must never break the agent turn — provider already
      // swallows in EdgeClawMemoryProvider, this catch is belt-and-suspenders.
    }
  }

  async recoverFromModelError(input: ContextRecoveryInput): Promise<ContextRecoveryDecision> {
    if (input.error.code !== "prompt_too_long") {
      return {
        type: "give_up",
        reason: `non_recoverable_model_error:${input.error.code}`,
      };
    }
    if (!input.hasAttemptedCompact) {
      return {
        type: "truncate_head_and_retry",
        keepRatio: this.truncateFirstKeepRatio,
        reason: "ptl-first-attempt",
      };
    }
    // Decision §3.2 / §3.1 #8 — second PTL: aggressive truncate; if it still
    // fails, the loop must turn_failed (no third try).
    return {
      type: "truncate_head_and_retry",
      keepRatio: this.truncateSecondKeepRatio,
      reason: "ptl-second-attempt-aggressive",
    };
  }
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
