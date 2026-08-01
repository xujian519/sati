import type { PermissionDecision, PermissionDecisionReason, PermissionMode } from "../../permission/index.js";
import type { SatiToolErrorCode } from "../protocol/errors.js";

export type SatiPermissionAuditRecord = {
  type: "permission";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  mode: PermissionMode;
  decision: PermissionDecision["type"];
  reason: PermissionDecisionReason;
  createdAt: string;
};

export type SatiToolAuditRecord = {
  type: "tool";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  status: "success" | "error";
  errorCode?: SatiToolErrorCode;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

export type SatiToolAuditRecorder = {
  recordPermission(record: SatiPermissionAuditRecord): void | Promise<void>;
  recordTool(record: SatiToolAuditRecord): void | Promise<void>;
};
