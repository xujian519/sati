/**
 * 成员 modelRouteJson 解析（M4 共享）：脏数据（非法 JSON / 非对象）降级为空对象
 * ——视图（team_status）与 wakeMember 消费路径都不抛错、不阻塞。
 * 放 agent/team 侧而非 tool/builtin/team：tool 层依赖 agent/team，反向会循环。
 */
export function parseModelRouteJson(json: string): { provider?: string; model?: string } {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { provider, model } = parsed as { provider?: unknown; model?: unknown };
      return {
        ...(typeof provider === "string" ? { provider } : {}),
        ...(typeof model === "string" ? { model } : {}),
      };
    }
  } catch {
    // 非法 JSON：走降级
  }
  return {};
}
