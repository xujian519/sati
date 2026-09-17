> **验收状态（2026-09-18 补）**：本文件是历史快照，勾选状态曾长期停留在交付前（见 #359）。
> 截至 2026-09-18 复核：未勾选 4 项中 **3 项已交付**（已回填勾选）、**0 项仍未交付**、**1 项无法核实**。本变更全部产物随提交 `651b77b0` 落地（已在 main）。
>
> - 已交付：1.1 组件文件 —— 证据 `src/methodology/runtime/components/bridge-reencode.ts:15`（`name`/`description`/`category`/`applicableDomains`/`identify` 走 `keywordScore(TRIGGERS)`/`execute` 返回重编码 + 结论前桥接 prompt；计划写的 `domains` 字段实际名为 `applicableDomains`）；2.1 注册进默认组件集 —— 证据 `src/methodology/runtime/MethodologyRegistry.ts:35`（`DEFAULT_METHODOLOGY_COMPONENTS` 数组，import 见 `:23`）；3.1 测试 —— 证据 `tests/methodology/bridge-reencode.spec.ts`（4 用例：命中推理任务 / 普通对话不命中 / prompt 含重编码与桥接 / 默认集成员断言 `:34`）。
> - 仍未交付：无。
> - 无法核实：4.1 全量验证 —— 条目是一次性命令 `pnpm typecheck && pnpm lint && pnpm format:check` + 新测试，仓库内不存该次运行结果，无法用产物判定（只能确认同批产物已随 `651b77b0` 合入 main）。

## 1. Component

- [x] 1.1 Create `src/methodology/runtime/components/bridge-reencode.ts` implementing `MethodologyComponent` (name, description, category, domains, `identify` via keywordScore on reasoning triggers, `execute` returning the re-encode + bridge prompt).

## 2. Registry

- [x] 2.1 Register `bridgeReencode` in `DEFAULT_METHODOLOGY_COMPONENTS` in `src/methodology/runtime/MethodologyRegistry.ts`.

## 3. Test

- [x] 3.1 Create `tests/methodology/bridge-reencode.spec.ts` covering trigger match, prompt contents, and default-registry presence.

## 4. Full verification

- [ ] 4.1 Run `pnpm typecheck && pnpm lint && pnpm format:check` and the new test.
