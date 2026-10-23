# Agent Note: 工具引用门禁从 cap01 扩到全部提示词、技能与规则文档

Status: implemented

## Problem

`check:patent-sop` 只扫描 `cap01-orchestrator.md` 与 workflow YAML。工具引用实际散落在 patent 提示词、`skills/**/SKILL.md` 与 `rules/**/*.md` 中，于是 `patent_kg_search`、`patent_kg_path`、`patent_rag`、`patent_law` 这类幽灵工具名能长期通过门禁，模型按提示词调用时只能得到工具不存在的错误。审计还发现 cap07 的 `knowledge_rules` / `knowledge_graph_path` 同属此形态。

## Decision

门禁扫描面扩到 `assets/prompts/patent/**/*.md`、`skills/**/SKILL.md`、`rules/**/*.md`，只提取反引号内、至少含一个下划线的 snake_case token，再与工具 / 角色 / worker / manifest / atom 五类权威清单比对。报错带 `文件:行` 与疑似替代项；同前缀工具作为兜底提示。非工具 token（输入变量、规则 `check.type`、运行配置、第三方站点工具）进入显式白名单并注释来源。

工具清单提取同时补齐 `src/literature/tool`、`src/knowledge/legal` 与 `*_TOOL_NAME` 常量，避免把真实工具（`paper_search`、`law_verify`）误判成幽灵。五处确认的幽灵引用改为真实工具；cap07 的两处同型引用一并修正。

## Alternatives considered

- **只扫描 cap09** — 能清掉当前五处，但下一个文档仍会漏，门禁价值取决于覆盖面。
- **扫描全部反引号 token** — 单字、连字符文件名与外部 CLI 会制造大量噪音，且无法区分「工具名」与「普通代码标识」。
- **未知 token 一律放行** — 等于没有门禁；白名单必须显式列出并说明理由。
- **按工具名前缀猜替代项并自动修复** — 猜测可能改错语义，只作为报错提示，修复仍由人确认。

## Consequences

文档新增工具引用会立即被拦下；新增非工具 token 需要维护白名单，这是有意付出的成本。门禁运行时间仍为毫秒级。负向测试用临时 fixture 树覆盖提示词、技能、规则三个扫描面与白名单放行。
