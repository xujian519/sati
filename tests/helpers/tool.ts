import { createDefaultPermissionContext, PermissionRuntime, type PermissionMode, type PermissionResult } from "../../src/permission/index.js";
import type { LifecycleRuntime } from "../../src/lifecycle/index.js";
import {
  ToolRegistry,
  ToolRuntime,
  type PolitDeckElicitationChannel,
  type PolitDeckToolAuditRecorder,
  type PolitDeckToolDefinition,
  type PolitDeckToolExecutionOutput,
  type PolitDeckToolFileHistorySink,
  type PolitDeckToolInputSchema,
  type PolitDeckToolRuntimeContext,
} from "../../src/tool/index.js";

export function createPolitDeckTestTool(options: {
  name: string;
  aliases?: string[];
  inputSchema?: PolitDeckToolInputSchema;
  readOnly?: boolean;
  concurrencySafe?: boolean;
  kind?: PolitDeckToolDefinition["kind"];
  permissionResult?: PermissionResult;
  maxResultBytes?: number;
  execute?: (input: unknown, context: PolitDeckToolRuntimeContext) => Promise<PolitDeckToolExecutionOutput>;
}): PolitDeckToolDefinition {
  return {
    name: options.name,
    aliases: options.aliases,
    description: `${options.name} test tool`,
    kind: options.kind ?? "custom",
    inputSchema: options.inputSchema ?? {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    maxResultBytes: options.maxResultBytes,
    isReadOnly: () => options.readOnly ?? true,
    isConcurrencySafe: () => options.concurrencySafe ?? true,
    checkPermissions: options.permissionResult ? async () => options.permissionResult! : undefined,
    execute: options.execute ?? (async () => ({ content: [{ type: "text", text: "ok" }] })),
  };
}

export function createPolitDeckToolRuntimeFixture(options?: {
  tools?: PolitDeckToolDefinition[];
  permissionMode?: PermissionMode;
  canPrompt?: boolean;
  auditRecorder?: PolitDeckToolAuditRecorder;
  maxResultBytes?: number;
  cwd?: string;
  lifecycle?: LifecycleRuntime;
  elicitation?: PolitDeckElicitationChannel;
  fileHistory?: PolitDeckToolFileHistorySink;
  messageId?: string;
}): {
  registry: ToolRegistry;
  permissionRuntime: PermissionRuntime;
  toolRuntime: ToolRuntime;
  context: PolitDeckToolRuntimeContext;
} {
  const registry = new ToolRegistry();
  for (const tool of options?.tools ?? []) {
    registry.register(tool);
  }

  const permissionRuntime = new PermissionRuntime();
  const toolRuntime = new ToolRuntime(registry, permissionRuntime, options?.lifecycle);
  const cwd = options?.cwd ?? process.cwd();
  const context: PolitDeckToolRuntimeContext = {
    sessionId: "test-session",
    turnId: "test-turn",
    cwd,
    permissionMode: options?.permissionMode ?? "default",
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: options?.permissionMode ?? "default",
      canPrompt: options?.canPrompt ?? false,
    }),
    auditRecorder: options?.auditRecorder,
    maxResultBytes: options?.maxResultBytes,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    elicitation: options?.elicitation,
    fileHistory: options?.fileHistory,
    messageId: options?.messageId,
  };

  return { registry, permissionRuntime, toolRuntime, context };
}
