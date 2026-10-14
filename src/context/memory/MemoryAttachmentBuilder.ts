import type { CanonicalMessage } from "../../model/index.js";
import type { MemoryDiagnostic, MemoryHit, MemoryResolver, MemoryRetrieveInput, TaskIntent } from "./MemoryResolver.js";
import type { RecallLogSink, RecallLogSkipReason } from "./recall-log.js";

export type MemoryAttachmentBuilderResult = {
  attachments: CanonicalMessage[];
  diagnostics: MemoryDiagnostic[];
  /** 结构化命中列表（resolver 提供时透传，供引用回填与召回日志）。 */
  hits?: MemoryHit[];
};

export type MemoryAttachmentBuilderInput = MemoryRetrieveInput & {
  timeoutMs?: number;
  /** 当前 turn id（召回日志用；resolver 契约不含此字段）。 */
  turnId?: string;
};

export type MemoryAttachmentBuilderOptions = {
  /** 召回日志出口（可选；不传则完全不记日志，行为与现状一致）。 */
  recallLog?: RecallLogSink;
};

/** query 达到该长度（字符）时视为有效检索词，不做回退。 */
const MIN_RETRIEVE_QUERY_LENGTH = 8;
/** 短 query 回退时最多拼接的最近用户消息条数。 */
const MAX_RETRIEVE_FALLBACK_MESSAGES = 3;
/** 短 query 回退拼接结果的最大字符数。 */
const MAX_RETRIEVE_FALLBACK_CHARS = 500;

/** 提取单条消息的文本内容（仅 text 块，工具结果等不参与回退）。 */
function extractMessageText(message: CanonicalMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text" && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  return parts.join("\n").trim();
}

/**
 * 短 query 检索回退：query 过短（多轮指代如"继续"、短回复）时，
 * 用最近用户消息拼接作为检索 query，提高知识召回率。
 * 正常长 query 原样返回；无可用历史时保持原 query。
 */
export function buildRetrieveQuery(query: string, recentMessages: CanonicalMessage[]): string {
  const trimmed = query.trim();
  if (Array.from(trimmed).length >= MIN_RETRIEVE_QUERY_LENGTH) return query;

  const texts: string[] = [];
  for (let index = recentMessages.length - 1; index >= 0 && texts.length < MAX_RETRIEVE_FALLBACK_MESSAGES; index -= 1) {
    const message = recentMessages[index];
    if (message.role !== "user") continue;
    const text = extractMessageText(message);
    if (text) texts.push(text);
  }
  if (texts.length === 0) return query;

  const joined = texts.reverse().join("\n").trim();
  return joined.slice(0, MAX_RETRIEVE_FALLBACK_CHARS) || query;
}

/** 任务意图关键词表（按优先级匹配，先命中者胜）。 */
const TASK_INTENT_KEYWORDS: ReadonlyArray<readonly [TaskIntent, readonly string[]]> = [
  ["oa", ["答复", "审查意见", "OA", "驳回", "意见陈述", "通知书"]],
  ["invalidity", ["无效", "无效理由", "无效宣告"]],
  ["draft", ["撰写", "起草", "权利要求", "交底书", "说明书", "布局"]],
];

/**
 * 任务意图启发式推导（保守）：query 命中明确任务词才判定对应 intent，
 * 未命中回退 general（行为与现状一致）。短 query 场景调用方应先经
 * buildRetrieveQuery 拼接最近用户消息再推导。
 */
export function buildRetrieveTaskIntent(query: string): TaskIntent {
  const trimmed = query.trim();
  if (!trimmed) return "general";
  for (const [intent, keywords] of TASK_INTENT_KEYWORDS) {
    if (keywords.some(keyword => trimmed.includes(keyword))) return intent;
  }
  return "general";
}

/**
 * Build attachment messages from MemoryResolver output. Used by both:
 *   - PromptAssembler input (Phase 6): turn-start memory section
 *   - CompactionEngine.buildPostCompactMessages: post-compact reinjection
 *
 * Failure is non-fatal; diagnostics surface upstream.
 */
export class MemoryAttachmentBuilder {
  private readonly recallLog?: RecallLogSink;

  constructor(
    private readonly resolver: MemoryResolver,
    options: MemoryAttachmentBuilderOptions = {},
  ) {
    this.recallLog = options.recallLog;
  }

