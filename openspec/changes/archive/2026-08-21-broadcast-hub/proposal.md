## Why

When several sub-tasks need the same name, value, constraint, or style anchor, each one re-deriving its own copy drifts. One authoritative write, read by many, is the broadcast discipline: it is why you do not work twice. Re-deriving is not diligence — it is what happens when something was never properly written down once.

## What Changes

- Surface the workspace-ledger `Core` section as a shared hub with a "write once, read many" protocol note, so the model reads shared anchors from one place.
- When forking a subagent, carry the parent's live `Core` anchors into the subagent's directive, so subagents read the same instance instead of reconstructing locally.
- Protocol guidance: resolve a divergent value at the hub, not in a branch.

## Capabilities

### New Capabilities

- `broadcast-hub`: a shared-core protocol that carries the workspace-ledger `Core` into subagent context and instructs one authoritative write.

### Modified Capabilities

None. Workspace-ledger already provides the `Core` section; this change adds the protocol and subagent inheritance on top.

## Impact

- **Modified source**: `src/session/workspace/WorkspaceLedger.ts` (render protocol note with Core), `src/agent/loop/toolContext.ts` (prepend parent Core to subagent directive), `src/agent/sub/contextInheritance.ts` (helper).
- **Tests**: `tests/agent/sub/workspace-core-inheritance.spec.ts`.
- **Config**: reuse `SATI_WORKSPACE_LEDGER_ENABLED` (off by default).
