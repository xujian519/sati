# Agent Note: 建立开发规范三件套底座 + 第 1 步门禁落地

Status: implemented

## Problem

Sati 已有 typecheck / lint / format / test 四道门禁与 5 个领域门禁（event-matrix / patent-sop / patent-workflow-docs / html-templates / skills），但缺两块底座：门禁的**负控制**（证明门禁真在拦，而非配置写错悄悄失效）与**决策记录**（防非平凡决策被反复争论），且无入库的根级 standing orders（只有不入库的 `CLAUDE.md`）。此外门禁分散无单一 `check` 入口、推送前无类型兜底、tsconfig 缺 `noFallthroughCasesInSwitch`。

## Decision

- 建立规范明细层 `docs/development-standards.md`（分层模型 + 现状盘点 + 门禁细则 + 负控制 + 元规则 + 分阶段清单），融合两份外部参考底稿并逐项核对 Sati 现状。
- 建立根级 standing orders `AGENTS.md`（入库，跨工具每会话必读，每条 1–3 行链接详述家）。
- 建立决策记录制度 `docs/notes/{proposed,implemented,rejected}/`。
- 第 1 步落地：新增 `pnpm check` 聚合脚本、`pre-push` 类型兜底钩子、`tests/development-standards/verify-config.spec.ts` 负控制、开启 `noFallthroughCasesInSwitch`。

## Alternatives considered

- **只写规范文档，不落地任何门禁** — 会退化为"愿望清单"，违背"规范 = 文档 + 机器检查 + 决策记录"三件套原则，弃。
- **一步到位开 `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` / 类型感知 lint** — 会一次性暴露大量存量错误，盲翻破坏 CI；改成分批收敛（第 2 步），弃。
- **覆盖率门禁直接套 vitest 到后端** — 后端是 `node:test` 非 vitest，`@vitest/coverage-v8` 不能直接套，需另选型（c8）；推迟到第 2 步，弃。
- **`check` 聚合脚本纳入 test** — test 先 build + ~20s，纳入会让"本地快、CI 全"失效，弃。

## Consequences

换来：门禁有单一入口（`pnpm check`）与负控制（verify-config 钉住编译器底线）、决策有据可查、跨工具（Claude Code / Cursor / Codex）有共同规则家。付出：`check` 不含 test；`pre-push` 使每次推送多跑根/UI 两次 tsc（数十秒）。
