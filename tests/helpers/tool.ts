import { createDefaultPermissionContext, PermissionRuntime, type PermissionMode, type PermissionResult } from "../../src/permission/index.js";
import type { LifecycleRuntime } from "../../src/lifecycle/index.js";
import type { MultimodalConstraints } from "../../src/model/index.js";
import {
  ToolRegistry,
  ToolRuntime,
  type PilotDeckElicitationChannel,
  type PilotDeckToolAuditRecorder,
  type PilotDeckToolDefinition,
  type PilotDeckToolExecutionOutput,
  type PilotDeckFileUpdateNotifier,
  type PilotDeckToolFileHistorySink,
  type PilotDeckToolInputSchema,
  type PilotDeckToolRuntimeContext,
  type PilotDeckWriteSnapshotMap,
} from "../../src/tool/index.js";

export function createPilotDeckTestTool(options: {
  name: string;
  aliases?: string[];
  inputSchema?: PilotDeckToolInputSchema;
  readOnly?: boolean;
  concurrencySafe?: boolean;
  kind?: PilotDeckToolDefinition["kind"];
  permissionResult?: PermissionResult;
  maxResultBytes?: number;
  execute?: (input: unknown, context: PilotDeckToolRuntimeContext) => Promise<PilotDeckToolExecutionOutput>;
}): PilotDeckToolDefinition {
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

export function createPilotDeckToolRuntimeFixture(options?: {
  tools?: PilotDeckToolDefinition[];
  permissionMode?: PermissionMode;
  canPrompt?: boolean;
  auditRecorder?: PilotDeckToolAuditRecorder;
  maxResultBytes?: number;
  cwd?: string;
  lifecycle?: LifecycleRuntime;
  elicitation?: PilotDeckElicitationChannel;
  fileHistory?: PilotDeckToolFileHistorySink;
  fileUpdateNotifier?: PilotDeckFileUpdateNotifier;
  messageId?: string;
  modelMultimodal?: MultimodalConstraints;
  maxOutputTokens?: number;
  writeSnapshots?: PilotDeckWriteSnapshotMap;
}): {
  registry: ToolRegistry;
  permissionRuntime: PermissionRuntime;
  toolRuntime: ToolRuntime;
  context: PilotDeckToolRuntimeContext;
} {
  const registry = new ToolRegistry();
  for (const tool of options?.tools ?? []) {
    registry.register(tool);
  }

  const permissionRuntime = new PermissionRuntime();
  const toolRuntime = new ToolRuntime(registry, permissionRuntime, options?.lifecycle);
  const cwd = options?.cwd ?? process.cwd();
  const context: PilotDeckToolRuntimeContext = {
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
    fileUpdateNotifier: options?.fileUpdateNotifier,
    messageId: options?.messageId,
    modelMultimodal: options?.modelMultimodal,
    maxOutputTokens: options?.maxOutputTokens,
    writeSnapshots: options?.writeSnapshots,
  };

  return { registry, permissionRuntime, toolRuntime, context };
}
