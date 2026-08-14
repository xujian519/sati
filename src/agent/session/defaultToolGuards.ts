/**
 * 默认工具级单调 deny Guard 组装（agent 层整合）。
 *
 * agent 层是工具能力的整合方：把各业务域（当前为专利证据合规）的强制
 * guard 注册进共享注册表，随 PermissionRuntime 注入工具执行管线。
 */

import { ToolGuardRegistry } from "../../permission/guard/ToolGuardRegistry.js";
import { evidenceComplianceGuards } from "../../patent/guard/evidenceComplianceGuards.js";

/** 构建含全部内建合规 guard 的默认注册表（每个 session 独立实例）。 */
export function createDefaultToolGuardRegistry(): ToolGuardRegistry {
  const registry = new ToolGuardRegistry();
  for (const guard of evidenceComplianceGuards) {
    registry.register(guard);
  }
  return registry;
}
