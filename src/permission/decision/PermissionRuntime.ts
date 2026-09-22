import { isAbsolute, relative, resolve } from "node:path";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../../tool/index.js";
import { buildPlanModeViolationMessage, buildPlanModeBashViolationMessage } from "../../tool/planModeConstraints.js";
import { matchPermissionRule } from "../policy/matchPermissionRule.js";
import { ToolGuardRegistry } from "../guard/ToolGuardRegistry.js";
import type {
  PermissionContext,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionRequest,
  PermissionResult,
  PermissionRule,
} from "../protocol/types.js";

export type PermissionRuntimeOptions = {
  /**
   * 工具级单调 deny Guard 注册表（可选）。Guard 在一切规则判定之前执行，
   * 其拒绝不能被 allow/ask 规则覆盖、不走 HITL。
   */
  guards?: ToolGuardRegistry;
};

export class PermissionRuntime {
  private readonly guards: ToolGuardRegistry;

  constructor(options: PermissionRuntimeOptions = {}) {
    this.guards = options.guards ?? new ToolGuardRegistry();
  }

  async decide(
    tool: SatiToolDefinition,
    input: unknown,
    context: SatiToolRuntimeContext,
    toolCallId: string,
  ): Promise<PermissionDecision> {
    const decision = await this.decideByRules(tool, input, context, toolCallId);
    return tool.alwaysAsk === true ? this.raiseAlwaysAsk(tool, input, context, toolCallId, decision) : decision;
  }

  /**
   * `alwaysAsk` 抬高下限：最终结论若本会是 allow（bypassPermissions 模式、
   * user/session allow 规则、plan 只读直通都走这条），一律改判为提问；结论若
   * 本会是 ask，则补上标记并去掉「本会话允许」入口。deny/cancel 一律原样返回
   * ——该标记只能扩大「可以问什么」，不能扩大「可以做什么」，因此放在判定链
   * 之外包一层，而不是插进链中的某个分支。
   *
   * 改判前必须求 `tool.checkPermissions`：上面那些 allow 路径都在它之前就返回了，
   * 不求的话工具级硬拒（如 bash 的 HARD_DENY_PATTERNS）会从「永不允许」退化成
   * 「可批准一次」。
   */
  private async raiseAlwaysAsk(
    tool: SatiToolDefinition,
    input: unknown,
    context: SatiToolRuntimeContext,
    toolCallId: string,
    decision: PermissionDecision,
  ): Promise<PermissionDecision> {
    if (decision.type === "deny" || decision.type === "cancel") {
      return decision;
    }

    const permissionContext = context.permissionContext;

    if (permissionContext.canPrompt === false) {
      // fail-closed：alwaysAsk 的工具无法在不提问的前提下获批，因此在不能提问的
      // 会话（cron、team 成员唤醒、always-on）中直接不可用。
      return deny({
        type: "runtime",
        message: `Tool ${tool.name} always requires confirmation, but prompts are disabled for this session.`,
      });
    }

    if (decision.type === "ask") {
      return { ...decision, request: markAlwaysAsk(decision.request) };
    }

    const toolPermission = await tool.checkPermissions?.(input, context);
    const toolDecision = normalizeToolPermission(toolPermission, tool, input, toolCallId, permissionContext);
    if (toolDecision && (toolDecision.type === "deny" || toolDecision.type === "cancel")) {
      return toolDecision;
    }

    const toolAsk = toolDecision?.type === "ask" ? toolDecision : undefined;
    const reason: PermissionDecisionReason = toolAsk?.reason ?? {
      type: "tool",
      toolName: tool.name,
      message: `Tool ${tool.name} requires explicit confirmation for every call.`,
    };
    return {
      type: "ask",
      reason,
      request: markAlwaysAsk(toolAsk?.request ?? createPermissionRequest(tool, input, toolCallId, reason)),
    };
  }

