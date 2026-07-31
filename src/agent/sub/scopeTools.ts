/**
 * 子代理工具作用域裁剪（从 SubAgentSession.buildScopedRegistry 提取的纯函数）。
 *
 * 过滤维度（依次应用）：
 *   1. allowedTools 白名单（"*" = 全部）
 *   2. 硬性剔除：enter/exit_plan_mode、agent（禁止嵌套 fork）、
 *      always_on_*（需要父级 RunContext）、ask_user_question（无 elicitation 通道）
 *   3. domain 裁剪（visibleDomains 白名单 / hiddenDomains 黑名单，hidden 优先；
 *      未标注 domain 的工具始终可见）
 */

import type { SatiToolDefinition } from "../../tool/index.js";

/** 子代理永远不可见的工具（与既有 buildScopedRegistry 语义一致）。 */
const HARD_BLOCKED = new Set(["enter_plan_mode", "exit_plan_mode", "agent", "ask_user_question"]);

export type ScopeToolsOptions = {
  allowedTools: readonly string[];
  visibleDomains?: readonly string[];
  hiddenDomains?: readonly string[];
  /** 额外排除的工具名（角色 omitTools）。 */
  omitTools?: readonly string[];
};

/** 对工具列表执行子代理作用域裁剪，返回保留的工具。 */
export function scopeToolsForDefinition(
  tools: readonly SatiToolDefinition[],
  options: ScopeToolsOptions,
): SatiToolDefinition[] {
  const allowedSet = new Set(options.allowedTools);
  const wildcard = allowedSet.has("*");
  const omitSet = options.omitTools ? new Set(options.omitTools) : undefined;
  const visible =
    options.visibleDomains && options.visibleDomains.length > 0 ? new Set(options.visibleDomains) : undefined;
  const hidden = options.hiddenDomains && options.hiddenDomains.length > 0 ? new Set(options.hiddenDomains) : undefined;

  return tools.filter(tool => {
    if (!wildcard && !allowedSet.has(tool.name)) return false;
    if (omitSet?.has(tool.name)) return false;
    if (tool.name.startsWith("always_on_")) return false;
    if (HARD_BLOCKED.has(tool.name)) return false;
    const domain = tool.domain;
    if (domain !== undefined) {
      if (hidden?.has(domain)) return false;
      if (visible !== undefined && !visible.has(domain)) return false;
    }
    return true;
  });
}
