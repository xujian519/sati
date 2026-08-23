import { isAbsolute, relative, resolve } from "node:path";
import { PermissionRuntime } from "../../permission/index.js";
import type { LifecycleRuntime, SatiHookEffect } from "../../lifecycle/index.js";
import { normalizeToolError, SatiToolRuntimeError, toolError } from "../protocol/errors.js";
import type { SatiToolErrorCode } from "../protocol/errors.js";
import {
  PLAN_MODE_ALLOWED_TOOLS,
  buildPlanModeBashViolationMessage,
  buildPlanModeViolationMessage,
} from "../planModeConstraints.js";
import { getAskModeViolation } from "../askModeConstraints.js";
import { isReadOnlyShellCommand } from "../builtin/bash/permissions.js";
import {
  applyResultSizeLimit,
  type SatiToolErrorResult,
  type SatiToolResult,
  type SatiToolSuccessResult,
} from "../protocol/result.js";
import type {
  SatiToolCall,
  SatiToolProgressEvent,
  SatiToolRuntimeContext,
  SatiToolResultContent,
} from "../protocol/types.js";
import { receiptFromToolExecution } from "../protocol/evidence.js";
import type { ToolRegistry } from "../registry/ToolRegistry.js";
import type { AgentEventEmitter } from "../../agent/protocol/events.js";
import { requiresPromptCapability } from "../userInteractionConstraints.js";
import { TOOL_OUTPUT_SCHEMA_MISMATCH, validateCanonicalOutput } from "./outputSchemaValidation.js";
import { fuseToolTimeout, isToolTimeout } from "./toolTimeout.js";
import { validateToolInput } from "./validateToolInput.js";
import { formatValidationError } from "./formatValidationError.js";
import { buildToolErrorRecovery } from "./errorRecovery.js";
import { repairToolName } from "./repairToolName.js";

/**
 * 审计记录非阻塞投递：同步实现立即执行；异步实现 fire-and-forget
 * （拒绝吞掉，审计失败不影响工具执行路径）。审计是可选旁路记录，
 * 工具调用不应串行等待审计写入（recordPermission/recordTool 类型均为
 * `void | Promise<void>`，await 空操作或慢实现都会阻塞热路径）。
 */
function deliverAuditRecord(record: void | Promise<void> | undefined): void {
  if (record instanceof Promise) {
    // fire-and-forget：审计写入失败不得影响工具执行路径（见上方 JSDoc）。
    void record.catch(() => {});
  }
}

