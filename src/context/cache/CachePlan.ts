import { createHash } from "node:crypto";
import type { CanonicalMessage, CanonicalToolSchema, PromptCachePlan } from "../../model/index.js";
import { isTailInjection } from "../prompt/tailInjection.js";
export type { PromptCachePlan } from "../../model/index.js";

/**
 * Prompt cache 布局规划（2026-09，移植自 PilotDeck desktop-v2026.09.02 #527
 * 的 system + recent3 布局）。
 *
 * Anthropic 按前缀缓存计价（命中读约 0.1x）。此前 Sati 只在微压缩边界
 * 间歇打 `cacheBreakpoints`，请求间布局不稳定、命中率低。本模块为每个
 * 请求规划固定布局：system 尾块 + 最近 N 条非 system 消息打点（4 块上限
 * 内），并以稳定序列化指纹标识缓存前缀身份。
 *
 * 前缀稳定性约束：逐调用可变的注入（workspace-state 账本块、plan-todo 追加段、记忆附件、
 * 方法论追加段）不进 system prompt，而是合成为**消息尾部**的合成消息
 * （`src/context/prompt/tailInjection.ts`）；这类消息也不作为消息断点
 * （`selectRecentMessageBreakpoints` 跳过它们）。
 */

/** 最近 N 条非 system 消息打点（Anthropic 单请求最多 4 个 cache_control 块：system + 3 消息）。 */
export const RECENT_MESSAGE_BREAKPOINT_COUNT = 3;

/** 环境开关：SATI_PROMPT_CACHE=off 关闭 per-request cache 布局（回退旧行为）。 */
export function promptCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SATI_PROMPT_CACHE !== "off";
}

/** Select the final messages for the recent-message layout (system prompt is a separate request field). */
export function selectRecentMessageBreakpoints(messages: CanonicalMessage[]): number[] {
  return (
    messages
      .map((message, index) => ({ message, index }))
      // 尾部注入是「只存在于本次请求投影」的合成消息（每轮重建、位置永远在末尾），
      // 以它为断点的缓存前缀在后续请求里不可能重现——占掉 1 个断点名额却永不命中。
      .filter(entry => !isTailInjection(entry.message))
      .slice(-RECENT_MESSAGE_BREAKPOINT_COUNT)
      .map(entry => entry.index)
  );
}

/** Stable, non-cryptographic serialization for cache-plan identity. */
export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

/** Keep the cache plan compact even when recent messages carry base64 media. */
function fingerprintFor(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value), "utf8").digest("hex");
}

export type PromptCachePlanInput = {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  tools: CanonicalToolSchema[];
  messages: CanonicalMessage[];
};

/** Build the per-request cache plan: system tail + recent-N message breakpoints. */
export function buildPromptCachePlan(input: PromptCachePlanInput, generation: number): PromptCachePlan {
  const messages = selectRecentMessageBreakpoints(input.messages);
  const stableTools = [...input.tools].sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    return byName !== 0 ? byName : stableSerialize(left).localeCompare(stableSerialize(right));
  });
  return {
    provider: input.provider,
    model: input.model,
    system: Boolean(input.systemPrompt),
    messages,
    fingerprint: fingerprintFor({
      provider: input.provider ?? "",
      model: input.model ?? "",
      system: input.systemPrompt ?? "",
      tools: stableTools,
      messages: messages.map(index => input.messages[index]),
    }),
    generation,
  };
}

export type ResolveRequestCachePlanInput = PromptCachePlanInput & {
  enabled: boolean;
  /** Explicit breakpoints (micro-compaction) take precedence over the plan. */
  explicitBreakpoints?: number[];
};

/**
 * Per-request resolution: disabled → undefined; explicit breakpoints present →
 * undefined (keep the micro-compaction layout); otherwise the stable plan.
 */
export function resolveRequestCachePlan(
  input: ResolveRequestCachePlanInput,
  generation: number,
): PromptCachePlan | undefined {
  if (!input.enabled) return undefined;
  if (input.explicitBreakpoints && input.explicitBreakpoints.length > 0) return undefined;
  if (input.messages.length === 0) return undefined;
  return buildPromptCachePlan(input, generation);
}
