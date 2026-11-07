/**
 * patent 域共享 JSON 形状守卫。
 *
 * `llm-json.ts` 的 `tryParseJson` 也经这里收窄解析结果；新增消费方复用它，
 * 不要在各 handler 复制 `asRecord` / `parseJsonOrRaw` 实现。
 */

/** 对象守卫：数组与 null 都不是记录。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 解析 JSON；不可解析时原样返回字符串。
 *
 * 上游可能传纯文本（如人写的对照表片段）：保留原文供调用方展示或降级，
 * 不用异常打断阶段。空输入返回 null（JSON.stringify 保留该键）。
 */
export function parseJsonValue(raw: string): unknown {
  if (raw.trim().length === 0) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // 非 JSON 的纯文本：原样返回，避免调用方拿到 undefined 后丢掉原文。
    return raw;
  }
}
