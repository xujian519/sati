## 1. Ledger state machine

- [x] 1.1 Create `src/session/workspace/WorkspaceLedger.ts` with types (Goal/Core/Verified/Open/Next), `applyNote`, `nextVerifiedNumber`/`nextOpenNumber` (no number reuse), `toModelBlock`, and all invariants (open requires Goal+Next; Next never empty; Verified needs verifier+coverage; Open needs settle-by; close needs a recorded checkpoint; core max 2 live; explicit slot swap).
- [x] 1.2 Create `tests/session/workspace/workspace-ledger.spec.ts` covering the invariants (open/refuse, verified coverage, open close + number reuse, core swap, mixed note applies valid edits).

## 2. Transcript persistence

- [x] 2.1 Add `workspace_state` to `AgentTranscriptEntryType` and the `AgentWorkspaceStateTranscriptEntry` union member in `src/session/transcript/TranscriptEntry.ts`.
- [x] 2.2 Add `recordWorkspaceState(sessionId, turnId, state)` to `src/session/transcript/JsonlTranscriptWriter.ts`.

## 3. Read + inject before model call

- [x] 3.1 Create `src/session/workspace/WorkspaceLedgerReader.ts` (read latest `workspace_state` from entries).
- [x] 3.2 In `src/agent/loop/AgentLoop.ts`, read the ledger in `createModelRequest` and inject a compact `<workspace-state>` system-prompt addendum when enabled.

## 4. Ledger survives compaction

- [x] 4.1 Confirm the ledger survives compaction: `workspace_state` is a transcript entry (not a message) so compaction does not shadow it; `readLatestWorkspaceState` re-derives it fresh and `AgentLoop.createModelRequest` re-injects it as a system-prompt addendum. No loop seam write is required — the `workspace_note` tool persists on each note.

## 5. workspace_note tool

- [x] 5.1 Create `src/tool/builtin/workspace/WorkspaceNoteTool.ts` wrapping `applyNote` + persistence; declare `outputSchema`; no `domain` (visible to all).
- [x] 5.2 Register `workspace_note` in `src/tool/registry/createBuiltinRegistry.ts` (gated by config) via `annotate(tool, "session")`.
- [x] 5.3 Add `SATI_WORKSPACE_LEDGER_ENABLED` env gate (opt-in, off by default) and wire `workspaceLedger` into `AgentRuntimeConfig` in `src/cli/createLocalGateway.ts` + `src/env.ts`.
- [x] 5.4 Create `tests/tool/builtin/workspace/workspace-note.spec.ts`.

## 6. workspace_ship + registerLeak

- [x] 6.1 Create `src/context/workspace/registerLeak.ts` with English + Chinese CLAIM/COVERAGE regexes and `scanRegisterLeak(text)`.
- [x] 6.2 Create `src/tool/builtin/workspace/WorkspaceShipTool.ts` (report-only, exit 0 whether or not findings).
- [x] 6.3 Register `workspace_ship` in `createBuiltinRegistry.ts`.
- [x] 6.4 Create `tests/tool/builtin/workspace/ship.spec.ts`.

## 7. skill-validation

- [x] 7.1 Extend `scripts/validate-skills.mjs` with role frontmatter checks, no-version-talk scan, and same-family role spine checks (warn-level, no false positives).
- [x] 7.2 Add `check:skills` to `package.json` (standalone; not wired into lint because the validator already hard-fails on pre-existing container/symlink skills `ego-browser`/`patent-teams`).

## 8. Dependencies & config wiring

- [x] 8.1 Add `workspaceLedger?: SatiWorkspaceLedgerProvider` to `src/agent/runtime/AgentRuntimeDependencies.ts`.
- [x] 8.2 Add `workspaceLedger?: boolean` to `src/agent/runtime/AgentRuntimeConfig.ts`.
- [x] 8.3 Wire the store/reader, tool runtime context, loop injection, and tool registration.

## 9. Full verification

- [x] 9.1 Run `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`. typecheck/lint/format pass; `check:event-matrix` fresh; 25 new tests pass. The full suite shows 1–2 pre-existing flaky failures (`llm-replay-real`, occasionally `team-tools-integration`) that pass in isolation (llm-replay-real 3/3); neither is touched by this change (workspace-ledger is off by default and the createAgentSession reorder is behavior-preserving). `check:skills` is a standalone script (validator already hard-fails on pre-existing container/symlink skills).
