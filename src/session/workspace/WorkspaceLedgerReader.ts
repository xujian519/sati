/**
 * WorkspaceLedgerReader — derive the latest workspace ledger from transcript entries.
 *
 * The ledger is append-only and never shadowed by compaction, so it can always
 * be re-derived from the transcript. Reconstruction (#537) walks two entry
 * kinds: a full `workspace_state` **anchor** is self-sufficient (a single anchor
 * rebuilds the ledger as of that point — the PR #378 invariant), and each
 * `workspace_state_delta` between anchors replays one accepted note onto it.
 * Anchoring periodically instead of snapshotting the full state on every write
 * is what stops the transcript from growing O(n²) as `verified` accumulates.
 * Re-reading from the transcript (rather than from message history) is what lets
 * the ledger survive compaction.
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
import { applyWorkspaceNote, cloneWorkspaceLedgerState, type WorkspaceLedgerState } from "./WorkspaceLedger.js";

/** Resume point of a previous scan, threaded back into the next one. */
export type WorkspaceStateScanCursor = {
  /** Number of entries covered by the previous scan (a prefix of the array). */
  scanned: number;
  /** Last covered entry, by reference; undefined when `scanned === 0`. */
  anchor: AgentTranscriptEntry | undefined;
  /** Latest reconstructed ledger state in the covered prefix, by reference (not cloned). */
  state: WorkspaceLedgerState | undefined;
  /**
   * Number of `workspace_state_delta` entries accumulated since the last full
   * `workspace_state` anchor within the covered prefix (#537). Optional so a
   * caller-built cursor without it resumes as "0 deltas since anchor"; the
   * writer uses it to decide when the next write must re-anchor.
   */
  deltasSinceAnchor?: number;
};

export type WorkspaceStateScanResult = {
  /** Cursor to hand to the next {@link scanLatestWorkspaceState} call. */
  cursor: WorkspaceStateScanCursor;
  /**
   * Reference to the reconstructed latest ledger state, or undefined when none
   * exists. Deliberately not cloned: the cursor keeps it across calls, and the
   * caller clones only what it hands out.
   */
  state: WorkspaceLedgerState | undefined;
  /**
   * Deltas accumulated since the last anchor (#537). The store compares this
   * against its anchor interval to bound how many deltas a cold read replays.
   */
  deltasSinceAnchor: number;
};

/**
 * Return a clone of the reconstructed latest ledger state (last anchor plus any
 * deltas after it), or undefined when none exists. One-shot form (no resume
 * cursor) — callers that read repeatedly should keep a
 * {@link WorkspaceStateScanCursor} instead.
 */
export function readLatestWorkspaceState(entries: readonly AgentTranscriptEntry[]): WorkspaceLedgerState | undefined {
  const { state } = scanLatestWorkspaceState(entries);
  return state === undefined ? undefined : cloneWorkspaceLedgerState(state);
}

/**
 * Scan for the latest ledger state, reusing `cursor` to skip the prefix already
 * covered. Cost is O(new entries), i.e. O(1) on the common path where nothing
 * was appended since the previous read.
 *
 * Reconstruction (#537): a full `workspace_state` entry is a self-sufficient
 * anchor that resets the accumulator; each subsequent `workspace_state_delta`
 * replays its note onto the accumulator via the same pure {@link applyWorkspaceNote}
 * the write path used, so the derived state is byte-for-byte what the writer saw.
 * A delta with no preceding anchor cannot be reconstructed (trimmed/corrupt
 * transcript) and is skipped rather than applied to an invented base.
 */
export function scanLatestWorkspaceState(
  entries: readonly AgentTranscriptEntry[],
  cursor?: WorkspaceStateScanCursor,
): WorkspaceStateScanResult {
  const resume = resolveResumePoint(entries, cursor);
  let latest = resume.state;
  let deltas = resume.deltas;
  for (let index = resume.start; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type === "workspace_state") {
      // Anchor: self-sufficient full snapshot. Reset the accumulator and the
      // delta count — a cold read needs only this entry to rebuild the ledger.
      latest = entry.state;
      deltas = 0;
    } else if (entry.type === "workspace_state_delta" && latest !== undefined) {
      const applied = applyWorkspaceNote(latest, entry.note);
      // A rejected/no-op note never produced a delta on the write path, so this
      // is defensive: keep the accumulator unchanged rather than corrupt it.
      if (applied.changed) latest = applied.state;
      deltas += 1;
    }
  }
  return {
    cursor: {
      scanned: entries.length,
      anchor: entries[entries.length - 1],
      state: latest,
      deltasSinceAnchor: deltas,
    },
    state: latest,
    deltasSinceAnchor: deltas,
  };
}

/**
 * Decide where the scan may resume. Anything other than "the array grew from the
 * exact prefix we last saw" restarts from zero and drops the remembered state —
 * a conservative miss costs one rescan, a wrong hit would resurrect a ledger
 * from a transcript that no longer says so. A restart also zeroes the delta
 * count, so the accumulator is rebuilt from the first anchor in the array.
 */
function resolveResumePoint(
  entries: readonly AgentTranscriptEntry[],
  cursor: WorkspaceStateScanCursor | undefined,
): { start: number; state: WorkspaceLedgerState | undefined; deltas: number } {
  if (cursor === undefined) return { start: 0, state: undefined, deltas: 0 };
  if (entries.length < cursor.scanned) return { start: 0, state: undefined, deltas: 0 };
  if (cursor.scanned > 0 && entries[cursor.scanned - 1] !== cursor.anchor) {
    return { start: 0, state: undefined, deltas: 0 };
  }
  return { start: cursor.scanned, state: cursor.state, deltas: cursor.deltasSinceAnchor ?? 0 };
}
