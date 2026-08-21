## Context

The workspace ledger (already landed) provides a `Core` section with at most two live shared anchors. This change turns that section into a broadcast hub: the model reads shared anchors from one authoritative place, and forked subagents inherit the parent's live core instead of reconstructing it locally.

## Goals / Non-Goals

**Goals:**
- Render a write-once/read-many protocol note with the live `Core` section.
- Carry the parent's live `Core` into forked subagent directives.
- Instruct that divergent values are resolved at the hub.

**Non-Goals:**
- Do not add a separate hub data structure — reuse the ledger `Core`.
- Do not change subagent scheduling or tooling beyond the directive prefix.
- Off by default (reuses `SATI_WORKSPACE_LEDGER_ENABLED`).

## Decisions

### D1. Reuse the ledger Core
The `Core` section is already persisted and injected via the workspace-state block. No new state.

### D2. Prefix subagent directive with parent core
In the subagent fork path (`buildSubagentForkApi.fork`), read the parent's ledger and prepend a `<workspace-core>` block (the live anchors) to the directive. When no live core or ledger disabled, the directive is unchanged (no-op).

### D3. Protocol note rendered only when core is live
The note is emitted alongside live core anchors, so an empty core adds no noise.

## Risks / Trade-offs

- **Context cost**: prefixing every subagent directive with the core adds a small, bounded amount. Mitigated by carrying only live anchors (max two) and only when the ledger is enabled.
- **Subagent independence**: passing the parent's core couples the subagent to the parent's shared anchors; that is the intent, but it means a subagent may read a hub value rather than re-derive. Acceptable and documented.
- **Scope**: deliberately limited; does not add reconcile or conflict resolution beyond the protocol instruction.
