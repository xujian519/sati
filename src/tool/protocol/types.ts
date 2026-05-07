import type { CanonicalToolCall } from "../../model/index.js";
import type {
  PermissionContext,
  PermissionMode,
  PermissionResult,
} from "../../permission/index.js";
import type { PolitDeckToolAuditRecorder } from "../audit/ToolAuditRecorder.js";
import type { PolitDeckToolInputSchema, PolitDeckToolValidationResult } from "./schema.js";

export type PolitDeckToolKind =
  | "filesystem"
  | "shell"
  | "network"
  | "mcp"
  | "session"
  | "agent"
  | "structured_output"
  | "custom";

export type PolitDeckToolResultContent =
  | { type: "text"; text: string }
  | { type: "json"; value: unknown }
  | { type: "image"; mimeType: string; data: string }
  | { type: "file"; path: string; mimeType?: string; description?: string };

export type PolitDeckToolExecutionOutput<Output = unknown> = {
  content: PolitDeckToolResultContent[];
  data?: Output;
  metadata?: Record<string, unknown>;
};

export type PolitDeckToolRuntimeContext = {
  sessionId: string;
  turnId: string;
  cwd: string;
  abortSignal?: AbortSignal;
  permissionMode: PermissionMode;
  permissionContext: PermissionContext;
  auditRecorder?: PolitDeckToolAuditRecorder;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  maxResultBytes?: number;
};

export type PolitDeckToolDefinition<Input = unknown, Output = unknown> = {
  name: string;
  aliases?: string[];
  title?: string;
  description: string;
  kind: PolitDeckToolKind;
  inputSchema: PolitDeckToolInputSchema;
  outputSchema?: Record<string, unknown>;
  maxResultBytes?: number;
  shouldDefer?: boolean;
  alwaysLoad?: boolean;
  searchHint?: string;
  isReadOnly(input: Input): boolean;
  isConcurrencySafe(input: Input): boolean;
  isDestructive?(input: Input): boolean;
  requiresUserInteraction?(input: Input): boolean;
  isOpenWorld?(input: Input): boolean;
  validateInput?(input: Input, context: PolitDeckToolRuntimeContext): Promise<PolitDeckToolValidationResult>;
  checkPermissions?(input: Input, context: PolitDeckToolRuntimeContext): Promise<PermissionResult>;
  execute(input: Input, context: PolitDeckToolRuntimeContext): Promise<PolitDeckToolExecutionOutput<Output>>;
};

export type PolitDeckToolCall = CanonicalToolCall;
