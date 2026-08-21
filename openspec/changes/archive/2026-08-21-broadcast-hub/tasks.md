## 1. Protocol note in the workspace-state block

- [ ] 1.1 In `src/session/workspace/WorkspaceLedger.ts`, render a write-once/read-many protocol note alongside live `Core` anchors in `renderWorkspaceLedgerBlock`.

## 2. Subagent core inheritance

- [ ] 2.1 Add a `workspaceCoreDirective(input)` helper in `src/agent/loop/toolContext.ts` that reads the parent ledger and renders live `Core` anchors as a `<workspace-core>` prefix.
- [ ] 2.2 Prepend it to the subagent directive in `buildSubagentForkApi.fork` when present.

## 3. Test

- [ ] 3.1 Create `tests/agent/sub/workspace-core-inheritance.spec.ts` covering: core rendered as protocol note, core prefix in directive, no-op when no core.

## 4. Full verification

- [ ] 4.1 Run `pnpm typecheck && pnpm lint && pnpm format:check` and the new test.
