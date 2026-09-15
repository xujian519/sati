/**
 * WorkspaceLedgerReader — derive the latest workspace ledger from transcript entries.
 *
 * The ledger is append-only and never shadowed by compaction, so the latest
 * `workspace_state` entry is the authoritative state. Re-reading it fresh from
 * the transcript (rather than from message history) is what lets the ledger
 * survive compaction.
 *
 * Reading is *resumable*: {@link scanLatestWorkspaceState} accepts the cursor of
 * a previous scan and only walks the entries appended since then. The cursor is
 * anchored on the object identity of the last entry it covered, which is what
 * keeps the shortcut honest — `readTranscript` returns element-shared arrays, so
 * a transcript that was replaced, rewritten or rolled back is re-parsed into
 * *new* entry objects, the anchor no longer matches, and the scan restarts from
 * the beginning. Identity, not `length`, is the invalidation signal: same-length
 * rewrites are exactly the case a length-only guard would miss.
 *
 * (TD-SESSION-N01 / TD-WORKSPACE-N01 / #344.)
 */
import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";
import { cloneWorkspaceLedgerState, type WorkspaceLedgerState } from "./WorkspaceLedger.js";

/** Resume point of a previous scan, threaded back into the next one. */
export type WorkspaceStateScanCursor = {
  /** Number of entries covered by the previous scan (a prefix of the array). */
  scanned: number;
  /** Last covered entry, by reference; undefined when `scanned === 0`. */
  anchor: AgentTranscriptEntry | undefined;
  /** Latest `workspace_state` seen in the covered prefix, by reference (not cloned). */
  state: WorkspaceLedgerState | undefined;
};

export type WorkspaceStateScanResult = {
  /** Cursor to hand to the next {@link scanLatestWorkspaceState} call. */
  cursor: WorkspaceStateScanCursor;
  /**
   * Reference to the latest `workspace_state` entry's state, or undefined when
   * none exists. Deliberately not cloned: the cursor keeps it across calls, and
   * the caller clones only what it hands out.
   */
  state: WorkspaceLedgerState | undefined;
};

/**
 * Return a clone of the latest `workspace_state` entry, or undefined when none
 * exists. One-shot form (no resume cursor) — callers that read repeatedly should
 * keep a {@link WorkspaceStateScanCursor} instead.
 */
export function readLatestWorkspaceState(entries: readonly AgentTranscriptEntry[]): WorkspaceLedgerState | undefined {
  const { state } = scanLatestWorkspaceState(entries);
  return state === undefined ? undefined : cloneWorkspaceLedgerState(state);
}

/**
 * Scan for the latest `workspace_state`, reusing `cursor` to skip the prefix
 * already covered. Cost is O(new entries), i.e. O(1) on the common path where
 * nothing was appended since the previous read.
 */
export function scanLatestWorkspaceState(
  entries: readonly AgentTranscriptEntry[],
  cursor?: WorkspaceStateScanCursor,
): WorkspaceStateScanResult {
  const resume = resolveResumePoint(entries, cursor);
  let latest = resume.state;
  for (let index = resume.start; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type === "workspace_state") {
      latest = entry.state;
    }
  }
  return { cursor: { scanned: entries.length, anchor: entries[entries.length - 1], state: latest }, state: latest };
}

/**
 * Decide where the scan may resume. Anything other than "the array grew from the
 * exact prefix we last saw" restarts from zero and drops the remembered state —
 * a conservative miss costs one rescan, a wrong hit would resurrect a ledger
 * from a transcript that no longer says so.
 */
function resolveResumePoint(
  entries: readonly AgentTranscriptEntry[],
  cursor: WorkspaceStateScanCursor | undefined,
): { start: number; state: WorkspaceLedgerState | undefined } {
  if (cursor === undefined) return { start: 0, state: undefined };
  if (entries.length < cursor.scanned) return { start: 0, state: undefined };
  if (cursor.scanned > 0 && entries[cursor.scanned - 1] !== cursor.anchor) return { start: 0, state: undefined };
  return { start: cursor.scanned, state: cursor.state };
}
