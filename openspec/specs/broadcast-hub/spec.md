# broadcast-hub Specification

## Purpose

在子代理 fork 时把父级的 live Core（J-Space 账本的活跃核心条目）作为 directive 前缀下发，使分歧在共享的 hub 上解决而不是各写私有副本。实现见 `src/session/workspace/WorkspaceLedger.ts` 与 `src/agent/loop/toolContext.ts`（无 live Core 时为 no-op）。

## Requirements

### Requirement: Core is a shared hub with a write-once protocol

When the workspace ledger is enabled and has live `Core` anchors, the injected `<workspace-state>` block SHALL carry a protocol note telling the model to read shared anchors from the hub and to resolve a divergent value at the hub rather than in a branch.

#### Scenario: Protocol note shown with live core
- **WHEN** the ledger has at least one live `Core` entry
- **THEN** the `<workspace-state>` block includes a write-once/read-many protocol note.

#### Scenario: No note when core is empty
- **WHEN** the ledger has no live `Core` entries
- **THEN** the block does not include the protocol note.

### Requirement: Subagents inherit the parent's live core

When the workspace ledger is enabled and a subagent is forked, the subagent's directive SHALL be prefixed with the parent's live `Core` anchors so it reads the same shared instance.

#### Scenario: Subagent directive carries the parent core
- **WHEN** a subagent is forked and the parent has live `Core` anchors
- **THEN** the subagent's directive begins with a `<workspace-core>` block containing those anchors.

#### Scenario: No core, no prefix
- **WHEN** a subagent is forked and the parent has no live `Core` anchors
- **THEN** the directive is unchanged.

### Requirement: Divergence is resolved at the hub

The protocol note SHALL instruct that a sub-task needing a different value for a shared anchor must surface the discrepancy rather than silently using a private copy.

#### Scenario: Instruction is present
- **WHEN** the protocol note is rendered
- **THEN** it states that a conflict should be resolved at the hub.
