# Agent Note: 工具引用门禁从 cap01 扩到全部提示词、技能与规则文档

Status: implemented

## Problem

`check:patent-sop` 只扫描 `cap01-orchestrator.md` 与 workflow YAML。工具引用实际散落在 patent 提示词、`skills/**/SKILL.md` 与 `rules/**/*.md` 中，于是 `patent_kg_search`、`patent_kg_path`、`patent_rag`、`patent_law` 这类幽灵工具名能长期通过门禁，模型按提示词调用时只能得到工具不存在的错误。审计还发现 cap07 的 `knowledge_rules` / `knowledge_graph_path` 同属此形态。

## Decision

门禁扫描面扩到 `assets/prompts/patent/**/*.md`、`skills/**/SKILL.md`、`rules/**/*.md`，提取反引号内、至少含一个下划线的 snake_case token，再与工具 / 角色 / worker / manifest / atom 五类权威清单比对。调用式写法（`` `patent_case_search({ query: ... })` ``）只取工具名，不要求反引号紧跟标识符。cap01 保留宽口径标识符（允许连字符），继续校验 `patent-analyzer` 这类角色/worker；其他文档只用工具形 token，避免把第三方技能名误判为幽灵。报错带 `文件:行` 与疑似替代项；同前缀工具作为兜底提示。非工具 token（输入变量、规则 `check.type`、运行配置、第三方站点工具）进入显式白名单并注释来源。

四个扫描面（三类文档 + workflow YAML）必须存在且至少有一个文件；目录改名或资产未发布时门禁 fail-loud，不再因为读到空集而打印 fresh。当前明确不扫 `skills/**/references/*.md`，覆盖边界写在脚本头注释里。

工具清单提取同时补齐 `src/literature/tool`、`src/knowledge/legal` 与 `*_TOOL_NAME` 常量，避免把真实工具（`paper_search`、`law_verify`）误判成幽灵。五处确认的幽灵引用改为真实工具；cap07 的两处同型引用一并修正；`patent-agent` 文档中把 `set_gaps` / `record_revision` 改写为 `patent_docket(action=...)`，避免把 action 名当工具调用。

## Alternatives considered

- **只扫描 cap09** — 能清掉当前五处，但下一个文档仍会漏，门禁价值取决于覆盖面。
- **扫描全部反引号 token** — 单字、连字符文件名与外部 CLI 会制造大量噪音，且无法区分「工具名」与「普通代码标识」；折中为 cap01 保留宽口径、其他文档只认工具形 token。
- **未知 token 一律放行** — 等于没有门禁；白名单必须显式列出并说明理由。
- **目录缺失时按空集继续** — 会把「没扫到」呈现成「已核验且无问题」，违反降级但不静默（AGENTS.md 铁律 11）。
- **按工具名前缀猜替代项并自动修复** — 猜测可能改错语义，只作为报错提示，修复仍由人确认。

## Consequences

扫描面内新增工具形引用（含调用式）会被立即拦下；新增非工具 token 需要维护白名单，这是有意付出的成本。门禁运行时间仍为毫秒级。负向测试用临时 fixture 树覆盖提示词、技能、规则三个扫描面、调用式幽灵、cap01 连字符角色/worker、扫描面缺失与白名单放行。`skills/**/references/*.md` 仍未纳入，后续如需覆盖应单独扩面并补测试。
