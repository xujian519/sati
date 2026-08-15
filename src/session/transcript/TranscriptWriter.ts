import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import type { InjectionRecord } from "../../context/protocol/types.js";
import type { FileArtifact } from "../artifacts/FileArtifact.js";
import type {
  AgentControlBoundaryTranscriptEntry,
  AgentRequestHeaderSnapshot,
  AgentStatusMessageTranscriptEntry,
  AgentTranscriptEntry,
  SessionMetadataValue,
} from "./TranscriptEntry.js";

export type AgentStatusMessageInput = Pick<AgentStatusMessageTranscriptEntry, "event" | "kind" | "text" | "detail">;

export type AgentTranscriptWriterState = {
  sequence: number;
  lastEntryId: string | null;
};

export type AgentTranscriptWriter = {
  recordAcceptedInput(
    sessionId: string,
    turnId: string,
    messages: CanonicalMessage[],
    metadata?: Record<string, unknown>,
  ): void | Promise<void>;
  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): void | Promise<void>;
  recordAgentStatusMessage?(sessionId: string, turnId: string, status: AgentStatusMessageInput): void | Promise<void>;
  recordFileArtifacts?(sessionId: string, turnId: string, artifacts: FileArtifact[]): void | Promise<void>;
  recordTurnResult(sessionId: string, turnId: string, result: AgentTurnResult): void | Promise<void>;
  recordSessionMetadata?(sessionId: string, turnId: string, metadata: SessionMetadataValue): void | Promise<void>;
  recordControlBoundary?(
    sessionId: string,
    turnId: string,
    boundary: AgentControlBoundaryTranscriptEntry["boundary"],
  ): void | Promise<void>;
  /** 注入内容参考条目（模型实际看到的记忆/指令/方法论段落原文，不进入重放投影）。 */
  recordInjectedContext?(sessionId: string, turnId: string, injection: InjectionRecord): void | Promise<void>;
  /** 发送前请求头快照（阶段四 T2，log-only，不进入重放投影）。 */
  recordRequestHeader?(sessionId: string, turnId: string, header: AgentRequestHeaderSnapshot): void | Promise<void>;
  /** 重试调度参考（跨进程重启续算 T-A，log-only，不进入重放投影）。 */
  recordRetrySchedule?(
    sessionId: string,
    turnId: string,
    schedule: import("../../model/streaming/retryState.js").RetrySchedule,
  ): void | Promise<void>;
  /** durable 边界检查点（阶段四 T4.1）：确保此前全部条目已落盘。无缓冲写入的实现为 no-op。 */
  flushCheckpoint?(): void | Promise<void>;
  recordEntry?(entry: AgentTranscriptEntry): void | Promise<void>;
  snapshotState?(): AgentTranscriptWriterState;
};
