/**
 * src/gateway/client — 输入归一化（纯函数）。
 *
 * 从 InProcessGateway.ts 拆出（A11 轮次 1）：legacy mode/runMode 归一化 +
 * /plan 命令解析（含用法文案）。
 */

import type { GatewaySubmitTurnInput } from "../protocol/types.js";

export const PLAN_COMMAND_USAGE = "用法：/plan <任务>\n例如：/plan 设计一个新功能";

export function normalizeGatewayModeForLegacyInput(value: unknown): GatewaySubmitTurnInput["mode"] | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "default" || value === "plan" || value === "bypassPermissions") {
    return value;
  }
  return "default";
}

export function normalizeGatewayRunMode(value: unknown): GatewaySubmitTurnInput["runMode"] | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "agent" || value === "plan" || value === "ask") {
    return value;
  }
  return "agent";
}

export function normalizePlanCommandInput(input: GatewaySubmitTurnInput): GatewaySubmitTurnInput | undefined {
  const parsed = parsePlanCommand(input.message);
  if (!parsed.isPlanCommand) {
    return input;
  }
  if (!parsed.message) {
    return undefined;
  }
  return {
    ...input,
    message: parsed.message,
    runMode: "plan",
    mode: "plan",
    basePermissionMode: input.basePermissionMode ?? input.mode ?? "default",
    allowPlanModeTools: true,
  };
}

export function parsePlanCommand(message: string): { isPlanCommand: boolean; message: string } {
  const trimmed = message.trim();
  const match = trimmed.match(/^\/plan(?:\s+([\s\S]*))?$/u);
  if (!match) {
    return { isPlanCommand: false, message };
  }
  return {
    isPlanCommand: true,
    message: (match[1] ?? "").trim(),
  };
}
