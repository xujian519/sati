/**
 * AgentLoop 模块级杂项纯函数（从 AgentLoop.ts 拆出）。
 *
 * 无 this / 无运行期状态依赖，全部为确定性函数，可独立测试。
 */

import path from "node:path";
import type { CanonicalMessage, CanonicalToolSchema, CanonicalUsage } from "../../model/index.js";
import type { LifecycleDispatchResult } from "../../lifecycle/index.js";
import { ASK_MODE_DESCRIPTION_SUFFIX, isAskModeAllowedTool } from "../../tool/askModeConstraints.js";
import { buildAskModeAgentToolSchema } from "../../tool/builtin/agent.js";
import type {
  SatiReadFileStateMap,
  SatiToolDefinition,
  SatiToolResult,
  SatiWriteSnapshotMap,
} from "../../tool/index.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import type { AgentLoopInput } from "../protocol/input.js";
import type { SatiHookEvent } from "../../extension/hooks/protocol/events.js";
import type { PermissionRule } from "../../permission/index.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildTurnEnvironment(
  baseEnv: NodeJS.ProcessEnv | undefined,
  cwd: string,
  sessionId: string,
  turnId: string,
): NodeJS.ProcessEnv {
  return {
    ...(baseEnv ?? process.env),
    SESSION_ID: sessionId,
    TURN_ID: turnId,
    WORK_DIR: path.join(
      path.resolve(cwd),
      ".sati",
      "work",
      safeWorkPathSegment(sessionId),
      safeWorkPathSegment(turnId),
    ),
  };
}

function safeWorkPathSegment(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.replace(/^[-.]+|[-.]+$/g, "").slice(0, 96) || "unknown";
}

/** 把 user 来源规则移到数组末尾（用户规则优先级最高，最后匹配）。 */
export function mergeUserRules(target: PermissionRule[], userRules: PermissionRule[] | undefined): void {
  const nonUserRules = target.filter(rule => rule.source !== "user");
  target.splice(0, target.length, ...nonUserRules, ...(userRules ?? []));
}

/** ask 模式下按白名单过滤工具，并对保留工具追加描述后缀（agent 工具换 schema）。 */
export function filterAskModeTools(tools: SatiToolDefinition[]): CanonicalToolSchema[] {
  const agentOverride = buildAskModeAgentToolSchema();
  return tools.filter(isAskModeAllowedTool).map(tool => {
    if (tool.name === "agent") {
      return {
        ...toolToCanonicalSchema(tool),
        description: agentOverride.description,
        inputSchema: agentOverride.inputSchema,
      };
    }
    const suffix = ASK_MODE_DESCRIPTION_SUFFIX[tool.name];
    const schema = toolToCanonicalSchema(tool);
    return suffix ? { ...schema, description: schema.description + suffix } : schema;
  });
}

export function toolToCanonicalSchema(tool: SatiToolDefinition): CanonicalToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

export function findLifecycleBlock(
  result: LifecycleDispatchResult,
): { reason: string; stopReason?: string } | undefined {
  return result.effects.find(
    (effect): effect is { type: "block"; reason: string; stopReason?: string } => effect.type === "block",
  );
}

export function findToolLifecycleBlock(results: SatiToolResult[]): { reason: string; stopReason?: string } | undefined {
  for (const result of results) {
    const lifecycle = result.metadata?.lifecycle;
    if (isRecord(lifecycle) && isRecord(lifecycle.blocked) && typeof lifecycle.blocked.reason === "string") {
      return {
        reason: lifecycle.blocked.reason,
        stopReason: typeof lifecycle.blocked.stopReason === "string" ? lifecycle.blocked.stopReason : undefined,
      };
    }
  }
  return undefined;
}

export function cloneReadFileStateMap(state: SatiReadFileStateMap | undefined): SatiReadFileStateMap {
  const out: SatiReadFileStateMap = new Map();
  if (!state) return out;
  for (const [key, value] of state.entries()) {
    out.set(key, { ...value });
  }
  return out;
}

export function cloneWriteSnapshotMap(state: SatiWriteSnapshotMap | undefined): SatiWriteSnapshotMap {
  const out: SatiWriteSnapshotMap = new Map();
  if (!state) return out;
  for (const [key, value] of state.entries()) {
    out.set(key, { ...value });
  }
  return out;
}

