/**
 * 收窄 unknown → 纯对象（Record<string, unknown>），非对象/数组返回 null。
 *
 * WebSocket 帧、工具结果等异构 JSON 数据的统一读取入口：先收窄为可索引对象，
 * 再对具体字段做 typeof 检查或断言，避免 `as any` 一路透传。
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
