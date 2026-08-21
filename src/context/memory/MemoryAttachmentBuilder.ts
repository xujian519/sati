import type { CanonicalMessage } from "../../model/index.js";
import type { MemoryDiagnostic, MemoryResolver, MemoryRetrieveInput, TaskIntent } from "./MemoryResolver.js";

export type MemoryAttachmentBuilderResult = {
  attachments: CanonicalMessage[];
  diagnostics: MemoryDiagnostic[];
};

export type MemoryAttachmentBuilderInput = MemoryRetrieveInput & {
  timeoutMs?: number;
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
  constructor(private readonly resolver: MemoryResolver) {}

  async build(input: MemoryAttachmentBuilderInput): Promise<MemoryAttachmentBuilderResult> {
    if (input.signal?.aborted) {
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
      return { attachments, diagnostics: result.diagnostics ?? [] };
    } catch (error) {
      if (controller.signal.aborted) {
        if (input.signal?.aborted) {
          return { attachments: [], diagnostics: [] };
        }
        return {
          attachments: [],
          diagnostics: [
            {
              code: "memory_provider_error",
              severity: "warning",
              message:
                timeoutMs && timeoutMs > 0
                  ? `MemoryResolver.retrieve timed out after ${timeoutMs}ms.`
                  : "MemoryResolver.retrieve was aborted.",
            },
          ],
        };
      }
      return {
        attachments: [],
        diagnostics: [
          {
            code: "memory_provider_error",
            severity: "warning",
            message: `MemoryResolver.retrieve failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    } finally {
      if (timer) clearTimeout(timer);
      detachAbort?.();
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
