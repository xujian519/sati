/**
 * src/gateway/client — 输入归一化与「输入被拒」标准事件（纯函数）。
 *
 * 从 InProcessGateway.ts 拆出（A11 轮次 1）：legacy mode/runMode 归一化 +
 * /plan 命令解析（含用法文案）。
 *
 * P2.1 追加：两条拒答事件序列外移——`submitTurn` 拆成 start/pump/finish 三段后，
 * 早退分支不再处于生成器体内，改为返回事件数组由调用方放流（顺序逐条不变）。
 */

import { withNonUserOriginNotice } from "../../context/prompt/nonUserOriginNotice.js";
import type { AgentSubmitOptions } from "../../agent/index.js";
import type { CanonicalMessage } from "../../model/index.js";
import {
  type PermissionRule,
  type PermissionRuleSet,
  type PermissionSettings,
  permissionSettingsToRuleSet,
} from "../../permission/index.js";
import { createVisibleErrorStatusDetail } from "../../status/agentStatus.js";
import type { GatewayEvent, GatewaySubmitTurnInput } from "../protocol/types.js";

export const PLAN_COMMAND_USAGE = "用法：/plan <任务>\n例如：/plan 设计一个新功能";

/** 渠道附带提示 → 合成消息。护栏：不是用户输入，正文加抬头，避免被读成用户指令或授权。 */
export function buildSyntheticTurnMessages(hints: GatewaySubmitTurnInput["syntheticMessages"]): CanonicalMessage[] {
  return (hints ?? []).map(s => ({
    role: "user" as const,
    content: [{ type: "text" as const, text: withNonUserOriginNotice(s.text) }],
    metadata: { synthetic: true, purpose: s.purpose ?? "channel_hint" },
  }));
}

/**
 * `/plan` 未带任务时的用法提示（assistant_text_delta + turn_completed）。
 *
 * 用 `push(字面量)` 而非返回数组字面量：事件矩阵的生产点识别只覆盖
 * 「调用实参 / yield」两种形态（`scripts/gen-event-matrix.ts` 启发式 v1），
 * 数组元素形态会**静默丢站点**（把本函数写回数组字面量即可复现
 * `assistant_text_delta` 变成零生产者）。
 */
export function planCommandUsageEvents(): GatewayEvent[] {
  const events: GatewayEvent[] = [];
  events.push({ type: "assistant_text_delta", text: PLAN_COMMAND_USAGE });
  events.push({ type: "turn_completed", usage: {}, finishReason: "completed" });
  return events;
}

/** 同 session 重复提交：agent_status(session_busy) + error(session_busy)（push 理由同上）。 */
export function sessionBusyEvents(sessionKey: string): GatewayEvent[] {
  const message = `Session ${sessionKey} already has an active turn.`;
  const userHint = "Wait for the current turn to finish or stop it before sending another message.";
  const events: GatewayEvent[] = [];
  events.push({
    type: "agent_status",
    event: "session_busy",
    detail: createVisibleErrorStatusDetail({
      message,
      code: "session_busy",
      userHint,
      scope: "session",
      source: "gateway",
    }),
  });
  events.push({ type: "error", code: "session_busy", message, recoverable: true, userHint });
  return events;
}

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

/** 一次 submit 的权限上下文：legacy 输入 + 持久化设置 + 会话级授予三者的归一结果。 */
export type SubmitTurnPermissions = {
  runMode: NonNullable<AgentSubmitOptions["runMode"]>;
  permissionMode: AgentSubmitOptions["permissionMode"];
  basePermissionMode: AgentSubmitOptions["basePermissionMode"];
  allowPlanModeTools: boolean;
  /** 持久化规则与会话级授予合并后的规则集（会话授予在前，同 mode 下更具体）。 */
  permissionRules: Partial<PermissionRuleSet>;
};

export function resolveSubmitTurnPermissions(
  input: GatewaySubmitTurnInput,
  settings: PermissionSettings,
  sessionGrants: PermissionRule[],
): SubmitTurnPermissions {
  // 旧字段仍可能从老客户端 / 老 turn 快照里传来，按与 normalize* 相同的宽松口径读。
  const legacyInput = input as { mode?: unknown; runMode?: unknown; basePermissionMode?: unknown };
  const inputMode = normalizeGatewayModeForLegacyInput(legacyInput.mode);
  const persistedRules = permissionSettingsToRuleSet(settings);
  return {
    runMode: normalizeGatewayRunMode(legacyInput.runMode) ?? (inputMode === "plan" ? "plan" : "agent"),
    permissionMode: inputMode ?? (settings.skipPermissions ? "bypassPermissions" : undefined),
    basePermissionMode: normalizeGatewayModeForLegacyInput(legacyInput.basePermissionMode),
    allowPlanModeTools: input.allowPlanModeTools ?? inputMode === "plan",
    permissionRules: { ...persistedRules, allow: [...sessionGrants, ...persistedRules.allow] },
  };
}

/** 由 turn 输入 + 权限上下文 + 附件产物装配 agent 侧提交选项（无副作用）。 */
export function buildSubmitOptions(args: {
  input: GatewaySubmitTurnInput;
  permissions: SubmitTurnPermissions;
  runId: string;
  allowedReadFiles: string[];
  syntheticMessages: CanonicalMessage[];
}): AgentSubmitOptions {
  const { input, permissions } = args;
  return {
    turnId: args.runId,
    maxTurns: input.maxTurns,
    runMode: permissions.runMode,
    permissionMode: permissions.permissionMode,
    basePermissionMode: permissions.basePermissionMode,
    allowPlanModeTools: permissions.allowPlanModeTools,
    canPrompt: input.canPrompt,
    allowedReadFiles: args.allowedReadFiles,
    permissionRules: permissions.permissionRules,
    appendSystemPrompt: input.appendSystemPrompt,
    ...(args.syntheticMessages.length > 0 ? { syntheticMessages: args.syntheticMessages } : {}),
  };
}
