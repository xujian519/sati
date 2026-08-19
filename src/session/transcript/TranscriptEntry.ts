import type { CanonicalMessage } from "../../model/index.js";
import type { RetrySchedule } from "../../model/streaming/retryState.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import type { InjectionRecord } from "../../context/protocol/types.js";
import type { FileArtifact } from "../artifacts/FileArtifact.js";

export type AgentTranscriptEntryType =
  | "accepted_input"
  | "assistant_message"
  | "tool_result_message"
  | "durable_message"
  | "agent_status_message"
  | "file_artifacts"
  | "turn_result"
  | "control_boundary"
  | "session_metadata"
  | "subagent_started"
  | "subagent_completed"
  | "injected_context"
  | "request_header"
  | "retry_schedule";

export type AgentTranscriptEntryBase = {
  type: AgentTranscriptEntryType;
  sessionId: string;
  turnId: string;
  sequence: number;
  createdAt: string;
  entryId?: string;
  parentEntryId?: string | null;
};

export type AgentAcceptedInputTranscriptEntry = AgentTranscriptEntryBase & {
  type: "accepted_input";
  messages: CanonicalMessage[];
  metadata?: Record<string, unknown>;
};

export type AgentMessageTranscriptEntry = AgentTranscriptEntryBase & {
  type: "assistant_message" | "tool_result_message" | "durable_message";
  message: CanonicalMessage;
};

export type AgentStatusMessageTranscriptEntry = AgentTranscriptEntryBase & {
  type: "agent_status_message";
  event: string;
  kind: "status" | "error";
  text: string;
  detail?: Record<string, unknown>;
};

export type AgentTurnResultTranscriptEntry = AgentTranscriptEntryBase & {
  type: "turn_result";
  result: AgentTurnResult;
};

export type AgentFileArtifactsTranscriptEntry = AgentTranscriptEntryBase & {
  type: "file_artifacts";
  artifacts: FileArtifact[];
};

export type CompactBoundaryMetadata = {
  /** Stable identity shared by live and persisted representations. */
  compactionId?: string;
  trigger: "manual" | "auto" | "reactive";
  preTokens: number;
  postTokens?: number;
  /** Number of messages summarized into the boundary's summary section. */
  messagesSummarized?: number;
  /** Logical parent uuid before compact (for resume relink). */
  logicalParentUuid?: string;
  /** Optional verbatim segment that was preserved across the boundary. */
  preservedSegment?: {
    fromIndex: number;
    toIndex: number;
  };
  /**
   * 被遮蔽（摘要替代）消息的索引范围（含端，压缩输入 messages 序列）。
   * 压缩不删历史——transcript 原文仍完整保留；重放可据此恢复被摘要
   * 替代的完整原文（对应 dsh surface replace 语义：遮蔽可逆）。
   */
  shadowedRanges?: Array<{
    fromIndex: number;
    toIndex: number;
  }>;
  /**
   * Tools that were available before compact; used by replay to detect missing
   * tool references after compact.
   */
  preCompactDiscoveredTools?: string[];
  /** Free-form additional metadata. */
  extra?: Record<string, unknown>;
};

export type MicroCompactBoundaryMetadata = {
  trigger: "time_based" | "cached";
  toolCallIds: string[];
  rewrittenBytes?: number;
};

export type AgentControlBoundaryTranscriptEntry = AgentTranscriptEntryBase & {
  type: "control_boundary";
  boundary:
    | {
        kind: "compact";
        subtype: "compact_boundary";
        compactMetadata: CompactBoundaryMetadata;
      }
    | {
        kind: "compact";
        subtype: "microcompact_boundary";
        microCompactMetadata: MicroCompactBoundaryMetadata;
      }
    | {
        kind: "resume" | "manual";
        metadata?: Record<string, unknown>;
      };
};

export type SessionMetadataValue = {
  /** Marks a metadata entry written by `reappendTail()` as a full snapshot. */
  isSnapshot?: true;
  title?: string;
  aiTitle?: string;
  tag?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  gitBranch?: string;
  mode?: "normal" | "coordinator";
  linkedPullRequest?: {
    number: number;
    url: string;
    repository: string;
  };
  /** Parent session when this transcript was created via history fork. */
  parentSessionId?: string;
  /** Turn id of the fork point in the parent session. */
  forkedFromTurnId?: string;
  updatedAt?: string;
};

export type AgentSessionMetadataTranscriptEntry = AgentTranscriptEntryBase & {
  type: "session_metadata";
  metadata: SessionMetadataValue;
};

/**
 * Soft caps for sidechain reference fields. The full directive / final report
 * lives in the sidechain transcript; the parent records only a truncated
 * preview so the parent transcript stays bounded.
 */
export const SUBAGENT_PROMPT_PREVIEW_BYTES = 1024;
export const SUBAGENT_SUMMARY_PREVIEW_BYTES = 4 * 1024;

export type AgentSubagentStartedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "subagent_started";
  /** UUID v4 of the forked subagent (matches sidechain filename). */
  subagentId: string;
  /** Definition id (`general-purpose` / `explore` / `plan`). */
  subagentType: string;
  /**
   * Truncated parent directive — capped at {@link SUBAGENT_PROMPT_PREVIEW_BYTES}
   * to keep main-transcript size bounded. Full directive is the first user
   * message in the sidechain.
   */
  promptPreview: string;
  /** Whether {@link promptPreview} is truncated. */
  promptTruncated: boolean;
  /** Relative path (from session dir) of the sidechain transcript. */
  transcriptRelativePath: string;
  /** Optional sub-session id if the SubAgentSession namespaces sessions. */
  subagentSessionId?: string;
};

