/**
 * 成员 modelRouteJson 解析（M4 共享）：全有或全无——provider/model 双字段都是
 * 非空字符串才返回，否则降级为空对象（{}）。脏数据（非法 JSON / 非对象 / 空串 /
 * 部分字段）不抛错、不阻塞（质量评审 M1：空串/残缺路由不得穿透成会话模型覆盖）。
 * 视图/消费分化：视图路径（team_status）对残缺路由展示降级 {}（不阻塞列表）；
 * 消费路径（wakeMember）任一缺失即省略 modelRoute 字段，不覆盖会话模型。
 * 放 agent/team 侧而非 tool/builtin/team：tool 层依赖 agent/team，反向会循环。
 */
export function parseModelRouteJson(json: string): { provider?: string; model?: string } {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { provider, model } = parsed as { provider?: unknown; model?: unknown };
      if (typeof provider === "string" && provider.length > 0 && typeof model === "string" && model.length > 0) {
        return { provider, model };
      }
    }
  } catch {
    // 非法 JSON：走降级
  }
  return {};
}
