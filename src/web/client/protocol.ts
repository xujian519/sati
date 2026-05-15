/**
 * Browser-friendly mirror of `src/gateway/protocol/types.ts` and
 * `src/gateway/protocol/frames.ts`.
 *
 * The browser bundle cannot import `src/gateway/protocol/types.ts` directly
 * because that file imports from `src/agent`, `src/cron`, `src/session`,
 * `src/tool` etc. (Node-only). This module copies the minimal shape needed
 * for the Web UI and is asserted against the canonical types via
 * `tests/web-ui-client/protocol-sync.test.ts`.
 */

export const PILOTDECK_GATEWAY_PROTOCOL_VERSION_WEB = "1.0";

export type WebGatewayMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions";

export type WebGatewayChannelKey =
  | "cli"
  | "tui"
  | "feishu"
  | "web"
  | "test"
  | (string & {});

export type WebElicitationQuestion = {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
  allowMultiple?: boolean;
};

export type WebElicitationAnswer =
  | { kind: "selected"; questionId: string; optionIds: string[] }
  | { kind: "cancelled"; reason?: string };

export type WebGatewayEvent =
  | { type: "turn_started"; runId: string }
  | { type: "assistant_text_delta"; text: string }
  | { type: "assistant_thinking_delta"; text: string }
  | {
      type: "tool_call_started";
      toolCallId: string;
      name: string;
      argsPreview?: string;
    }
  | {
      type: "tool_call_finished";
      toolCallId: string;
      ok: boolean;
      resultPreview?: string;
      /** Mirrors `GatewayEvent.tool_call_finished.errorCode`. */
      errorCode?: string;
    }
  | {
      type: "permission_request";
      requestId: string;
      toolName: string;
      payload: unknown;
    }
  | {
      type: "elicitation_request";
      requestId: string;
      toolCallId: string;
      toolName: string;
      previewFormat?: "html" | "markdown";
      questions: WebElicitationQuestion[];
      metadata?: Record<string, unknown>;
    }
  | { type: "elicitation_cancelled"; requestId: string; reason?: string }
  | { type: "structured_output"; payload: unknown }
  | { type: "plan_mode_changed"; mode: WebGatewayMode | (string & {}) }
  | { type: "config_changed"; changedPaths: string[]; changeClasses: string[] }
  | { type: "worktree_created"; runId: string; cwd: string }
  | { type: "worktree_removed"; cwd: string }
  | { type: "turn_completed"; usage: Record<string, number>; finishReason: string }
  | { type: "error"; message: string; code?: string; recoverable: boolean };

export type WebGatewayMethod =
  | "submit_turn"
  | "abort_turn"
  | "list_sessions"
  | "resume_session"
  | "new_session"
  | "close_session"
  | "describe_server"
  | "cron_create"
  | "cron_list"
  | "cron_delete"
  | "cron_stop"
  | "cron_run_now"
  | "elicitation_respond"
  | "permission_decide"
  | "grant_session_permission"
  | "read_session_messages"
  | "rename_session"
  | "delete_session"
  | "list_projects"
  | "describe_project"
  | "reload_config"
  | "skill_list"
  | "skill_read"
  | "skill_write"
  | "skill_create"
  | "skill_delete"
  | "skill_import"
  | "skill_validate"
  | "skill_scan"
  | "always_on_apply";

export type WebSubmitTurnInput = {
  sessionKey: string;
  channelKey: WebGatewayChannelKey;
  message: string;
  projectKey?: string;
  attachments?: WebChannelAttachment[];
  mode?: WebGatewayMode;
  runId?: string;
};

export type WebChannelAttachment = {
  type: "file" | "image" | "text" | "unknown";
  name?: string;
  path?: string;
  mimeType?: string;
  content?: string;
  bytes?: number;
  metadata?: Record<string, unknown>;
};

export type WebSessionInfo = {
  sessionId: string;
  sessionKey?: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  aiTitle?: string;
  firstPrompt?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
};

export type WebListSessionsInput = {
  projectKey?: string;
  limit?: number;
  cursor?: string;
};

export type WebListSessionsResult = {
  sessions: WebSessionInfo[];
  nextCursor?: string;
};

export type WebHelloOk = {
  type: "hello_ok";
  protocolVersion: string;
  serverVersion: string;
  serverInfo: {
    mode: "in_process" | "remote";
    protocolVersion?: string;
    projectKey?: string;
    sessionCount?: number;
  };
};

export type WebRequestFrame = {
  type: "request";
  id: string;
  method: WebGatewayMethod;
  params: unknown;
};

export type WebResponseFrame =
  | { type: "response"; id: string; ok: true; result: unknown }
  | {
      type: "response";
      id: string;
      ok: false;
      error: { code: string; message: string };
    };

export type WebEventFrame = {
  type: "event";
  id: string;
  seq: number;
  final: boolean;
  event: WebGatewayEvent;
};

export type WebGatewayFrame =
  | WebHelloOk
  | WebResponseFrame
  | WebEventFrame;

export type WebPermissionDecision = {
  requestId: string;
  decision: "allow" | "deny";
  remember?: boolean;
  reason?: string;
};

export type WebSessionPermissionGrant = {
  sessionKey: string;
  entry: string;
};

export type WebReadSessionMessagesInput = {
  sessionKey: string;
  projectKey?: string;
  limit?: number;
  cursor?: string;
  direction?: "forward" | "backward";
};

export type WebReadSessionMessagesResult = {
  messages: import("./webMessage.js").WebMessage[];
  nextCursor?: string;
  total?: number;
  session: WebSessionInfo;
};

export type WebProjectSummary = {
  projectKey: string;
  name: string;
  fullPath: string;
  sessionCount: number;
  lastActivity?: number;
};

export type WebListProjectsResult = {
  projects: WebProjectSummary[];
};