/** 从 sessionId 提取 `::sub::` 标记后的子代理 id。 */
export function subagentIdFromSessionId(sessionId: string): string | undefined {
  const marker = "::sub::";
  const index = sessionId.lastIndexOf(marker);
  if (index < 0) return undefined;
  const subagentId = sessionId.slice(index + marker.length).trim();
  return subagentId.length > 0 ? subagentId : undefined;
}

export function readRequestedMode(value: unknown): AgentRuntimeConfig["permissionMode"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const requestedMode = (value as Record<string, unknown>).requestedMode;
  return isPermissionMode(requestedMode) ? requestedMode : undefined;
}

export function isPermissionMode(value: unknown): value is AgentRuntimeConfig["permissionMode"] {
  return value === "default" || value === "plan" || value === "bypassPermissions";
}

export function mergeUsage(first: CanonicalUsage, second: CanonicalUsage | undefined): CanonicalUsage {
  if (!second) {
    return first;
  }
  return {
    inputTokens: add(first.inputTokens, second.inputTokens),
    outputTokens: add(first.outputTokens, second.outputTokens),
    cacheReadTokens: add(first.cacheReadTokens, second.cacheReadTokens),
    cacheWriteTokens: add(first.cacheWriteTokens, second.cacheWriteTokens),
    totalTokens: add(first.totalTokens, second.totalTokens),
  };
}

function add(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined && second === undefined) {
    return undefined;
  }
  return (first ?? 0) + (second ?? 0);
}

/** 绑定补充消息到对应 tool_call（按结果的 supplementalMessages 计数分配）。 */
export function bindSupplementalMessagesToToolCalls(
  results: SatiToolResult[],
  supplementalMessages: CanonicalMessage[],
): Array<{ toolCallId: string; message: CanonicalMessage }> {
  const bound: Array<{ toolCallId: string; message: CanonicalMessage }> = [];
  let index = 0;
  for (const result of results) {
    const count = result.supplementalMessages?.length ?? 0;
    for (let offset = 0; offset < count && index < supplementalMessages.length; offset += 1) {
      bound.push({ toolCallId: result.toolCallId, message: supplementalMessages[index]! });
      index += 1;
    }
  }
  return bound;
}

export type AbortComposition = {
  signal: AbortSignal | undefined;
  cleanup: () => void;
  timedOut: () => boolean;
};

/** 组合父 AbortSignal 与超时（子代理超时控制）。 */
export function composeAbortSignal(args: { parent?: AbortSignal; timeoutMs?: number }): AbortComposition {
  const { parent, timeoutMs } = args;
  if (!parent && (!timeoutMs || timeoutMs <= 0)) {
    return { signal: undefined, cleanup: () => {}, timedOut: () => false };
  }
  const controller = new AbortController();
  const cleanupFns: Array<() => void> = [];
  let timedOut = false;
  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      const onAbort = () => controller.abort(parent.reason);
      parent.addEventListener("abort", onAbort, { once: true });
      cleanupFns.push(() => parent.removeEventListener("abort", onAbort));
    }
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0 && !controller.signal.aborted) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Subagent timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    cleanupFns.push(() => clearTimeout(timeout));
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const fn of cleanupFns) fn();
    },
    timedOut: () => timedOut,
  };
}

/** 生命周期钩子分发器签名（纯依赖注入，无实例状态）。 */
export type LifecycleDispatcher = (
  input: AgentLoopInput,
  event: SatiHookEvent,
  payload: Record<string, unknown>,
) => Promise<LifecycleDispatchResult>;

const emptyDispatchResult = (): LifecycleDispatchResult => ({
  effects: [],
  messages: [],
  events: [],
  blockingErrors: [],
  nonBlockingErrors: [],
});

/**
 * 构造生命周期钩子分发器：未注入 lifecycle 时返回空结果（与既有行为一致）。
 * 移入 misc.ts 以便 ToolContextFactory 与 AgentLoop 共享同一实现。
 */
export function createLifecycleDispatcher(
  config: AgentRuntimeConfig,
  dependencies: AgentRuntimeDependencies,
): LifecycleDispatcher {
  return async (input, event, payload) =>
    dependencies.lifecycle?.dispatch({
      event,
      baseInput: {
        sessionId: input.sessionId,
        transcriptPath: "",
        cwd: config.cwd,
        permissionMode: config.permissionMode,
      },
      payload,
      matchQuery: event,
      signal: input.abortSignal,
      env: buildTurnEnvironment(config.env, config.cwd, input.sessionId, input.turnId),
    }) ?? emptyDispatchResult();
}
