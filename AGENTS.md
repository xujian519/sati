# AGENTS.md — Sati 项目 standing orders

> 本文件是**入库的根级铁律**（每条 1–3 行，链接其详述家），所有 AI 编程助手（Claude Code / Cursor / Codex 等）每会话必读。
> 详情见 `docs/development-standards.md`（规范明细层）、`CONTRIBUTING.md`（贡献流程）、`CLAUDE.md`（本地全量指南，不入库）。

## 强制规则

1. **类型**：strict 模式；新代码避免 `any`（用 `unknown`）；禁 `@ts-ignore`（用 `@ts-expect-error`）。→ `CONTRIBUTING.md`
2. **边界**：`src/` 不得导入 `ui/`；`ui/` 通过 gateway API / WebSocket 通信，不得直接导入 `src/`。→ `CONTRIBUTING.md`
3. **提交**：Conventional Commits `<type>(<scope>): <subject>`（git hook 强制）。→ `CONTRIBUTING.md`
4. **i18n**：新增用户可见文案必须提取到 `ui/src/i18n/locales/{en,zh-CN}/`。→ `CONTRIBUTING.md`
5. **事件面**：改 `AgentEvent` / gateway frames 后 `pnpm check:event-matrix` 必须 green（lint 自动挂接）。→ `docs/event-producer-consumer.md`
6. **重放契约**：改任何工具 `inputSchema`（含描述文本）会使 llm-replay fixture 失配，须重录。→ `docs/development-standards.md`
7. **决策记录**：非平凡变更（改行为/架构/契约/流程/格式）同一 PR 带/更新一条 `docs/notes/` note，含 `## Alternatives considered`。→ `docs/notes/README.md`
8. **测试**：改核心模块（`agent/` `router/` `tool/` `session/` 等）必须附测试；单测 mock 外部网络；LLM 回路走重放 seam。→ `CONTRIBUTING.md`
9. **验证顺序**：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`。→ `docs/development-standards.md`

## 关键环境事实（每会话记住）

- 提交必须走分支 + PR（main 受保护）；提交信息 hook 支持 `release` 类型；pre-commit 跑 `npx lint-staged`。
- 事件矩阵按 `file:line` 硬编码：跨文件移动代码（含 eslint --fix 删 import）后必须 `pnpm gen:event-matrix`。
- lint-staged 顺序 biome→eslint：eslint --fix 后需重新 biome 化。
