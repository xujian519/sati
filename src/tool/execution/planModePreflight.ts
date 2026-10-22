/**
 * Plan 模式前置校验（ToolRuntime 的纯函数部分）。
 *
 * 从 `ToolRuntime.ts` 拆出（P2.9，issue #646）：只读 context 判定当前调用是否
 * 违反 plan 模式约束，不触碰运行时状态。
 */

import { isAbsolute, relative, resolve } from "node:path";
import {
  PLAN_MODE_ALLOWED_TOOLS,
  buildPlanModeBashViolationMessage,
  buildPlanModeViolationMessage,
} from "../planModeConstraints.js";
import { isReadOnlyShellCommand } from "../builtin/bash/permissions.js";
import type { SatiToolRuntimeContext } from "../protocol/types.js";

export function getPlanModeViolation(
  toolName: string,
  input: unknown,
  context: SatiToolRuntimeContext,
): string | undefined {
  if (context.permissionMode !== "plan") {
    return undefined;
  }

  if (!PLAN_MODE_ALLOWED_TOOLS.has(toolName)) {
    return buildPlanModeViolationMessage(toolName);
  }

  if (toolName === "bash") {
    const command = readStringProperty(input, "command");
    if (!command || !isReadOnlyShellCommand(command)) {
      return buildPlanModeBashViolationMessage(command ?? "");
    }
    return undefined;
  }

  if (toolName === "write_file" || toolName === "edit_file") {
    const filePath = readStringProperty(input, "file_path") ?? readStringProperty(input, "filePath");
    if (!isPlanMarkdownPath(filePath, context)) {
      return buildPlanModeViolationMessage(toolName);
    }
  }

  return undefined;
}

function readStringProperty(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanMarkdownPath(filePath: string | undefined, context: SatiToolRuntimeContext): boolean {
  if (!filePath || !context.planDirectory?.path) {
    return false;
  }
  // resolve(cwd, filePath) 对绝对/相对输入统一产出规范化绝对路径，
  // 无需先按 isAbsolute 分支再包一层 resolve。
  const absolute = resolve(context.cwd, filePath);
  if (!absolute.toLowerCase().endsWith(".md")) {
    return false;
  }
  const relativeToPlanDir = relative(context.planDirectory.path, absolute);
  return (
    relativeToPlanDir !== "" &&
    !isAbsolute(relativeToPlanDir) &&
    !relativeToPlanDir.startsWith("..") &&
    !relativeToPlanDir.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  );
}
