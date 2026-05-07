import { PermissionRuntime } from "../../permission/index.js";
import { toolError } from "../protocol/errors.js";
import type { PolitDeckToolErrorCode } from "../protocol/errors.js";
import {
  applyResultSizeLimit,
  type PolitDeckToolErrorResult,
  type PolitDeckToolResult,
  type PolitDeckToolSuccessResult,
} from "../protocol/result.js";
import type { PolitDeckToolCall, PolitDeckToolRuntimeContext } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/ToolRegistry.js";
import { validateToolInput } from "./validateToolInput.js";
import { normalizeToolError } from "../protocol/errors.js";

export class ToolRuntime {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissionRuntime: PermissionRuntime,
  ) {}

  async execute(call: PolitDeckToolCall, context: PolitDeckToolRuntimeContext): Promise<PolitDeckToolResult> {
    const startedAtDate = now(context);
    const startedAt = startedAtDate.toISOString();
    const tool = this.registry.get(call.name);
    const toolName = tool?.name ?? call.name;

    if (context.abortSignal?.aborted) {
      return this.errorResult(call.id, toolName, "tool_aborted", "Tool execution was aborted.", startedAt, context);
    }

    if (!tool) {
      return this.errorResult(
        call.id,
        call.name,
        "tool_not_found",
        `Tool ${call.name} does not exist.`,
        startedAt,
        context,
      );
    }

    const validation = validateToolInput(call.input, tool.inputSchema);
    if (!validation.ok) {
      return this.errorResult(
        call.id,
        tool.name,
        "invalid_tool_input",
        `Tool ${tool.name} input is invalid.`,
        startedAt,
        context,
        { issues: validation.issues },
      );
    }

    const toolValidation = await tool.validateInput?.(call.input, context);
    if (toolValidation && !toolValidation.ok) {
      return this.errorResult(
        call.id,
        tool.name,
        "invalid_tool_input",
        `Tool ${tool.name} rejected the input.`,
        startedAt,
        context,
        { issues: toolValidation.issues },
      );
    }

    const decision = await this.permissionRuntime.decide(tool, call.input, context, call.id);
    await context.auditRecorder?.recordPermission({
      type: "permission",
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: call.id,
      toolName: tool.name,
      mode: context.permissionContext.mode,
      decision: decision.type,
      reason: decision.reason,
      createdAt: now(context).toISOString(),
    });

    if (decision.type === "deny") {
      const code: PolitDeckToolErrorCode =
        decision.reason.type === "runtime" && decision.reason.message.includes("prompt") ?
          "permission_required" :
          "permission_denied";
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

    const executeInput = decision.updatedInput ?? call.input;
    try {
      const output = await tool.execute(executeInput, context);
      const maxResultBytes = tool.maxResultBytes ?? context.maxResultBytes;
      const limited = applyResultSizeLimit(output.content, maxResultBytes);
      const completedAt = now(context).toISOString();
      const result: PolitDeckToolSuccessResult = {
        type: "success",
        toolCallId: call.id,
        toolName: tool.name,
        content: limited.content,
        data: output.data,
        metadata: mergeMetadata(output.metadata, limited.metadata),
        startedAt,
        completedAt,
      };
      await this.recordToolAudit(result, context, startedAtDate);
      return result;
    } catch (error) {
      const normalized = normalizeToolError(error);
      const result = this.createErrorResult(call.id, tool.name, normalized.code, normalized.message, startedAt, context, {
        details: normalized.details,
      });
      await this.recordToolAudit(result, context, startedAtDate);
      return result;
    }
  }

  private async errorResult(
    toolCallId: string,
    toolName: string,
    code: PolitDeckToolErrorCode,
    message: string,
    startedAt: string,
    context: PolitDeckToolRuntimeContext,
    details?: Record<string, unknown>,
  ): Promise<PolitDeckToolErrorResult> {
    const startedAtDate = new Date(startedAt);
    const result = this.createErrorResult(toolCallId, toolName, code, message, startedAt, context, details);
    await this.recordToolAudit(result, context, startedAtDate);
    return result;
  }

  private createErrorResult(
    toolCallId: string,
    toolName: string,
    code: PolitDeckToolErrorCode,
    message: string,
    startedAt: string,
    context: PolitDeckToolRuntimeContext,
    details?: Record<string, unknown>,
  ): PolitDeckToolErrorResult {
    const completedAt = now(context).toISOString();
    return {
      type: "error",
      toolCallId,
      toolName,
      error: toolError(code, message, details),
      content: [{ type: "text", text: message }],
      startedAt,
      completedAt,
    };
  }

  private async recordToolAudit(
    result: PolitDeckToolResult,
    context: PolitDeckToolRuntimeContext,
    startedAt: Date,
  ): Promise<void> {
    await context.auditRecorder?.recordTool({
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
    });
  }
}

function now(context: PolitDeckToolRuntimeContext): Date {
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
