import { randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import type { InjectionRecord } from "../../context/protocol/types.js";
import type { FileArtifact } from "../artifacts/FileArtifact.js";
import {
  classifyDurableMessageEntry,
  truncatePreview,
  SUBAGENT_PROMPT_PREVIEW_BYTES,
  SUBAGENT_SUMMARY_PREVIEW_BYTES,
  type AgentControlBoundaryTranscriptEntry,
  type AgentMessageTranscriptEntry,
  type AgentRequestHeaderSnapshot,
  type AgentSubagentCompletedTranscriptEntry,
  type AgentSubagentStartedTranscriptEntry,
  type AgentTranscriptEntry,
  type SessionMetadataValue,
} from "./TranscriptEntry.js";
import type { AgentTranscriptWriter, AgentTranscriptWriterState } from "./TranscriptWriter.js";

export type SubagentTranscriptHandle = {
  /** UUID v4 of the subagent (matches sidechain filename). */
  subagentId: string;
  /** The sidechain writer (independent JSONL file). */
  writer: JsonlTranscriptWriter;
  /** Absolute path of the sidechain transcript. */
  transcriptPath: string;
};

export type JsonlTranscriptWriterOptions = {
  path: string;
  now?: () => Date;
  /**
   * Optional resolver mapping a subagentId → absolute sidechain path. Wired
   * by the parent session so {@link JsonlTranscriptWriter#forSubagent} can
   * derive a sidechain writer without the caller computing paths. Defaults
   * to `<dirname(path)>/<subagentId>.jsonl`.
   */
  subagentTranscriptPath?: (subagentId: string) => string;
  /**
   * M3 写缓冲：pending 序列化行字节数达到该阈值即落盘（默认 64KB）。
   * 0 = 直写（每次 recordEntry 立即落盘，旧行为回滚）。可用环境变量
   * SATI_TRANSCRIPT_FLUSH_THRESHOLD_BYTES 覆盖（显式传参优先）。
   */
  flushThresholdBytes?: number;
  /** 缓冲兜底定时器间隔（默认 50ms）：无显式 flushCheckpoint 时自动落盘。 */
  flushIntervalMs?: number;
};

const DEFAULT_FLUSH_THRESHOLD_BYTES = 64 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 50;

export class JsonlTranscriptWriter implements AgentTranscriptWriter {
  private sequence = 0;
  private lastEntryId: string | null = null;
  private readonly now: () => Date;
  private readonly flushThresholdBytes: number;
  private readonly flushIntervalMs: number;
  /** 目录是否已确认存在（mkdir recursive 每次 syscall，仅首次需要）。 */
  private dirReady = false;

  /** M3 写缓冲：已接受但未落盘的序列化行（顺序 = 入队顺序）。 */
  private pendingLines: string[] = [];
  private pendingBytes = 0;
  /** 与 pendingLines 一一对应的条目落盘 ack（resolve/reject 由所在批次写入完成时触发）。 */
  private pendingAcks: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  /** 写入串行链：批次按入队顺序落盘；链保持可继续（批次错误经 ack/lastFlushError 传播）。 */
  private writeChain: Promise<void> = Promise.resolve();
  /** 是否有 flush 批次在途（防重入；链上残留由 flushPending 的 finally 兜底）。 */
  private flushing = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** 最近一次落盘失败（flushCheckpoint 边界传播一次后清除；条目级错误经 ack 传播）。 */
  private lastFlushError: unknown;

  constructor(private readonly options: JsonlTranscriptWriterOptions) {
    this.now = options.now ?? (() => new Date());
    const envThreshold = Number.parseInt(process.env.SATI_TRANSCRIPT_FLUSH_THRESHOLD_BYTES ?? "", 10);
    const threshold =
      options.flushThresholdBytes ?? (Number.isFinite(envThreshold) ? envThreshold : DEFAULT_FLUSH_THRESHOLD_BYTES);
    this.flushThresholdBytes = threshold >= 0 ? threshold : 0;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  /** 实际落盘的 transcript 文件路径（供投影器等读取方绑定真实 writer）。 */
  get path(): string {
    return this.options.path;
  }

  /**
   * Re-seed the writer's monotonic counters from a previously persisted
   * transcript so that new entries continue with unique, ascending values.
   * Called by the resume path after `readTranscript` has loaded the
   * existing entries.
   */
  restoreState(maxSequence: number, lastEntryId: string | null): void {
    this.sequence = maxSequence;
    this.lastEntryId = lastEntryId;
  }

  snapshotState(): AgentTranscriptWriterState {
    return {
      sequence: this.sequence,
      lastEntryId: this.lastEntryId,
    };
  }

  /**
   * 阶段四 T4.1 durable 边界检查点（M3 后为真 flush）：确保此前已接受的
   * 全部条目落盘。TurnRunner 在每组工具副作用前 await（fail-closed：
   * 落盘失败 → 错误传播给该调用方，工具不执行）。幂等，可安全重复调用。
   */
  flushCheckpoint(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flushPending();
    return this.writeChain.then(() => {
      // 边界级错误传播（fail-closed：TurnRunner 在工具副作用前 await 时可见）。
      // 传播一次后清除——后续 flushCheckpoint 恢复正常，不重复报旧错。
      if (this.lastFlushError !== undefined) {
        const error = this.lastFlushError;
        this.lastFlushError = undefined;
        throw error;
      }
    });
  }

  recordAcceptedInput(
    sessionId: string,
    turnId: string,
    messages: CanonicalMessage[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return this.recordEntry({
      type: "accepted_input",
      ...this.baseEntry(sessionId, turnId),
      messages,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): Promise<void> {
    const type: AgentMessageTranscriptEntry["type"] = classifyDurableMessageEntry(message);
    return this.recordEntry({
      type,
      ...this.baseEntry(sessionId, turnId),
      message,
    });
  }

  recordAgentStatusMessage(
    sessionId: string,
    turnId: string,
    status: { event: string; kind: "status" | "error"; text: string; detail?: Record<string, unknown> },
  ): Promise<void> {
    return this.recordEntry({
      type: "agent_status_message",
      ...this.baseEntry(sessionId, turnId),
      event: status.event,
      kind: status.kind,
      text: status.text,
      ...(status.detail && Object.keys(status.detail).length > 0 ? { detail: status.detail } : {}),
    });
  }

  recordFileArtifacts(sessionId: string, turnId: string, artifacts: FileArtifact[]): Promise<void> {
    if (artifacts.length === 0) return Promise.resolve();
    return this.recordEntry({
      type: "file_artifacts",
      ...this.baseEntry(sessionId, turnId),
      artifacts,
    });
  }

  recordTurnResult(sessionId: string, turnId: string, result: AgentTurnResult): Promise<void> {
    return this.recordEntry({
      type: "turn_result",
      ...this.baseEntry(sessionId, turnId),
      result,
    });
  }

  recordSessionMetadata(sessionId: string, turnId: string, metadata: SessionMetadataValue): Promise<void> {
    return this.recordEntry({
      type: "session_metadata",
      ...this.baseEntry(sessionId, turnId),
      metadata,
    });
  }

  recordInjectedContext(sessionId: string, turnId: string, injection: InjectionRecord): Promise<void> {
    return this.recordEntry({
      type: "injected_context",
      ...this.baseEntry(sessionId, turnId),
      source: injection.source,
      text: injection.text,
      ...(injection.partIndex !== undefined ? { partIndex: injection.partIndex } : {}),
    });
  }

  recordRequestHeader(sessionId: string, turnId: string, header: AgentRequestHeaderSnapshot): Promise<void> {
    return this.recordEntry({
      type: "request_header",
      ...this.baseEntry(sessionId, turnId),
      header,
    });
  }

  recordRetrySchedule(
    sessionId: string,
    turnId: string,
    schedule: import("../../model/streaming/retryState.js").RetrySchedule,
  ): Promise<void> {
    return this.recordEntry({
      type: "retry_schedule",
      ...this.baseEntry(sessionId, turnId),
      schedule,
    });
  }

  recordControlBoundary(
    sessionId: string,
    turnId: string,
    boundary: AgentControlBoundaryTranscriptEntry["boundary"],
  ): Promise<void> {
    return this.recordEntry({
      type: "control_boundary",
      ...this.baseEntry(sessionId, turnId),
      boundary,
    });
  }

  /**
   * M3 写缓冲：条目序列化后入队（不立即落盘）。落盘时机：
   *  - 显式 flushCheckpoint()（durable 边界，TurnRunner 每组工具副作用前 await）；
   *  - turn_result（resume 完整性：跨进程续算依赖 turn_result 权威标志，连同
   *    其前全部 pending 消息一次落盘）；
   *  - pending 字节 ≥ flushThresholdBytes（64KB 默认）；
   *  - flushIntervalMs 兜底定时器（50ms）。
   * 返回 promise 语义：该条目（含其前条目，同一批次一次 appendFile）已落盘时
   * resolve；落盘失败 reject（错误传播，fail-closed 与旧行为一致）。
   */
  recordEntry(entry: AgentTranscriptEntry): Promise<void> {
    this.sequence = Math.max(this.sequence, entry.sequence);
    this.lastEntryId = entry.entryId ?? this.lastEntryId;
    const line = `${JSON.stringify(entry)}\n`;
    this.pendingLines.push(line);
    this.pendingBytes += line.length;
    // ack 必须先于 flush 入队：flushPending 会 splice 当前 pendingAcks，
    // 若在其后入队，该条目的 promise 将无人 resolve（永久挂起）。
    const ackPromise = new Promise<void>((resolve, reject) => {
      this.pendingAcks.push({ resolve, reject });
    });

    if (this.flushThresholdBytes === 0) {
      // 回滚（SATI_TRANSCRIPT_FLUSH_THRESHOLD_BYTES=0）：每条立即落盘（旧行为）。
      this.flushPending();
    } else if (entry.type === "turn_result") {
      this.flushPending();
    } else if (this.pendingBytes >= this.flushThresholdBytes) {
      this.flushPending();
    } else {
      this.scheduleFlushTimer();
    }
    return ackPromise;
  }

  /** 调度一个批次落盘（不 await）。批次 = 当前全部 pending 行，一次 appendFile。 */
  private flushPending(): void {
    if (this.flushing) return; // 在途批次完成后由其 finally 兜底处理新 pending
    const lines = this.pendingLines.splice(0);
    const acks = this.pendingAcks.splice(0);
    this.pendingBytes = 0;
    if (lines.length === 0) return;
    this.flushing = true;
    this.writeChain = this.writeChain
      .then(async () => {
        if (!this.dirReady) {
          await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
          this.dirReady = true;
        }
        try {
          await appendFile(this.options.path, lines.join(""), { encoding: "utf8", mode: 0o600 });
        } catch (error) {
          // 目录可能被外部删除/移动：重置 dirReady 以便下次写入自愈（重新 mkdir）
          this.dirReady = false;
          throw error;
        }
      })
      .then(
        () => {
          for (const ack of acks) ack.resolve();
        },
        (error: unknown) => {
          // 错误传播：本批次条目 reject（调用方 await recordEntry 可见，
          // fail-closed）；链不 rethrow（保持可继续）——dirReady 已重置，
          // 后续批次经自愈重新 mkdir 后恢复写入。
          this.lastFlushError = error;
          for (const ack of acks) ack.reject(error);
        },
      )
      .finally(() => {
        this.flushing = false;
        this.flushPending(); // 链上残留（错误跳过或 flush 期间新入队）继续
      });
  }

  private scheduleFlushTimer(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushPending();
    }, this.flushIntervalMs);
    // unref：不阻止进程退出（turn 边界必有 turn_result 强制 flush，此处仅兜底）。
    this.flushTimer.unref?.();
  }

  /**
   * C3.S1 — record the parent-side `subagent_started` reference. The full
   * directive lives in the sidechain transcript; we keep only a truncated
   * preview to bound the parent transcript size.
   */
  async recordSubagentStarted(
    sessionId: string,
    turnId: string,
    args: {
      subagentId: string;
      subagentType: string;
      prompt: string;
      transcriptRelativePath: string;
      subagentSessionId?: string;
    },
  ): Promise<void> {
    const { preview, truncated } = truncatePreview(args.prompt, SUBAGENT_PROMPT_PREVIEW_BYTES);
    const entry: AgentSubagentStartedTranscriptEntry = {
      type: "subagent_started",
      ...this.baseEntry(sessionId, turnId),
      subagentId: args.subagentId,
      subagentType: args.subagentType,
      promptPreview: preview,
      promptTruncated: truncated,
      transcriptRelativePath: args.transcriptRelativePath,
      subagentSessionId: args.subagentSessionId,
    };
    return this.recordEntry(entry);
  }

  /** C3.S1 — record the parent-side `subagent_completed` reference. */
  async recordSubagentCompleted(
    sessionId: string,
    turnId: string,
    args: {
      subagentId: string;
      subagentType: string;
      summary: string;
      usage?: AgentSubagentCompletedTranscriptEntry["usage"];
      turns: number;
      durationMs: number;
      errored?: boolean;
    },
  ): Promise<void> {
    const { preview, truncated } = truncatePreview(args.summary, SUBAGENT_SUMMARY_PREVIEW_BYTES);
    const entry: AgentSubagentCompletedTranscriptEntry = {
      type: "subagent_completed",
      ...this.baseEntry(sessionId, turnId),
      subagentId: args.subagentId,
      subagentType: args.subagentType,
      summaryPreview: preview,
      summaryTruncated: truncated,
      usage: args.usage,
      turns: args.turns,
      durationMs: args.durationMs,
      errored: args.errored,
    };
    return this.recordEntry(entry);
  }

  /**
   * C3.S2 — derive a sidechain writer for a forked subagent. The new writer
   * is independent (its own sequence counter, its own file path) so the
   * subagent's turn-by-turn entries do not interleave with the parent.
   */
  forSubagent(subagentId: string, now?: () => Date): SubagentTranscriptHandle {
    const path =
      this.options.subagentTranscriptPath?.(subagentId) ?? defaultSubagentPath(this.options.path, subagentId);
    const writer = new JsonlTranscriptWriter({
      path,
      now: now ?? this.now,
      flushThresholdBytes: this.flushThresholdBytes,
      flushIntervalMs: this.flushIntervalMs,
    });
    return { subagentId, writer, transcriptPath: path };
  }

  /**
   * Helper for emitting the relative path to the sidechain that goes into
   * `subagent_started.transcriptRelativePath`. Computed against the parent
   * transcript's directory.
   */
  relativeSubagentPath(subagentId: string): string {
    const sidechain =
      this.options.subagentTranscriptPath?.(subagentId) ?? defaultSubagentPath(this.options.path, subagentId);
    return relative(dirname(this.options.path), sidechain);
  }

  private baseEntry(
    sessionId: string,
    turnId: string,
  ): Pick<AgentTranscriptEntry, "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"> {
    return {
      sessionId,
      turnId,
      sequence: ++this.sequence,
      createdAt: this.now().toISOString(),
      entryId: randomUUID(),
      parentEntryId: this.lastEntryId,
    };
  }
}

function defaultSubagentPath(parentPath: string, subagentId: string): string {
  // Default layout: <parentPath dirname>/<parentBaseStem>/subagents/<subagentId>.jsonl
  const dir = dirname(parentPath);
  const stem = basename(parentPath).replace(/\.jsonl$/i, "");
  return join(dir, stem, "subagents", `${subagentId}.jsonl`);
}
