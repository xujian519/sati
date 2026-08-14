/**
 * 工具级单调 deny Guard（对应 dsh 的 monotonic guard 设计）。
 *
 * 与 PermissionRule（用户/项目可配置规则）的区别：
 * - Guard 是代码级强制约束，只返回"拒绝"，没有 allow——任何 allow/ask 规则
 *   都不能覆盖 Guard 的拒绝，也不走 HITL 审批；
 * - Guard 在 PermissionRuntime.decide 的最前面执行（先于一切规则判定），
 *   因此"监听/配置顺序不可能把拒绝变回放行"；
 * - Guard 语义上是"确定性硬约束"（如合规前置条件、格式校验），模糊判断
 *   （法条引用内容正确性等）留在 rule_check / 输出门禁，避免误伤。
 */

import type { SatiToolDefinition, SatiToolRuntimeContext } from "../../tool/index.js";

/** Guard 拒绝结果：携带拒绝原因（可选稳定错误码，供日志/诊断消费）。 */
export type ToolGuardDenial = {
  message: string;
  code?: string;
};

/**
 * 同步工具级强制检查。
 * @returns denial 表示拒绝该工具调用；undefined 表示放行。
 * @throws 视为拒绝（fail-closed）：Guard 自身异常不得让违规输入通过。
 */
export type ToolGuard = (
  tool: SatiToolDefinition,
  input: unknown,
  context: SatiToolRuntimeContext,
) => ToolGuardDenial | undefined | Promise<ToolGuardDenial | undefined>;
