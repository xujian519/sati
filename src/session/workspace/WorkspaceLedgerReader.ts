/**
 * WorkspaceLedgerReader — derive the latest workspace ledger from transcript entries.
 *
 * The ledger is append-only and never shadowed by compaction, so the latest
 * `workspace_state` entry is the authoritative state. Re-reading it fresh from
 * the transcript (rather than from message history) is what lets the ledger
 * survive compaction.
 */
import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";
import { cloneWorkspaceLedgerState, type WorkspaceLedgerState } from "./WorkspaceLedger.js";

/** Return a clone of the latest `workspace_state` entry, or undefined when none exists. */
export function readLatestWorkspaceState(entries: readonly AgentTranscriptEntry[]): WorkspaceLedgerState | undefined {
  let latest: WorkspaceLedgerState | undefined;
  for (const entry of entries) {
    if (entry.type === "workspace_state") {
      latest = cloneWorkspaceLedgerState(entry.state);
    }
  }
  return latest;
}
