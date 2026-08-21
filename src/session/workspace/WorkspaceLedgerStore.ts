/**
 * WorkspaceLedgerStore — per-session provider for reading and writing the ledger.
 *
 * The transcript is the single source of truth. `read()` re-derives the latest
 * ledger from the transcript (cheap via the tail-append cache); `write()`
 * persists a `workspace_state` entry through the transcript writer. Because the
 * ledger is re-read from the transcript rather than from message history, it
 * survives compaction.
 */
import type { AgentTranscriptWriter } from "../transcript/TranscriptWriter.js";
import { readTranscript } from "../transcript/TranscriptReader.js";
import { readLatestWorkspaceState } from "./WorkspaceLedgerReader.js";
import type { WorkspaceLedgerState } from "./WorkspaceLedger.js";

/** Provider surface shared by the agent loop and the workspace tools. */
export type SatiWorkspaceLedgerProvider = {
  read(): Promise<WorkspaceLedgerState | undefined>;
  write(state: WorkspaceLedgerState, ctx: { sessionId: string; turnId: string }): Promise<void>;
};

export class WorkspaceLedgerStore implements SatiWorkspaceLedgerProvider {
  private readonly path: string | undefined;
  /** In-memory fallback used when there is no transcript path (in-memory writer). */
  private latest: WorkspaceLedgerState | undefined;

  constructor(
    private readonly transcript: AgentTranscriptWriter,
    private readonly sessionId: string,
    transcriptPath?: string,
  ) {
    this.path = transcriptPath && transcriptPath.length > 0 ? transcriptPath : undefined;
  }

  async read(): Promise<WorkspaceLedgerState | undefined> {
    if (this.path !== undefined) {
      const { entries } = await readTranscript(this.path);
      this.latest = readLatestWorkspaceState(entries) ?? this.latest;
      return this.latest;
    }
    return this.latest;
  }

  async write(state: WorkspaceLedgerState, ctx: { sessionId: string; turnId: string }): Promise<void> {
    if (this.transcript.recordWorkspaceState !== undefined) {
      await this.transcript.recordWorkspaceState(ctx.sessionId ?? this.sessionId, ctx.turnId, state);
    }
    this.latest = state;
  }
}
