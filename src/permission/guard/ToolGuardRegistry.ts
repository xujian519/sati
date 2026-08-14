/**
 * 工具级单调 deny Guard 注册表。
 *
 * 语义（与 dsh 的 monotonic guard 一致）：
 * - 只收集拒绝（denial），永远不产生 allow——Guard 无法把其他环节的拒绝
 *   翻回放行，只能增加约束；
 * - evaluateAll 执行全部 guard 并收集所有拒绝（不短路），便于诊断一次
 *   输出全部违规点；
 * - Guard 执行异常按拒绝处理（fail-closed）：Guard 自身崩溃不得放行输入。
 */

import type { SatiToolDefinition, SatiToolRuntimeContext } from "../../tool/index.js";
import type { ToolGuard, ToolGuardDenial } from "./ToolGuard.js";

export class ToolGuardRegistry {
  private readonly guards: ToolGuard[] = [];

  /** 注册一个 guard（后注册的先评估，评估顺序不影响"只能拒绝"语义）。 */
  register(guard: ToolGuard): void {
    this.guards.push(guard);
  }

  /** 移除已注册的 guard。返回是否实际移除。 */
  unregister(guard: ToolGuard): boolean {
    const index = this.guards.indexOf(guard);
    if (index === -1) return false;
    this.guards.splice(index, 1);
    return true;
  }

  /** 已注册 guard 数量（诊断用）。 */
  get size(): number {
    return this.guards.length;
  }

  /**
   * 评估全部 guard，返回全部拒绝（顺序 = 注册顺序）。
   * 任一 guard 抛异常都按拒绝计入（fail-closed），不中断后续 guard。
   */
  async evaluateAll(
    tool: SatiToolDefinition,
    input: unknown,
    context: SatiToolRuntimeContext,
  ): Promise<ToolGuardDenial[]> {
    const denials: ToolGuardDenial[] = [];
    for (const guard of this.guards) {
      try {
        const denial = await guard(tool, input, context);
        if (denial) denials.push(denial);
      } catch (error) {
        denials.push({
          code: "guard-error",
          message: `Guard 执行异常（fail-closed 拒绝 ${tool.name}）: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return denials;
  }
}
