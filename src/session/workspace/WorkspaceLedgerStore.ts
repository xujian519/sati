/**
 * WorkspaceLedgerStore — per-session provider for reading and writing the ledger.
 *
 * The transcript is the single source of truth. `read()` re-derives the latest
 * ledger from the transcript; `write()` persists a `workspace_state` entry
 * through the transcript writer. Because the ledger is re-read from the
 * transcript rather than from message history, it survives compaction.
 *
 * The read is incremental: the transcript reader returns element-shared arrays,
 * so a scan cursor anchored on the last entry it covered lets successive reads
 * walk only the entries appended since — O(1) on the common path where nothing
 * changed (TD-SESSION-N01 / #344).
 *
 * The read is also *honest about failure*. `readTranscript` reports an
 * unreadable transcript (over `DEFAULT_MAX_TRANSCRIPT_READ_BYTES`, unparseable
 * lines) through `diagnostics` rather than by throwing; those are surfaced once
 * per distinct diagnostic, and an error-severity diagnostic makes `read()` return
 * `status: "unavailable"` instead of quietly serving the in-memory state. The
 * distinction matters to callers: "the ledger was never written" and "the ledger
 * could not be read" look identical when both render as an absent
 * `<workspace-state>` block, but only the second one means writing a note would
 * drop the existing ledger (TD-WORKSPACE-N02 / #364).
 */
import type { AgentTranscriptDiagnostic } from "../transcript/TranscriptEntry.js";
import type { AgentTranscriptWriter } from "../transcript/TranscriptWriter.js";
import { readTranscript } from "../transcript/TranscriptReader.js";
import { createLogger } from "../../telemetry/index.js";
import { scanLatestWorkspaceState, type WorkspaceStateScanCursor } from "./WorkspaceLedgerReader.js";
import { cloneWorkspaceLedgerState, type WorkspaceLedgerState } from "./WorkspaceLedger.js";

/**
 * Outcome of a ledger read. `ok` means the transcript is authoritative and the
 * ledger layer got a straight answer out of it (which may legitimately be "no
 * ledger yet"); `unavailable` means the transcript could not be read, so there
 * is no authoritative answer and the callers must not treat the ledger as empty.
 */
export type WorkspaceLedgerReadResult =
  | { status: "ok"; state: WorkspaceLedgerState | undefined }
  | { status: "unavailable"; code: AgentTranscriptDiagnostic["code"]; message: string };

/** Provider surface shared by the agent loop and the workspace tools. */
export type SatiWorkspaceLedgerProvider = {
  read(): Promise<WorkspaceLedgerReadResult>;
  write(state: WorkspaceLedgerState, ctx: { sessionId: string; turnId: string }): Promise<void>;
};

const ledgerLogger = createLogger("session");

export class WorkspaceLedgerStore implements SatiWorkspaceLedgerProvider {
  private readonly path: string | undefined;
  /** In-memory fallback used when there is no transcript path (in-memory writer). */
  private latest: WorkspaceLedgerState | undefined;
  /** Resume cursor of the previous transcript scan (invalidated by any read failure). */
  private cursor: WorkspaceStateScanCursor | undefined;
  /** Diagnostic keys already reported, so a per-turn read does not log every turn. */
  private readonly reported = new Set<string>();

  constructor(
    private readonly transcript: AgentTranscriptWriter,
    private readonly sessionId: string,
    transcriptPath?: string,
  ) {
    this.path = transcriptPath && transcriptPath.length > 0 ? transcriptPath : undefined;
  }

  async read(): Promise<WorkspaceLedgerReadResult> {
    if (this.path === undefined) {
      // 无 transcript 路径（内存 writer）：账本只存在于本进程。
      return { status: "ok", state: this.latest };
    }
    const { entries, diagnostics } = await readTranscript(this.path);
    this.report(diagnostics);
    const failure = diagnostics.find(diagnostic => diagnostic.severity === "error");
    if (failure !== undefined) {
      // 读不到 transcript ⇒ 没有权威账本。刻意**不**回退 this.latest：陈旧内存态
      // 冒充 transcript 真值与「transcript 是唯一事实源」的契约直接背离，而且会
      // 让调用方（workspace_note）基于过期基座写回、丢掉既有账本。
      this.cursor = undefined;
      return { status: "unavailable", code: failure.code, message: failure.message };
    }
    const scan = scanLatestWorkspaceState(entries, this.cursor);
    this.cursor = scan.cursor;
    const authoritative = scan.state;
    if (authoritative !== undefined) {
      this.latest = authoritative;
    }
    // 内存态仅在 transcript 中确实没有账本条目时兜底：路径已声明但 writer 并不
    // 落盘的会话（如 InMemoryTranscriptWriter + storage.transcriptPath）。
    const state = authoritative ?? this.latest;
    return { status: "ok", state: state === undefined ? undefined : cloneWorkspaceLedgerState(state) };
  }

  async write(state: WorkspaceLedgerState, ctx: { sessionId: string; turnId: string }): Promise<void> {
    if (this.transcript.recordWorkspaceState !== undefined) {
      await this.transcript.recordWorkspaceState(ctx.sessionId ?? this.sessionId, ctx.turnId, state);
    }
    this.latest = state;
  }

  /**
   * Report each distinct diagnostic once. The ledger is read before every model
   * call, so an unreported per-read diagnostic would log every turn; the key
   * keeps repeats of the same line-level problem silent while still letting a
   * *new* one through.
   */
  private report(diagnostics: readonly AgentTranscriptDiagnostic[]): void {
    for (const diagnostic of diagnostics) {
      const key = `${diagnostic.code}:${diagnostic.line ?? ""}`;
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      const message = `workspace ledger: transcript diagnostic [${diagnostic.code}] ${diagnostic.message}`;
      if (diagnostic.severity === "error") {
        ledgerLogger.error(message);
      } else {
        ledgerLogger.warn(message);
      }
    }
  }
}
