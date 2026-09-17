> **验收状态（2026-09-18 补）**：本文件是历史快照，勾选状态曾长期停留在交付前（见 #359）。
> 截至 2026-09-18 复核：未勾选 5 项中 **4 项已交付**（已回填勾选）、**0 项仍未交付**、**1 项无法核实**。本变更全部产物随提交 `651b77b0` 落地（已在 main）。
>
> - 已交付：1.1 workspace-state 协议注记 —— 证据 `src/session/workspace/WorkspaceLedger.ts:305`（`Core (shared hub — read these, write once)` + 冲突归 hub 提示）；2.1 `<workspace-core>` 前缀助手 —— 证据 `src/agent/loop/toolContext.ts:116` + `src/session/workspace/WorkspaceLedger.ts:337`（实现名为 `buildWorkspaceCoreDirective()` / `renderWorkspaceCoreDirective(state)`，与计划里的 `workspaceCoreDirective(input)` 不同名、且渲染落在 WorkspaceLedger）；2.2 fork 内前置拼接 —— 证据 `src/agent/loop/toolContext.ts:160-161`；3.1 继承测试 —— 证据 `tests/agent/sub/workspace-core-inheritance.spec.ts`（5 用例：注记渲染 / 无 core 不渲染 / 前缀产出 / 无 core 返回 undefined / 前缀确实前置到子代理 directive）。
> - 仍未交付：无。
> - 无法核实：4.1 全量验证 —— 条目是一次性命令 `pnpm typecheck && pnpm lint && pnpm format:check` + 新测试，仓库内不存该次运行结果，无法用产物判定（只能确认同批产物已随 `651b77b0` 合入 main）。

## 1. Protocol note in the workspace-state block

- [x] 1.1 In `src/session/workspace/WorkspaceLedger.ts`, render a write-once/read-many protocol note alongside live `Core` anchors in `renderWorkspaceLedgerBlock`.

## 2. Subagent core inheritance

- [x] 2.1 Add a `workspaceCoreDirective(input)` helper in `src/agent/loop/toolContext.ts` that reads the parent ledger and renders live `Core` anchors as a `<workspace-core>` prefix.
- [x] 2.2 Prepend it to the subagent directive in `buildSubagentForkApi.fork` when present.

## 3. Test

- [x] 3.1 Create `tests/agent/sub/workspace-core-inheritance.spec.ts` covering: core rendered as protocol note, core prefix in directive, no-op when no core.

## 4. Full verification

- [ ] 4.1 Run `pnpm typecheck && pnpm lint && pnpm format:check` and the new test.
