import { TtlCache } from "../../shared/ttl-cache.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import {
  canonicalMessagesToMemoryMessages,
  type MemoryCaptureTurnInput,
  type MemoryResolver,
  type MemoryRetrieveInput,
  type MemoryRetrieveResult,
  type ContextMemoryMessage,
} from "./MemoryResolver.js";

type EdgeClawCaseTraceRecord = {
  sessionKey: string;
  query: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "interrupted" | "error";
  retrieval?: {
    intent?: string;
    injected: boolean;
    contextPreview: string;
    preflightReason?: string;
    trace: unknown;
  };
  toolEvents: unknown[];
  assistantReply: string;
};

export type EdgeClawRetrieveContextResult = {
  systemContext?: string;
  context?: string;
  trace?: unknown;
  debug?: {
    mode?: string;
    route?: string;
    [key: string]: unknown;
  };
  intent?: string;
};

export type EdgeClawCaptureTurnResult = {
  captured: boolean;
  normalizedMessages: ContextMemoryMessage[];
  sessionKey: string;
};

export type EdgeClawMemoryServiceLike = {
  retrieveContext(
    query: string,
    options?: {
      recentMessages?: ContextMemoryMessage[];
      workspaceHint?: string;
      retrievalMode?: "auto" | "explicit";
      signal?: AbortSignal;
    },
  ): Promise<EdgeClawRetrieveContextResult>;
  captureTurn(
    rawMessages: readonly unknown[],
    input: {
      sessionKey: string;
      timestamp?: string;
      source?: string;
    },
  ): EdgeClawCaptureTurnResult;
  saveCaseTrace?(record: EdgeClawCaseTraceRecord): void;
};

export type EdgeClawMemoryProviderOptions = {
  service: EdgeClawMemoryServiceLike;
  retrievalMode?: "auto" | "explicit";
  source?: string;
  now?: () => Date;
  telemetry?: TelemetryClient;
  /**
   * `retrieve` 结果进程内 TTL 缓存（毫秒）。默认 30_000，与 memory-core
   * 内部 recall cache（reasoning-loop）对齐。多轮工具循环中 query 不变时
   * 第二轮起直接命中，省去每轮的 memory-gate LLM 调用与语义检索。
   */
  retrieveCacheTtlMs?: number;
};

const DEFAULT_RETRIEVE_CACHE_TTL_MS = 30_000;
/** 缓存条目上限；超出后淘汰最旧条目（TtlCache 语义）。 */
const MAX_RETRIEVE_CACHE_ENTRIES = 256;

export class EdgeClawMemoryProvider implements MemoryResolver {
  private readonly now: () => Date;
  private readonly retrieveCache: TtlCache<string, MemoryRetrieveResult>;
  /** 同 key 并发去重：多个并发 retrieve 共享一次底层调用。 */
  private readonly inFlightRetrieves = new Map<string, Promise<MemoryRetrieveResult>>();
  private readonly pendingRetrievals = new Map<
    string,
    {
      query: string;
      startedAt: string;
      result: EdgeClawRetrieveContextResult;
    }
  >();

  constructor(private readonly options: EdgeClawMemoryProviderOptions) {
    this.now = options.now ?? (() => new Date());
    this.retrieveCache = new TtlCache<string, MemoryRetrieveResult>({
      ttlMs: options.retrieveCacheTtlMs ?? DEFAULT_RETRIEVE_CACHE_TTL_MS,
      maxSize: MAX_RETRIEVE_CACHE_ENTRIES,
      now: () => this.now().getTime(),
    });
  }

  async retrieve(input: MemoryRetrieveInput): Promise<MemoryRetrieveResult> {
    const startedAt = this.now().toISOString();
    this.options.telemetry?.trackFeatureLoopStage({
      module: "memory",
      ownerModule: "memory",
      executionKind: "memory",
      phase: "retrieve",
      loopStage: "loop_start",
      outcome: "success",
      sessionId: input.sessionId,
    });

    const cacheKey = buildRetrieveCacheKey(input);
    // 命中返回共享引用（含 trace/debug 对象）。调用方（MemoryAttachmentBuilder
    // 等）只读消费，不得改写——缓存条目为进程内只读快照约定。
    const cached = this.retrieveCache.get(cacheKey);
    if (cached !== undefined) {
      this.trackRetrieveLoopEnd(input.sessionId, { cacheHit: true });
      return cached;
    }

    // 同 key 并发去重：共享首个调用方的底层调用与 abort signal——若首个调用
    // 方超时/中止，跟随方也会拿到降级诊断（MemoryAttachmentBuilder 均优雅
    // 降级为 warning，不抛出）；去重的是"结果"，不是各自的中止边界。
    const inFlight = this.inFlightRetrieves.get(cacheKey);
    if (inFlight) return inFlight;

    const pending = this.performRetrieve(input, cacheKey, startedAt);
    this.inFlightRetrieves.set(cacheKey, pending);
    try {
      return await pending;
    } finally {
      this.inFlightRetrieves.delete(cacheKey);
    }
  }

