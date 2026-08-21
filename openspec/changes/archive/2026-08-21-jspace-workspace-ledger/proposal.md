## Why

Sati's full compaction replaces history with an LLM summary that loses detail, drifts, and forces the model to re-derive facts; long-horizon agents degrade mainly from a context-handling gap, and once a run commits to a wrong intermediate state most architectures cannot detect or roll it back. We introduce a J-Space style workspace ledger — a durable, re-readable authoritative state segment that survives compaction and is re-read at every seam — plus the controller tools that maintain it, and author-time validation to keep the skill assets consistent.

## What Changes

- Add a **workspace ledger** (five sections: Goal / Core / Verified / Open / Next) as a structured, numbered, append-only state segment derived from the transcript and re-injected before every model call, so it **survives compaction**.
- Add **`workspace_note`** tool for the model to update the ledger; it refuses malformed writes and never drops independent edits from the same call.
- Add **`workspace_ship`** tool that reports inner-register leakage in outgoing text (dense-track symbols, "verified" claims without stated coverage, repetition loops). Report-only, never blocks.
- Extend **`scripts/validate-skills.mjs`** with role-frontmatter consistency, no-version-talk scanning, and same-family role spine checks; wire `check:skills` into the lint chain.
- All features are **opt-in** (config-gated), off by default.

## Capabilities

### New Capabilities

- `workspace-ledger`: durable, append-only, compaction-surviving workspace state (Goal/Core/Verified/Open/Next) with numbered verified/open anchors and re-injection before each model call.
- `workspace-controller-tools`: `workspace_note` (validated ledger writes) and `workspace_ship` (report-only register-leak check).
- `skill-validation`: author-time validation of role frontmatter, version-talk, and same-family role spine.

### Modified Capabilities

None. No existing spec-level behavior changes.

## Impact

- **New source**: `src/session/workspace/WorkspaceLedger.ts`, `src/session/workspace/WorkspaceLedgerReader.ts`, `src/tool/builtin/workspace/WorkspaceNoteTool.ts`, `src/tool/builtin/workspace/WorkspaceShipTool.ts`, `src/context/workspace/registerLeak.ts`.
- **Modified source**: `src/session/transcript/TranscriptEntry.ts`, `src/session/transcript/JsonlTranscriptWriter.ts`, `src/agent/loop/AgentLoop.ts`, `src/agent/runtime/AgentRuntimeConfig.ts`, `src/agent/runtime/AgentRuntimeDependencies.ts`, `src/tool/registry/createBuiltinRegistry.ts`, `src/cli/createLocalGateway.ts`, `src/pilot/config/types.ts`, `scripts/validate-skills.mjs`, `package.json`.
- **Tests**: `tests/session/workspace/workspace-ledger.spec.ts`, `tests/tool/builtin/workspace/workspace-note.spec.ts`, `tests/tool/builtin/workspace/ship.spec.ts`.
- **Config**: a `workspaceLedgerEnabled` pilot/context flag; a `workspaceLedger` AgentRuntimeConfig/dependencies knob.
