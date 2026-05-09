import type { AgentTurnResult } from "../../agent/index.js";
import type {
  CronCreateInput,
  CronCreateResult,
  CronDeleteInput,
  CronDeleteResult,
  CronListInput,
  CronListResult,
  CronStopInput,
  CronStopResult,
} from "../../cron/protocol/types.js";
import type { CanonicalUsage } from "../../model/index.js";
import type { SessionInfo as ProjectSessionInfo } from "../../session/index.js";

export type GatewayChannelKey = "cli" | "tui" | "feishu" | "web" | "test" | (string & {});

export type GatewayMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";

export type ChannelAttachment = {
  type: "file" | "image" | "text" | "unknown";
  name?: string;
  path?: string;
  mimeType?: string;
  content?: string;
  bytes?: number;
  metadata?: Record<string, unknown>;
};

export type TurnUsage = CanonicalUsage;

export type GatewaySubmitTurnInput = {
  sessionKey: string;
  channelKey: GatewayChannelKey;
  message: string;
  projectKey?: string;
  attachments?: ChannelAttachment[];
  mode?: GatewayMode;
  runId?: string;
};

export type GatewayEvent =
  | { type: "turn_started"; runId: string }
  | { type: "assistant_text_delta"; text: string }
  | { type: "assistant_thinking_delta"; text: string }
  | { type: "tool_call_started"; toolCallId: string; name: string; argsPreview?: string }
  | { type: "tool_call_finished"; toolCallId: string; ok: boolean; resultPreview?: string }
  | { type: "permission_request"; requestId: string; toolName: string; payload: unknown }
  | { type: "structured_output"; payload: unknown }
  | { type: "plan_mode_changed"; mode: GatewayMode | (string & {}) }
  | { type: "turn_completed"; usage: TurnUsage; finishReason: AgentTurnResult["stopReason"] | string }
  | { type: "error"; message: string; code?: string; recoverable: boolean };

export type GatewayError = {
  code: string;
  message: string;
  recoverable: boolean;
};

export type ListSessionsInput = {
  projectKey?: string;
  limit?: number;
  cursor?: string;
};

export type GatewaySessionInfo = ProjectSessionInfo & {
  sessionKey?: string;
};

export type ListSessionsResult = {
  sessions: GatewaySessionInfo[];
  nextCursor?: string;
};

export type NewSessionInput = {
  projectKey?: string;
  channelKey: GatewayChannelKey;
  hint?: string;
};

export type GatewayServerInfo = {
  mode: "in_process" | "remote";
  protocolVersion?: string;
  projectKey?: string;
  sessionCount?: number;
};

export type GatewayCronController = {
  createTask(input: CronCreateInput): Promise<CronCreateResult>;
  listTasks(input: CronListInput): Promise<CronListResult>;
  deleteTask(input: CronDeleteInput): Promise<CronDeleteResult>;
  stopTask(input: CronStopInput): Promise<CronStopResult>;
};

export interface Gateway {
  submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent>;
  abortTurn(input: { sessionKey: string; runId?: string }): Promise<void>;
  listSessions(input: ListSessionsInput): Promise<ListSessionsResult>;
  resumeSession(input: { sessionKey: string }): Promise<{ sessionKey: string }>;
  newSession(input: NewSessionInput): Promise<{ sessionKey: string }>;
  closeSession(input: { sessionKey: string; reason?: string }): Promise<void>;
  describeServer(): Promise<GatewayServerInfo>;
  cronCreate(input: CronCreateInput): Promise<CronCreateResult>;
  cronList(input: CronListInput): Promise<CronListResult>;
  cronDelete(input: CronDeleteInput): Promise<CronDeleteResult>;
  cronStop(input: CronStopInput): Promise<CronStopResult>;
}