  private async performRetrieve(
    input: MemoryRetrieveInput,
    cacheKey: string,
    startedAt: string,
  ): Promise<MemoryRetrieveResult> {
    try {
      const recentMessages = canonicalMessagesToMemoryMessages(input.recentMessages);
      const result = await this.options.service.retrieveContext(input.query, {
        recentMessages,
        workspaceHint: input.projectRoot,
        retrievalMode: this.options.retrievalMode ?? "auto",
        signal: input.signal,
      });
      this.pendingRetrievals.set(input.sessionId, {
        query: input.query,
        startedAt,
        result,
      });
      const systemContext = (result.systemContext ?? result.context ?? "").trim();
      if (!systemContext) {
        this.trackRetrieveLoopEnd(input.sessionId, { injected: false });
        const empty: MemoryRetrieveResult = {
          diagnostics: [
            {
              code: "memory_context_empty",
              severity: "info",
              message: "EdgeClaw memory returned no relevant context.",
            },
          ],
          metadata: { trace: result.trace, debug: result.debug },
        };
        this.setCachedRetrieve(cacheKey, empty);
        return empty;
      }

      this.trackRetrieveLoopEnd(input.sessionId, { injected: true });
      const success: MemoryRetrieveResult = {
        systemContext,
        diagnostics: [],
        metadata: { trace: result.trace, debug: result.debug },
      };
      this.setCachedRetrieve(cacheKey, success);
      return success;
    } catch (error) {
      this.options.telemetry?.trackError(error, {
        module: "memory",
        ownerModule: "memory",
        executionKind: "memory",
        phase: "retrieve",
        loopStage: "loop_end",
        errorCategory: "loop_error",
        sessionId: input.sessionId,
      });
      return {
        diagnostics: [
          {
            code: "memory_provider_error",
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

  private trackRetrieveLoopEnd(sessionId: string, metadata: Record<string, unknown>): void {
    this.options.telemetry?.trackFeatureLoopStage({
      module: "memory",
      ownerModule: "memory",
      executionKind: "memory",
      phase: "retrieve",
      loopStage: "loop_end",
      outcome: "success",
      sessionId,
      metadata,
    });
  }

  private setCachedRetrieve(cacheKey: string, result: MemoryRetrieveResult): void {
    this.retrieveCache.set(cacheKey, result);
  }

  async captureTurn(input: MemoryCaptureTurnInput): Promise<void> {
    const normalizedMessages = canonicalMessagesToMemoryMessages(input.messages, {
      includeForkCarryover: false,
    });
    this.options.telemetry?.trackFeatureLoopStage({
      module: "memory",
      ownerModule: "memory",
      executionKind: "memory",
      phase: "capture",
      loopStage: "loop_start",
      outcome: "success",
      sessionId: input.sessionId,
    });
    try {
      this.options.service.captureTurn(normalizedMessages, {
        sessionKey: input.sessionId,
        timestamp: this.now().toISOString(),
        source: this.options.source ?? "sati",
      });
      this.options.telemetry?.trackFeatureLoopStage({
        module: "memory",
        ownerModule: "memory",
        executionKind: "memory",
        phase: "capture",
        loopStage: "loop_end",
        outcome: "success",
        sessionId: input.sessionId,
      });
    } catch {
      this.options.telemetry?.trackFeatureLoopStage({
        module: "memory",
        ownerModule: "memory",
        executionKind: "memory",
        phase: "capture",
        loopStage: "loop_end",
        outcome: "failed",
        errorCategory: "loop_error",
        sessionId: input.sessionId,
      });
      // Memory capture should not break the agent turn.
    }
    this.savePendingCaseTrace(input, normalizedMessages);
  }

  private savePendingCaseTrace(input: MemoryCaptureTurnInput, normalizedMessages: ContextMemoryMessage[]): void {
    const saveCaseTrace = this.options.service.saveCaseTrace?.bind(this.options.service);
    if (!saveCaseTrace) return;
    const pending = this.pendingRetrievals.get(input.sessionId);
    if (!pending) return;
    this.pendingRetrievals.delete(input.sessionId);

    const contextPreview = (pending.result.systemContext ?? pending.result.context ?? "").trim();
    try {
      saveCaseTrace({
        sessionKey: input.sessionId,
        query: pending.query,
        startedAt: pending.startedAt,
        finishedAt: this.now().toISOString(),
        status: input.errored ? "error" : "completed",
        retrieval: {
          intent: pending.result.intent ?? pending.result.debug?.route ?? pending.result.debug?.mode ?? "none",
          injected: contextPreview.length > 0,
          contextPreview,
          trace: pending.result.trace ?? null,
        },
        toolEvents: [],
        assistantReply: extractLastAssistantText(normalizedMessages),
      });
    } catch {
      // Trace persistence is observational and must not break memory capture.
    }
  }
}

function extractLastAssistantText(messages: readonly ContextMemoryMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.content.trim().length > 0) {
      return message.content;
    }
  }
  return "";
}

/**
 * 检索缓存键：session + query + workspace。query 已含调用方的短 query 回退
 * 拼接（buildRetrieveQuery），多轮工具循环中同一用户意图下保持不变。
 */
function buildRetrieveCacheKey(input: MemoryRetrieveInput): string {
  return `${input.sessionId}\u0000${input.query}\u0000${input.projectRoot ?? ""}`;
}