export class ToolRuntime {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissionRuntime: PermissionRuntime,
    private readonly lifecycle?: LifecycleRuntime,
    private readonly eventEmitter?: AgentEventEmitter,
  ) {}

  async execute(call: SatiToolCall, context: SatiToolRuntimeContext): Promise<SatiToolResult> {
    const startedAtDate = now(context);
    const runtimeContext: SatiToolRuntimeContext = context.executeTool
      ? context
      : {
          ...context,
          executeTool: (nestedCall, contextPatch) => {
            runtimeContext.readFileState ??= new Map();
            runtimeContext.writeSnapshots ??= new Map();
            return this.execute(nestedCall, {
              ...runtimeContext,
              ...contextPatch,
              readFileState: runtimeContext.readFileState,
              writeSnapshots: runtimeContext.writeSnapshots,
              executeTool: runtimeContext.executeTool,
            });
          },
        };
    context = runtimeContext;
    const startedAt = startedAtDate.toISOString();
    let tool = this.registry.get(call.name);
    if (!tool) {
      const repaired = repairToolName(call.name, this.registry.list(), context.toolAliases);
      if (repaired) {
        tool = this.registry.get(repaired.name);
      }
    }
    const toolName = tool?.name ?? call.name;

    if (runtimeContext.abortSignal?.aborted) {
      return this.errorResult(
        call.id,
        toolName,
        "tool_aborted",
        "Tool execution was aborted.",
        startedAt,
        runtimeContext,
      );
    }

    if (!tool) {
      return this.errorResult(
        call.id,
        call.name,
        "tool_not_found",
        `Tool ${call.name} does not exist.`,
        startedAt,
        runtimeContext,
      );
    }

    const planModeViolation = getPlanModeViolation(tool.name, call.input, runtimeContext);
    if (planModeViolation) {
      return this.errorResult(call.id, tool.name, "plan_mode_violation", planModeViolation, startedAt, runtimeContext);
    }

    const askModeViolation = runtimeContext.runMode === "ask" ? getAskModeViolation(tool, call.input) : undefined;
    if (askModeViolation) {
      return this.errorResult(call.id, tool.name, "ask_mode_violation", askModeViolation, startedAt, runtimeContext);
    }

    const validation = validateToolInput(call.input, tool.inputSchema);
    if (!validation.ok) {
      return this.errorResult(
        call.id,
        tool.name,
        "invalid_tool_input",
        formatValidationError(tool.name, validation.issues, {
          maxOutputTokens: runtimeContext.maxOutputTokens,
          outputTruncated: runtimeContext.outputTruncated,
        }),
        startedAt,
        runtimeContext,
        { issues: validation.issues },
      );
    }

    if (runtimeContext.permissionContext.canPrompt === false && requiresPromptCapability(tool, call.input)) {
      return this.errorResult(
        call.id,
        tool.name,
        "unsupported_tool",
        `${tool.name} requires user interaction, but this session is running with prompts disabled.`,
        startedAt,
        runtimeContext,
      );
    }

    let executeInput = call.input;
    const preToolResult = await this.dispatchLifecycle("PreToolUse", tool.name, call.id, executeInput, context);
    this.eventEmitter?.({
      type: "pre_tool_execute",
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: call.id,
      toolName: tool.name,
    });
    const preBlock = findEffect(preToolResult.effects, "block");
    const prePermission = findEffect(preToolResult.effects, "permission_decision");
    const preDeny = prePermission?.behavior === "deny" ? prePermission : undefined;
    if (preBlock || preDeny) {
      return this.errorResult(
        call.id,
        tool.name,
        "permission_denied",
        preBlock?.reason ?? preDeny?.reason ?? `PreToolUse hook denied ${tool.name}.`,
        startedAt,
        context,
      );
    }
    const updatedInput = findEffect(preToolResult.effects, "updated_tool_input");
    if (updatedInput) {
      executeInput = updatedInput.input;
      const updatedValidation = validateToolInput(executeInput, tool.inputSchema);
      if (!updatedValidation.ok) {
        return this.errorResult(
          call.id,
          tool.name,
          "invalid_tool_input",
          `PreToolUse hook produced invalid input for ${tool.name}.

${formatValidationError(tool.name, updatedValidation.issues, {
  maxOutputTokens: runtimeContext.maxOutputTokens,
  outputTruncated: runtimeContext.outputTruncated,
})}`,
          startedAt,
          context,
          { issues: updatedValidation.issues },
        );
      }
    }

    const toolValidation = await tool.validateInput?.(executeInput, context);
    if (toolValidation && !toolValidation.ok) {
      return this.errorResult(
        call.id,
        tool.name,
        "invalid_tool_input",
        formatValidationError(tool.name, toolValidation.issues, {
          maxOutputTokens: runtimeContext.maxOutputTokens,
          outputTruncated: runtimeContext.outputTruncated,
        }),
        startedAt,
        context,
        { issues: toolValidation.issues },
      );
    }

    const todoGateMessage = context.planTodo?.blockingMessageFor(tool.name, tool.isReadOnly(executeInput));
    if (todoGateMessage) {
      return this.errorResult(call.id, tool.name, "tool_execution_failed", todoGateMessage, startedAt, context);
    }

    let decision = await this.permissionRuntime.decide(tool, executeInput, context, call.id);
    if (decision.type === "ask") {
      const permissionHookResult = await this.dispatchLifecycle(
        "PermissionRequest",
        tool.name,
        call.id,
        executeInput,
        context,
        {
          permissionSuggestions: decision.request.options,
        },
      );
      this.eventEmitter?.({
        type: "permission_requested",
        sessionId: context.sessionId,
        turnId: context.turnId,
        toolCallId: call.id,
        toolName: tool.name,
      });
      const permissionRequestResult = findEffect(permissionHookResult.effects, "permission_request_result");
      if (permissionRequestResult?.result.behavior === "allow") {
        decision = {
          type: "allow",
          reason: { type: "runtime", message: `PermissionRequest hook allowed ${tool.name}.` },
          updatedInput: permissionRequestResult.result.updatedInput,
        };
      } else if (permissionRequestResult?.result.behavior === "deny") {
        decision = {
          type: "deny",
          reason: {
            type: "runtime",
            message: permissionRequestResult.result.message ?? `PermissionRequest hook denied ${tool.name}.`,
          },
          message: permissionRequestResult.result.message ?? `PermissionRequest hook denied ${tool.name}.`,
        };
      }
    }
    deliverAuditRecord(
      context.auditRecorder?.recordPermission({
        type: "permission",
        sessionId: context.sessionId,
        turnId: context.turnId,
        toolCallId: call.id,
        toolName: tool.name,
        mode: context.permissionContext.mode,
        decision: decision.type,
        reason: decision.reason,
        createdAt: now(context).toISOString(),
      }),
    );

    if (decision.type === "deny") {
      await this.dispatchLifecycle("PermissionDenied", tool.name, call.id, executeInput, context, {
        reason: decision.message,
      });
      this.eventEmitter?.({
        type: "permission_denied",
        sessionId: context.sessionId,
        turnId: context.turnId,
        toolName: tool.name,
        reason: decision.message,
      });
      const code: SatiToolErrorCode =
        decision.reason.type === "runtime" && decision.reason.message.includes("prompt")
          ? "permission_required"
          : "permission_denied";
      return this.errorResult(call.id, tool.name, code, decision.message, startedAt, context);
    }

    if (decision.type === "cancel") {
      return this.errorResult(call.id, tool.name, "permission_cancelled", decision.message, startedAt, context);
    }

    if (decision.type === "ask") {
      return this.errorResult(
        call.id,
        tool.name,
        "permission_required",
        `Permission is required to run ${tool.name}.`,
        startedAt,
        context,
        { request: decision.request },
      );
    }

    executeInput = decision.updatedInput ?? executeInput;
    const baseContext: SatiToolRuntimeContext = {
      ...context,
      currentToolCallId: call.id,
      currentPermissionDecision: decision,
    };
    // 阶段四 T6.1：registry 级超时强制——工具自报 timeoutMs 时，把 deadline
    // 熔合进执行 signal；到期以 TOOL_TIMEOUT 归一（合作式：忽略 signal 的
    // 工具无法被硬杀，见计划 §7 风险 4）。
    const fusedAbortSignal =
      tool.timeoutMs === undefined ? baseContext.abortSignal : fuseToolTimeout(baseContext.abortSignal, tool.timeoutMs);
    const executeContext: SatiToolRuntimeContext = {
      ...baseContext,
      ...(fusedAbortSignal === baseContext.abortSignal ? {} : { abortSignal: fusedAbortSignal }),
      ...(baseContext.progress
        ? {
            progress: (event: SatiToolProgressEvent) =>
              baseContext.progress!({
                ...event,
                toolCallId: event.toolCallId || call.id,
                toolName: event.toolName || tool.name,
              }),
          }
        : {}),
    };
    try {
      const output = await tool.execute(executeInput, executeContext);
      // 阶段四 T6.1：超时判定——工具返回后若熔合信号因 deadline 中止（而非
      // 调用方取消），归一为结构化 TOOL_TIMEOUT。
      if (isToolTimeout(fusedAbortSignal, baseContext.abortSignal)) {
        throw new SatiToolRuntimeError("tool_timeout", `Tool ${tool.name} exceeded its ${tool.timeoutMs}ms budget`);
      }
      // 阶段四 T9：工具声明 outputSchema 时，成功路径的 canonical data 必须
      // 通过校验。data 缺省（如失败路径只返回 content）不触发校验——schema
      // 声明的是成功契约；data 存在即必须匹配。
      if (tool.outputSchema !== undefined && output.data !== undefined) {
        const violations = validateCanonicalOutput(output.data, tool.outputSchema);
        if (violations.length > 0) {
          const shown = violations.slice(0, 5).join("; ");
          const suffix = violations.length > 5 ? " (+" + String(violations.length - 5) + " more)" : "";
          // 必须抛 SatiToolRuntimeError（Error 子类）：normalizeToolError 对
          // 非 Error 值一律归一为 tool_execution_failed，会吞掉本结构化错误码。
          throw new SatiToolRuntimeError(
            TOOL_OUTPUT_SCHEMA_MISMATCH,
            `Tool ${tool.name} canonical output violates its outputSchema: ${shown}${suffix}`,
            { violations },
          );
        }
      }
      const maxResultBytes = tool.maxResultBytes ?? context.maxResultBytes;
      const previewLimit = applyResultSizeLimit(output.content, maxResultBytes);
      const completedAt = now(context).toISOString();
      const postToolLifecycle = await this.dispatchLifecycle("PostToolUse", tool.name, call.id, executeInput, context, {
        toolResponse: output.data ?? output.content,
      });
      this.eventEmitter?.({
        type: "post_tool_execute",
        sessionId: context.sessionId,
        turnId: context.turnId,
        toolCallId: call.id,
        toolName: tool.name,
        success: true,
      });
      const result: SatiToolSuccessResult = {
        type: "success",
        toolCallId: call.id,
        toolName: tool.name,
        // 主路径（ToolResultBudget spill）需要完整原文落盘，不得截断；
        // 直调路径（无 spill 层）由 applyResultSizeLimit 头尾截断兜底。
        content: context.spillLayerActive ? output.content : previewLimit.content,
        supplementalMessages: output.supplementalMessages,
        data: output.data,
        metadata: mergeMetadata(
          output.metadata,
          mergeMetadata(
            previewLimit.metadata ? { previewLimit: previewLimit.metadata } : undefined,
            lifecycleMetadata(postToolLifecycle),
          ),
        ),
        startedAt,
        completedAt,
      };
      if (!tool.isReadOnly(executeInput) && tool.name !== "todo_write") {
        context.planTodo?.markToolProgressChanged(tool.name);
      }
      // 证据闭环自动收集：成功路径记录 Receipt（工具调用账本）。
      context.evidenceCollector?.recordReceipt(
        receiptFromToolExecution({
          toolCallId: call.id,
          turnId: context.turnId,
          toolName: tool.name,
          args: call.input,
          success: true,
          startedAt,
          resultText: flattenToolOutputText(output.content),
        }),
      );
      this.recordToolAudit(result, context, startedAtDate);
      return result;
    } catch (error) {
      // 阶段四 T6.1：合作式工具在 deadline 处观察到熔合 signal 并自行抛出
      // abort 类错误时，先替换为 TOOL_TIMEOUT，共享下方错误路径（错误码/审计/
      // 证据闭环一致）。
      const effectiveError = isToolTimeout(fusedAbortSignal, baseContext.abortSignal)
        ? new SatiToolRuntimeError("tool_timeout", `Tool ${tool.name} exceeded its ${tool.timeoutMs}ms budget`)
        : error;
      const normalized = normalizeToolError(effectiveError);
      await this.dispatchLifecycle("PostToolUseFailure", tool.name, call.id, executeInput, context, {
        error: normalized.message,
        isInterrupt: normalized.code === "tool_aborted",
      });
      this.eventEmitter?.({
        type: "post_tool_execute",
        sessionId: context.sessionId,
        turnId: context.turnId,
        toolCallId: call.id,
        toolName: tool.name,
        success: false,
      });
      const result = this.createErrorResult(
        call.id,
        tool.name,
        normalized.code,
        normalized.message,
        startedAt,
        context,
        normalized.details,
      );
      // 证据闭环自动收集：失败路径同样记录 Receipt（成败均有审计价值）。
      context.evidenceCollector?.recordReceipt(
        receiptFromToolExecution({
          toolCallId: call.id,
          turnId: context.turnId,
          toolName: tool.name,
          args: call.input,
          success: false,
          startedAt,
          resultText: normalized.message,
        }),
      );
      this.recordToolAudit(result, context, startedAtDate);
      return result;
    }
  }

  private async errorResult(
    toolCallId: string,
    toolName: string,
    code: SatiToolErrorCode,
    message: string,
    startedAt: string,
    context: SatiToolRuntimeContext,
    details?: Record<string, unknown>,
  ): Promise<SatiToolErrorResult> {
    const startedAtDate = new Date(startedAt);
    const result = this.createErrorResult(toolCallId, toolName, code, message, startedAt, context, details);
    this.recordToolAudit(result, context, startedAtDate);
    return result;
  }

  private createErrorResult(
    toolCallId: string,
    toolName: string,
    code: SatiToolErrorCode,
    message: string,
    startedAt: string,
    context: SatiToolRuntimeContext,
    details?: Record<string, unknown>,
  ): SatiToolErrorResult {
    const completedAt = now(context).toISOString();
    const recovery = buildToolErrorRecovery({
      code,
      toolName,
      message,
      cwd: context.cwd,
      permissionMode: context.permissionMode,
      details,
    });
    return {
      type: "error",
      toolCallId,
      toolName,
      error: toolError(code, message, details),
      content: [{ type: "text", text: formatToolErrorContent(recovery.message, details) }],
      metadata: {
        recovery: recovery.advice,
      },
      startedAt,
      completedAt,
    };
  }

  private recordToolAudit(result: SatiToolResult, context: SatiToolRuntimeContext, startedAt: Date): void {
    deliverAuditRecord(
      context.auditRecorder?.recordTool({
        type: "tool",
        sessionId: context.sessionId,
        turnId: context.turnId,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        status: result.type === "success" ? "success" : "error",
        errorCode: result.type === "error" ? result.error.code : undefined,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        durationMs: new Date(result.completedAt).getTime() - startedAt.getTime(),
      }),
    );
  }

  private async dispatchLifecycle(
    event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PermissionRequest" | "PermissionDenied",
    toolName: string,
    toolCallId: string,
    toolInput: unknown,
    context: SatiToolRuntimeContext,
    extraPayload: Record<string, unknown> = {},
  ) {
    return (
      this.lifecycle?.dispatch({
        event,
        baseInput: {
          sessionId: context.sessionId,
          transcriptPath: "",
          cwd: context.cwd,
          permissionMode: context.permissionMode,
        },
        matchQuery: toolName,
        payload: {
          toolName,
          toolInput,
          toolUseId: toolCallId,
          ...extraPayload,
        },
        signal: context.abortSignal,
        env: context.env,
      }) ?? {
        effects: [],
        messages: [],
        events: [],
        blockingErrors: [],
        nonBlockingErrors: [],
      }
    );
  }
}