  async build(input: MemoryAttachmentBuilderInput): Promise<MemoryAttachmentBuilderResult> {
    if (input.signal?.aborted) {
      this.record(input, { injected: false, skipReason: "aborted" });
      return { attachments: [], diagnostics: [] };
    }
    const controller = new AbortController();
    const detachAbort = forwardAbort(input.signal, controller);
    const timeoutMs = input.timeoutMs;
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => controller.abort(new Error(`Memory retrieval timed out after ${timeoutMs}ms.`)), timeoutMs)
        : undefined;
    try {
      const effectiveQuery = buildRetrieveQuery(input.query, input.recentMessages);
      const result = await Promise.race([
        this.resolver.retrieve({
          ...input,
          query: effectiveQuery,
          // 调用方未显式传 taskIntent 时按（回退后的）query 启发式推导，
          // 使短 query（如"继续"）场景也能命中 OA/无效/撰写意图。
          taskIntent: input.taskIntent ?? buildRetrieveTaskIntent(effectiveQuery),
          signal: controller.signal,
        }),
        waitForAbort(controller.signal),
      ]);
      if (!result.systemContext || result.systemContext.trim().length === 0) {
        this.record(input, {
          injected: false,
          skipReason: "empty_context",
          query: effectiveQuery,
          hits: result.hits,
          diagnostics: result.diagnostics,
        });
        return { attachments: [], diagnostics: result.diagnostics ?? [] };
      }
      const attachments: CanonicalMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `<memory-context>\n${result.systemContext.trim()}\n</memory-context>`,
            },
          ],
        },
      ];
      this.record(input, {
        injected: true,
        query: effectiveQuery,
        hits: result.hits,
        diagnostics: result.diagnostics,
      });
      return { attachments, diagnostics: result.diagnostics ?? [], hits: result.hits };
    } catch (error) {
      if (controller.signal.aborted) {
        if (input.signal?.aborted) {
          this.record(input, { injected: false, skipReason: "aborted" });
          return { attachments: [], diagnostics: [] };
        }
        const diagnostics: MemoryDiagnostic[] = [
          {
            code: "memory_provider_error",
            severity: "warning",
            message:
              timeoutMs && timeoutMs > 0
                ? `MemoryResolver.retrieve timed out after ${timeoutMs}ms.`
                : "MemoryResolver.retrieve was aborted.",
          },
        ];
        this.record(input, { injected: false, skipReason: "timeout", diagnostics });
        return { attachments: [], diagnostics };
      }
      const diagnostics: MemoryDiagnostic[] = [
        {
          code: "memory_provider_error",
          severity: "warning",
          message: `MemoryResolver.retrieve failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
      this.record(input, { injected: false, skipReason: "error", diagnostics });
      return { attachments: [], diagnostics };
    } finally {
      if (timer) clearTimeout(timer);
      detachAbort?.();
    }
  }

  /**
   * 召回日志出口：所有路径（注入/空/超时/错误/取消）统一经此处落日志。
   * sink 自身失败绝不反噬主流程（可观测是旁路，不是依赖）。
   */
  private record(
    input: MemoryAttachmentBuilderInput,
    entry: {
      injected: boolean;
      skipReason?: RecallLogSkipReason;
      query?: string;
      hits?: MemoryHit[];
      diagnostics?: MemoryDiagnostic[];
    },
  ): void {
    if (!this.recallLog) return;
    try {
      this.recallLog.log({
        sessionId: input.sessionId,
        turnId: input.turnId,
        query: entry.query ?? input.query,
        hits: entry.hits,
        injected: entry.injected,
        skipReason: entry.skipReason,
        diagnostics: entry.diagnostics,
      });
    } catch {
      // 降级但不静默：sink 抛错被吞是登记在案的行为（recall log 为 best-effort
      // 旁路），失败本身由 FileRecallLogSink 的一次性 warn 承载。
    }
  }
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): (() => void) | undefined {
  if (!source) return undefined;
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const onAbort = () => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

async function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    throw createAbortError(signal.reason);
  }
  return await new Promise<never>((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const message = typeof reason === "string" && reason ? reason : "Operation aborted.";
  return new DOMException(message, "AbortError");
}
