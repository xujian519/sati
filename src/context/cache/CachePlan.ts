import { createHash } from "node:crypto";
import type { CanonicalMessage, CanonicalToolSchema, PromptCachePlan } from "../../model/index.js";
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
 * 前缀稳定性约束：逐调用可变的注入（workspace-state 账本块、steer 消息、
 * repeatToolReminder 提醒）必须位于最近 N 条断点之后（尾部注入），否则
 * 会破坏断点之前的前缀。
 */

/** 最近 N 条非 system 消息打点（Anthropic 单请求最多 4 个 cache_control 块：system + 3 消息）。 */
export const RECENT_MESSAGE_BREAKPOINT_COUNT = 3;

/** 环境开关：SATI_PROMPT_CACHE=off 关闭 per-request cache 布局（回退旧行为）。 */
export function promptCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SATI_PROMPT_CACHE !== "off";
}

/** Select the final messages for the recent-message layout (system prompt is a separate request field). */
export function selectRecentMessageBreakpoints(messages: CanonicalMessage[]): number[] {
  return messages.map((_, index) => index).slice(-RECENT_MESSAGE_BREAKPOINT_COUNT);
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
