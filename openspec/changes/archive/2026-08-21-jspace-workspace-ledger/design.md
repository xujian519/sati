## Context

Sati already has strong engineering mechanisms for context pressure (token budget, three-tier compaction micro/snip/full, white-box memory, tool-result spill, doomLoop breakers). What it lacks is the explicit "cognitive protocol" layer: a durable, authoritative, re-readable state segment that survives compaction, plus tooling to maintain and police the inner/outer register split. This change adds that layer, following J-Space's design principles: dense on the inside, decodable on demand, clean on the outside; record-and-report (never decide or block); a ledger you cannot trust is worse than no ledger.

## Goals / Non-Goals

**Goals:**
- A five-section workspace ledger (Goal/Core/Verified/Open/Next) that is persisted in the transcript and re-injected before every model call, so it survives compaction and is re-read at each seam.
- Numbered, append-only `Verified` and `Open` anchors so "return to the last verified checkpoint" is an executable instruction, and `Open` closes only against a recorded checkpoint (fixing the no-recovery bottleneck).
- A `workspace_note` tool that records and reports ledger state, refuses malformed writes, and never drops independent edits in the same call.
- A `workspace_ship` tool that reports register leakage in outgoing text (report-only, never blocks).
- Author-time skill validation for role frontmatter, version-talk, and same-family role spine.

**Non-Goals:**
- Do not change the model's reasoning itself (no prompt-level metacognitive control, bridge-before-conclusion, or broadcast-hub protocol here).
- Do not make any feature on by default — everything is opt-in.
- Do not add a filesystem controller (e.g. `.jspace/`); the transcript is the single source of truth.

## Decisions

### D1. Ledger is derived from the transcript, not stored as a message
The ledger is NOT part of the message history. It is persisted as a dedicated `workspace_state` transcript entry (append-only, never shadowed by compaction) and re-read fresh before each model call, then injected as a compact `<workspace-state>` synthetic block. Because it is re-derived from the transcript each time, it survives compaction. This mirrors how `repeatToolReminder` injects a synthetic user message.

### D2. Opt-in via config
A `workspaceLedgerEnabled` flag (pilot `context` config) gates ledger re-injection and the `workspace_note`/`workspace_ship` tool registration; a `workspaceLedger` knob on `AgentRuntimeConfig`/`AgentRuntimeDependencies` carries the read/write seam into the loop. Defaults are off, so existing behavior is unchanged.

### D3. Pure ledger state machine
`WorkspaceLedger.ts` is a pure module (no I/O) implementing the invariants: Goal+Next required to open, Next never empty, Verified requires verifier+coverage, Open requires settle-by, close requires a recorded checkpoint in the same call, core max 2 live, explicit slot swap. It mirrors `jspace.py`'s `mode_note` logic and is unit-tested in isolation.

### D4. Controller tools wrap the state machine + persistence
`workspace_note` calls `applyNote` then persists via the transcript writer; on a mixed call it applies valid edits and reports rejected ones, never dropping independent valid edits. `workspace_ship` uses a shared `registerLeak.ts` module (English + Chinese CLAIM/COVERAGE regexes) and returns a report — it exits successfully whether or not it finds anything.

### D5. skill-validation extends the existing validator
`scripts/validate-skills.mjs` already validates frontmatter name/description and size caps. We add role-frontmatter checks, a version-talk scan (adapted from J-Space's `VERSION_TALK` regex), and a same-family role spine requirement (warn-level for general roles, hard for family roles) so we don't over-constrain the many heterogeneous role skills.

### D6. No protocol/event-matrix change
This change adds a transcript entry type and tools but does not change `AgentEvent` or gateway frames, so it does not touch `check:event-matrix`. The new transcript entry type is internal.

## Risks / Trade-offs

- **Context cost of re-injection**: the `<workspace-state>` block adds a small, bounded amount per model call. Mitigated by injecting at turn level and keeping the block short; a future optimization can inject only when the ledger changed.
- **Model reliance**: ledger maintenance depends on the model calling `workspace_note`; the first phase re-injects the ledger read-only and updates it at compaction/turn seams. Full model-driven maintenance is the second phase.
- **Validation over-reach**: strict same-family spine could false-positive on the many role skills. Mitigated by limiting hard spine requirements to clearly family roles and using warn-level for others.
- **Register-leak false positives**: `workspace_ship` is report-only, so false positives only add noise; the coverage regex is tuned for English + Chinese.
- **Scope**: this change is intentionally foundational and excludes the higher-risk prompt-level features (metacognitive control, broadcast hub, bridge-before-conclusion), which are separate future changes.
