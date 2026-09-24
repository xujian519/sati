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
import { cloneWorkspaceLedgerState, type WorkspaceLedgerState, type WorkspaceNoteInput } from "./WorkspaceLedger.js";

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
  /**
   * Persist the ledger after an accepted edit. `ctx.note` is the edit that
   * produced `state`; when present (and the writer supports deltas) the store
   * may persist it as a compact `workspace_state_delta` instead of a full
   * snapshot. Omit `note` to force a full self-sufficient anchor (#537).
   */
  write(
    state: WorkspaceLedgerState,
    ctx: { sessionId: string; turnId: string; note?: WorkspaceNoteInput },
  ): Promise<void>;
};

const ledgerLogger = createLogger("session");

/**
 * Write a full self-sufficient `workspace_state` anchor at least this often
 * (#537). Between anchors only the accepted note is persisted as a
 * `workspace_state_delta`, so a session that appends N checkpoints costs
 * ~N/K full snapshots + N O(1) deltas instead of N full snapshots — turning the
 * O(n²) transcript growth that hit the 50MB cap into ~O(n²/K). K bounds how many
 * deltas a cold read replays; 32 keeps that replay trivial while cutting anchor
 * bytes ~32×.
 */
export const WORKSPACE_LEDGER_ANCHOR_INTERVAL = 32;

export class WorkspaceLedgerStore implements SatiWorkspaceLedgerProvider {
  private readonly path: string | undefined;
  /** In-memory fallback used when there is no transcript path (in-memory writer). */
  private latest: WorkspaceLedgerState | undefined;
  /** Resume cursor of the previous transcript scan (invalidated by any read failure). */
  private cursor: WorkspaceStateScanCursor | undefined;
  /** Deltas persisted since the last anchor; refreshed from every scan (#537). */
  private sinceAnchor = 0;
  /**
   * True once a reconstructable ledger exists (an anchor is on disk or in
   * memory). Gates the first write to a full anchor: a delta with no anchor to
   * replay from is unreconstructable, so the ledger must open with a snapshot.
   */
  private haveBase = false;
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
    // Refresh the anchor cadence from the transcript itself, so the interval is
    // global (survives resume) and a cold read never replays more than K deltas.
    this.sinceAnchor = scan.deltasSinceAnchor;
    const authoritative = scan.state;
    if (authoritative !== undefined) {
      this.latest = authoritative;
      this.haveBase = true;
    }
    // 内存态仅在 transcript 中确实没有账本条目时兜底：路径已声明但 writer 并不
    // 落盘的会话（如 InMemoryTranscriptWriter + storage.transcriptPath）。
    const state = authoritative ?? this.latest;
    return { status: "ok", state: state === undefined ? undefined : cloneWorkspaceLedgerState(state) };
  }

  async write(
    state: WorkspaceLedgerState,
    ctx: { sessionId: string; turnId: string; note?: WorkspaceNoteInput },
  ): Promise<void> {
    const sessionId = ctx.sessionId ?? this.sessionId;
    const note = ctx.note;
    // 增量优先：仅当（a）调用方交回了产生该 state 的 note、（b）已存在可重放的
    // 锚点基座、（c）距上个锚点未满 K 笔、（d）writer 支持增量时，才落 O(1) 增量；
    // 否则落全量自足锚点（首笔写入 / 每 K 笔 / 内存 writer 不支持增量时的兜底）。
    if (
      note !== undefined &&
      this.haveBase &&
      this.sinceAnchor < WORKSPACE_LEDGER_ANCHOR_INTERVAL &&
      this.transcript.recordWorkspaceStateDelta !== undefined
    ) {
      await this.transcript.recordWorkspaceStateDelta(sessionId, ctx.turnId, note);
      this.sinceAnchor += 1;
    } else if (this.transcript.recordWorkspaceState !== undefined) {
      await this.transcript.recordWorkspaceState(sessionId, ctx.turnId, state);
      this.sinceAnchor = 0;
      this.haveBase = true;
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