  private async decideByRules(
    tool: SatiToolDefinition,
    input: unknown,
    context: SatiToolRuntimeContext,
    toolCallId: string,
  ): Promise<PermissionDecision> {
    const permissionContext = context.permissionContext;

    // 单调 deny Guard：先于一切规则执行。Guard 只拒绝不放行，任何
    // allow/ask 规则（含 user/session 来源）都不能覆盖其拒绝，也不走 HITL。
    const guardDenials = await this.guards.evaluateAll(tool, input, context);
    if (guardDenials.length > 0) {
      // code 透传供结构化日志/统计（如 EVI-011-notarization）。
      const codes = guardDenials.map(d => d.code).filter((c): c is string => c !== undefined);
      return deny({
        type: "safety",
        ...(codes.length > 0 ? { code: codes.join(",") } : {}),
        message: guardDenials.map(d => d.message).join("；"),
      });
    }

    const sessionAllowRule = findMatchingRule(
      permissionContext.rules.allow.filter(rule => rule.source === "session"),
      tool.name,
      input,
      permissionContext,
    );

    const denyRule = findMatchingRule(permissionContext.rules.deny, tool.name, input, permissionContext);
    if (denyRule) {
      if (sessionAllowRule && denyRule.source === "user") {
        return this.allowSessionRule(tool, input, context, toolCallId, sessionAllowRule);
      }
      return denyFromRule(denyRule);
    }

    const askRule = findMatchingRule(permissionContext.rules.ask, tool.name, input, permissionContext);
    if (askRule) {
      return finalizeAsk(askFromRule(tool, input, toolCallId, askRule), permissionContext);
    }

    if (sessionAllowRule) {
      return this.allowSessionRule(tool, input, context, toolCallId, sessionAllowRule);
    }

    // Check user-configured allow rules BEFORE consulting the tool's own
    // checkPermissions, so an explicit "Allow + remember" grant wins
    // over a tool that hardcodes ask (web_fetch / web_search do this).
    // Without this ordering, the user's grant is effectively ignored:
    // tool.checkPermissions returns ask → runtime surfaces another
    // permission prompt → next call repeats → infinite prompts.
    // Deny rules (checked above) still win over allow rules.
    const allowRule = findMatchingRule(permissionContext.rules.allow, tool.name, input, permissionContext);
    if (allowRule) {
      // Plan mode deny takes precedence over user allow rules for
      // non-readonly tools (except plan-directory markdown writes). Without this guard,
      // a user who previously allowed write_file/bash can inadvertently
      // bypass plan mode's read-only constraint.
      if (
        permissionContext.mode === "plan" &&
        !tool.isReadOnly(input) &&
        !isPlanDirectoryWrite(tool, input, permissionContext)
      ) {
        // Fall through to mode-level deny below.
      } else {
        return allow({
          type: "rule",
          behavior: "allow",
          rule: allowRule,
          message: `Allow rule permits ${tool.name}.`,
        });
      }
    }

    const toolPermission = await tool.checkPermissions?.(input, context);
    const toolDecision = normalizeToolPermission(toolPermission, tool, input, toolCallId, permissionContext);
    if (toolDecision) {
      if (toolDecision.type === "ask") {
        // `bypassPermissions` mode is the user's explicit "approve
        // everything" escape hatch. Tools that hardcode `ask` in
        // `checkPermissions` (web_search, web_fetch, agent dispatch,
        // mcp tools, …) would otherwise still prompt — defeating the
        // mode's whole purpose. Treat the tool's `ask` the same way
        // we'd treat a missing `checkPermissions` and fall through
        // to mode-level allow. User-configured `ask` rules already
        // short-circuited above, so they aren't affected. Tool-level
        // `deny` (safety regex etc.) is handled below and still wins.
        if (permissionContext.mode === "bypassPermissions") {
          return allow({
            type: "mode",
            mode: permissionContext.mode,
            message: `Permission mode ${permissionContext.mode} overrides ${tool.name}.checkPermissions ask.`,
          });
        }
        if (permissionContext.mode === "plan" && tool.isReadOnly(input)) {
          return allow({
            type: "mode",
            mode: "plan",
            message: `Plan mode allows read-only tool ${tool.name} despite .checkPermissions ask.`,
          });
        }
        if (permissionContext.mode === "plan" && !isPlanDirectoryWrite(tool, input, permissionContext)) {
          return deny({
            type: "mode",
            mode: "plan",
            message: buildPlanModeDenyMessage(tool.name, input),
          });
        }
        return finalizeAsk(toolDecision, permissionContext);
      }
      return toolDecision;
    }

    if (permissionContext.mode === "bypassPermissions") {
      return allow({
        type: "mode",
        mode: permissionContext.mode,
        message: `Permission mode ${permissionContext.mode} allows ${tool.name}.`,
      });
    }

    const modeDecision = decideByMode(tool, input, toolCallId, permissionContext);
    return modeDecision.type === "ask" ? finalizeAsk(modeDecision, permissionContext) : modeDecision;
  }