export type AgentSubagentCompletedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "subagent_completed";
  subagentId: string;
  subagentType: string;
  /** Truncated final assistant report. */
  summaryPreview: string;
  /** Whether {@link summaryPreview} is truncated. */
  summaryTruncated: boolean;
  /** Aggregate usage from the AgentLoop run. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
  };
  /** Number of internal turns the subagent took. */
  turns: number;
  durationMs: number;
  /** True when the run errored (subagent emitted an error result). */
  errored?: boolean;
};

/**
 * 注入内容参考条目（对应 dsh「模型可见 = 已记录」）：记忆/项目指令/记忆工具
 * 提示/方法论等动态注入到 system prompt 的段落原文。仅供审计/回放查询——
 * 重放投影时不进入模型可见 messages（避免注入内容被当作真实用户消息）。
 */
export type AgentInjectedContextTranscriptEntry = AgentTranscriptEntryBase & {
  type: "injected_context";
} & InjectionRecord;

/**
 * 发送前请求头快照（阶段四 T2）：每次 LLM 请求的路由决策、输出上限与
 * system/tools 摘要。请求由这些决策唯一决定，审计与重建对拍据此验证
 * 「发给模型的内容可从 transcript 重建」。
 */
export type AgentRequestHeaderSnapshot = {
  /** 路由决定的 provider（实际发送目标）。 */
  provider: string;
  /** 路由决定的 model（实际发送目标）。 */
  model: string;
  /** 发送时的输出上限（路由后 clamp 值）。 */
  maxOutputTokens?: number;
  /** system prompt 的 sha256 摘要（不含 raw/元数据）。 */
  systemPromptDigest: string;
  /** 工具 schema 的 sha256 摘要（名称 + inputSchema，不含 raw）。 */
  toolSchemaDigest: string;
  /** 请求消息条数（辅助重建对齐诊断）。 */
  messageCount: number;
};

/**
 * request/header 参考条目（log-only）：仅供审计与重建对拍，重放投影时
 * 不进入模型可见 messages（对应 dsh「模型可见 = 已记录」的请求侧）。
 */
export type AgentRequestHeaderTranscriptEntry = AgentTranscriptEntryBase & {
  type: "request_header";
  header: AgentRequestHeaderSnapshot;
};

/**
 * 重试调度参考条目（阶段四 T4.2 后续 / 跨进程重启续算 T-A）：进程内重试决策的
 * log-only 落盘。仅供审计与跨进程恢复（扫描器按 retryId/policyKey 定位续算点），
 * 重放投影时不进入模型可见消息、不驱动 turn 判定（不进 ACTIVITY_ENTRY_TYPES）。
 */
export type AgentRetryScheduleTranscriptEntry = AgentTranscriptEntryBase & {
  type: "retry_schedule";
  schedule: RetrySchedule;
};

export type AgentTranscriptEntry =
  | AgentAcceptedInputTranscriptEntry
  | AgentMessageTranscriptEntry
  | AgentStatusMessageTranscriptEntry
  | AgentFileArtifactsTranscriptEntry
  | AgentTurnResultTranscriptEntry
  | AgentControlBoundaryTranscriptEntry
  | AgentSessionMetadataTranscriptEntry
  | AgentSubagentStartedTranscriptEntry
  | AgentSubagentCompletedTranscriptEntry
  | AgentInjectedContextTranscriptEntry
  | AgentRequestHeaderTranscriptEntry
  | AgentRetryScheduleTranscriptEntry;

export function truncatePreview(input: string, byteCap: number): { preview: string; truncated: boolean } {
  const total = Buffer.byteLength(input, "utf8");
  if (total <= byteCap) return { preview: input, truncated: false };
  // Walk codepoint-by-codepoint so we never cut inside a UTF-8 sequence.
  let bytes = 0;
  let out = "";
  for (const ch of input) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (bytes + chBytes > byteCap) break;
    bytes += chBytes;
    out += ch;
  }
  return { preview: out, truncated: true };
}

export type AgentTranscriptDiagnostic = {
  code:
    | "transcript_missing"
    | "transcript_too_large"
    | "transcript_line_invalid"
    | "transcript_entry_invalid"
    | "shadowed_message_alignment";
  severity: "warning" | "error";
  message: string;
  line?: number;
};

export function classifyDurableMessageEntry(message: CanonicalMessage): AgentMessageTranscriptEntry["type"] {
  if (message.role === "assistant") {
    return "assistant_message";
  }

  if (message.content.some(block => block.type === "tool_result")) {
    return "tool_result_message";
  }

  return "durable_message";
}

/**
 * 窄化 control_boundary 条目到 compact_boundary 分支（同时收窄
 * compactMetadata）。此前该 4 连判定在 TranscriptReplay / readSessionMessages
 * 中逐字重复 4 处，改一处漏三处。
 */
export function isCompactBoundaryEntry(entry: AgentTranscriptEntry): entry is AgentTranscriptEntry & {
  type: "control_boundary";
  boundary: { kind: "compact"; subtype: "compact_boundary"; compactMetadata: CompactBoundaryMetadata };
} {
  return (
    entry.type === "control_boundary" &&
    entry.boundary.kind === "compact" &&
    "subtype" in entry.boundary &&
    entry.boundary.subtype === "compact_boundary"
  );
}
