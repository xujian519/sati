import type { SatiToolRuntimeContext } from "../../src/tool/protocol/types.js";

/**
 * 构造一个合法的工具执行 context（bypassPermissions 模式）。
 *
 * 替代测试中散落的 `{} as never` 类型作弊：工具在真实 context 下运行，
 * 依赖 `cwd` / `permissionContext` 的逻辑不会被静默跳过，避免假绿。
 * 各测试文件曾各自复制一份 context 工厂，统一收敛于此。
 */
export function makeToolContext(overrides: Partial<SatiToolRuntimeContext> = {}): SatiToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    ...overrides,
  };
}