  private async allowSessionRule(
    tool: SatiToolDefinition,
    input: unknown,
    context: SatiToolRuntimeContext,
    toolCallId: string,
    rule: PermissionRule,
  ): Promise<PermissionDecision> {
    const toolPermission = await tool.checkPermissions?.(input, context);
    const toolDecision = normalizeToolPermission(toolPermission, tool, input, toolCallId, context.permissionContext);
    if (toolDecision && toolDecision.type !== "ask") {
      return toolDecision;
    }
    return allow({
      type: "rule",
      behavior: "allow",
      rule,
      message: `Session allow rule permits ${tool.name}.`,
    });
  }
}

function normalizeToolPermission(
  result: PermissionResult | undefined,
  tool: SatiToolDefinition,
  input: unknown,
  toolCallId: string,
  context: PermissionContext,
): PermissionDecision | undefined {
  if (!result || result.type === "passthrough") {
    return undefined;
  }

  if (result.type === "ask") {
    return {
      ...result,
      request: {
        ...result.request,
        toolCallId,
        toolName: tool.name,
      },
    };
  }

  if (result.type === "allow" || result.type === "deny" || result.type === "cancel") {
    return result;
  }

  return ask(tool, input, toolCallId, {
    type: "runtime",
    message: `Permission result for ${tool.name} was not recognized in mode ${context.mode}.`,
  });
}

function decideByMode(
  tool: SatiToolDefinition,
  input: unknown,
  toolCallId: string,
  context: PermissionContext,
): PermissionDecision {
  if (context.mode === "plan") {
    if (tool.isReadOnly(input)) {
      return allow({
        type: "mode",
        mode: "plan",
        message: `Plan mode allows read-only tool ${tool.name}.`,
      });
    }

    if (isPlanDirectoryWrite(tool, input, context)) {
      return allow({
        type: "mode",
        mode: "plan",
        message: `Plan mode allows writing markdown plans under the plan directory.`,
      });
    }

    return deny({
      type: "mode",
      mode: "plan",
      message: buildPlanModeDenyMessage(tool.name, input),
    });
  }

  if (tool.isReadOnly(input)) {
    return allow({
      type: "mode",
      mode: context.mode,
      message: `Mode ${context.mode} allows read-only tool ${tool.name}.`,
    });
  }

  return ask(tool, input, toolCallId, {
    type: "mode",
    mode: context.mode,
    message: `Mode ${context.mode} requires permission for ${tool.name}.`,
  });
}

function findMatchingRule(
  rules: PermissionRule[],
  toolName: string,
  input: unknown,
  context: PermissionContext,
): PermissionRule | undefined {
  return rules.find(rule => matchPermissionRule(rule, toolName, input, context));
}

function allow(reason: PermissionDecisionReason): PermissionDecision {
  return { type: "allow", reason };
}

function deny(reason: PermissionDecisionReason): PermissionDecision {
  return { type: "deny", reason, message: reason.message };
}

function denyFromRule(rule: PermissionRule): PermissionDecision {
  return deny({
    type: "rule",
    behavior: "deny",
    rule,
    message:
      rule.ruleId !== undefined
        ? `宪法规则 ${rule.ruleId} 拦截工具调用 ${rule.toolName}。`
        : `Deny rule blocks ${rule.toolName}.`,
  });
}

