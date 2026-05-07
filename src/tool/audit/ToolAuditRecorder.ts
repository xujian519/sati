import type { PermissionDecision, PermissionDecisionReason, PermissionMode } from "../../permission/index.js";
import type { PolitDeckToolErrorCode } from "../protocol/errors.js";

export type PolitDeckPermissionAuditRecord = {
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

export type PolitDeckToolAuditRecord = {
  type: "tool";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  status: "success" | "error";
  errorCode?: PolitDeckToolErrorCode;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

export type PolitDeckToolAuditRecorder = {
  recordPermission(record: PolitDeckPermissionAuditRecord): void | Promise<void>;
  recordTool(record: PolitDeckToolAuditRecord): void | Promise<void>;
};