/** 工具输出内容文本摘录（供证据 Receipt resultText）。 */
function flattenToolOutputText(content: SatiToolResultContent[]): string {
  return content
    .map(block => {
      if (block.type === "text") return block.text;
      if (block.type === "json") return JSON.stringify(block.value);
      if (block.type === "file") return block.path;
      return "";
    })
    .join("\n")
    .trim();
}

function formatToolErrorContent(recoveryMessage: string, details?: Record<string, unknown>): string {
  const rawDetails = formatRawToolErrorDetails(details);
  return rawDetails ? `${recoveryMessage}\n\n${rawDetails}` : recoveryMessage;
}

function formatRawToolErrorDetails(details?: Record<string, unknown>): string | undefined {
  if (!details) {
    return undefined;
  }

  const lines: string[] = [];
  const command = readStringDetail(details, "command");
  const exitCode = details.exitCode;
  const timedOut = details.timedOut;
  const durationMs = details.durationMs;

  if (command || exitCode !== undefined || timedOut !== undefined || durationMs !== undefined) {
    lines.push("Raw tool details:");
    if (command) lines.push(`- command: ${command}`);
    if (exitCode !== undefined) lines.push(`- exit_code: ${String(exitCode)}`);
    if (timedOut !== undefined) lines.push(`- timed_out: ${String(timedOut)}`);
    if (durationMs !== undefined) lines.push(`- duration_ms: ${String(durationMs)}`);
  }

  const diagnostic = readStringDetail(details, "diagnostic");
  if (diagnostic) {
    lines.push("", "Diagnostic:", diagnostic.trimEnd());
  }

  appendRawStream(lines, "stdout", readStringDetail(details, "stdout"));
  appendRawStream(lines, "stderr", readStringDetail(details, "stderr"));

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function appendRawStream(lines: string[], label: "stdout" | "stderr", value: string | undefined): void {
  if (!value || value.length === 0) {
    return;
  }
  lines.push("", `${label}:`, value.trimEnd());
}

function readStringDetail(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" ? value : undefined;
}

function getPlanModeViolation(toolName: string, input: unknown, context: SatiToolRuntimeContext): string | undefined {
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

function findEffect<Type extends SatiHookEffect["type"]>(
  effects: SatiHookEffect[],
  type: Type,
): Extract<SatiHookEffect, { type: Type }> | undefined {
  return effects.find((effect): effect is Extract<SatiHookEffect, { type: Type }> => effect.type === type);
}

function lifecycleMetadata(result: { effects: SatiHookEffect[] }): Record<string, unknown> | undefined {
  const blocking = result.effects.find(effect => effect.type === "block");
  const additionalContext = result.effects.filter(effect => effect.type === "additional_context");
  const updatedMcpOutput = result.effects.find(effect => effect.type === "updated_mcp_tool_output");
  if (!blocking && additionalContext.length === 0 && !updatedMcpOutput) {
    return undefined;
  }
  return {
    lifecycle: {
      blocked: blocking ? { reason: blocking.reason, stopReason: blocking.stopReason } : undefined,
      additionalContext: additionalContext.map(effect => effect.content),
      updatedMcpToolOutput: updatedMcpOutput?.output,
    },
  };
}

function now(context: SatiToolRuntimeContext): Date {
  return context.now?.() ?? new Date();
}

function mergeMetadata(
  first: Record<string, unknown> | undefined,
  second: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!first && !second) {
    return undefined;
  }

  return {
    ...(first ?? {}),
    ...(second ?? {}),
  };
}