function askFromRule(
  tool: SatiToolDefinition,
  input: unknown,
  toolCallId: string,
  rule: PermissionRule,
): PermissionDecision {
  return ask(tool, input, toolCallId, {
    type: "rule",
    behavior: "ask",
    rule,
    message: `Ask rule requires confirmation for ${tool.name}.`,
  });
}

function ask(
  tool: SatiToolDefinition,
  input: unknown,
  toolCallId: string,
  reason: PermissionDecisionReason,
): PermissionDecision {
  return {
    type: "ask",
    reason,
    request: createPermissionRequest(tool, input, toolCallId, reason),
  };
}

function createPermissionRequest(
  tool: SatiToolDefinition,
  input: unknown,
  toolCallId: string,
  reason: PermissionDecisionReason,
): PermissionRequest {
  return {
    toolCallId,
    toolName: tool.name,
    inputSummary: summarizeInput(input),
    reason,
    options: [
      { id: "allow_once", label: "Allow once" },
      { id: "deny", label: "Deny" },
      { id: "cancel", label: "Cancel" },
    ],
  };
}

/**
 * 给请求打上 `alwaysAsk` 标记并摘掉「本会话允许」选项：该标记的意义正在于
 * 任何一次点击都不该让它在本会话内静默失效。工具自带的 request 可能带
 * `allow_session`（如 write_permissions），必须在命中时丢弃。
 */
function markAlwaysAsk(request: PermissionRequest): PermissionRequest {
  const options = request.options.filter(option => option.id !== "allow_session");
  return {
    ...request,
    options: options.some(option => option.id === "allow_once")
      ? options
      : [{ id: "allow_once", label: "Allow once" }, ...options],
    metadata: { ...request.metadata, alwaysAsk: true },
  };
}

function finalizeAsk(decision: PermissionDecision, context: PermissionContext): PermissionDecision {
  if (decision.type !== "ask") {
    return decision;
  }

  if (context.mode === "bypassPermissions") {
    return {
      type: "allow",
      reason: {
        type: "mode",
        mode: "bypassPermissions",
        message: "bypassPermissions mode skips permission prompts.",
      },
    };
  }

  if (context.canPrompt === false) {
    return {
      type: "deny",
      reason: {
        type: "runtime",
        message: "Permission prompt denied because prompts are disabled for this session.",
      },
      message: "Permission prompt denied because prompts are disabled for this session.",
    };
  }

  return decision;
}

function summarizeInput(input: unknown): string {
  try {
    const json = JSON.stringify(input);
    if (!json) {
      return String(input);
    }
    return json.length > 500 ? `${json.slice(0, 500)}...` : json;
  } catch {
    // 循环引用/BigInt 等不可序列化输入：展示占位符，不影响权限判定本身。
    return "[unserializable input]";
  }
}

/**
 * Returns true when a filesystem write tool (write_file / edit_file) targets
 * a markdown file under the project-local `.sati/plans` directory.
 * Resolves relative paths against the permission context cwd so `./foo.md`
 * and the absolute path both match.
 */
function isPlanDirectoryWrite(tool: SatiToolDefinition, input: unknown, context: PermissionContext): boolean {
  if (tool.kind !== "filesystem" || !context.planDirectoryPath) return false;
  const record = input as Record<string, unknown> | null;
  const filePath = record?.file_path ?? record?.filePath;
  if (typeof filePath !== "string") return false;
  const absolute = resolve(context.cwd, filePath);
  if (!absolute.toLowerCase().endsWith(".md")) {
    return false;
  }
  const relativeToPlanDir = relative(context.planDirectoryPath, absolute);
  return (
    relativeToPlanDir !== "" &&
    !isAbsolute(relativeToPlanDir) &&
    !relativeToPlanDir.startsWith("..") &&
    !relativeToPlanDir.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  );
}

/**
 * Build a structured plan-mode deny message with corrective guidance.
 * For `bash`, extracts the command string to give a more precise hint.
 */
function buildPlanModeDenyMessage(toolName: string, input: unknown): string {
  if (toolName === "bash") {
    const record = input as Record<string, unknown> | null;
    const command = typeof record?.command === "string" ? record.command : "";
    return buildPlanModeBashViolationMessage(command);
  }
  return buildPlanModeViolationMessage(toolName);
}
