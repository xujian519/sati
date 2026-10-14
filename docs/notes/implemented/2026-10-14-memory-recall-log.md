# Agent Note: 记忆召回日志（recall log）与保守引用回填

Status: implemented

## Problem

Sati 的记忆/知识注入链（EdgeClaw 会话记忆 + 多路知识 MemoryResolver）此前只有瞬时 `ContextDiagnostic` 码：检索了没有、注入了什么、超时降级了没有，当轮可见、过后无痕。两个问题长期无解：

1. **「注入后是否真的被用上」无闭环**——知识注入是否改善了回答，只能靠体感；
2. **降级不可审计**——超时/空结果/deferred 只有当轮 info/warning 诊断，无法事后回答「上周有多少轮该注入没注入」。

上游参照：dsh-patent-workbench 的 `knowledge_recall_log`（每次检索落库、含跳过原因与引用回填）是该问题域的成熟解法（调研见 `docs/plans/2026-10-14-knowledge-governance-import.md`）。

## Decision

引入 `src/context/memory/recall-log.ts`：

- **每次检索落一行** `memory_recall_log`：query、结构化 hits（id/title/score/snippet）、injected、skip_reason（`timeout|error|empty_context|aborted|deferred` 必填其一）、diagnostics、created_at；滚动保留最近 2000 行。
- **写入点收敛两处**：`MemoryAttachmentBuilder` 全路径（注入/空/超时/错误/取消）+ `DefaultContextRuntime` 的 deferred 路径（builder 尚未结算，由 runtime 补记，不重复）。
- **turn 收尾保守引用回填**：`captureTurn` 扫描 assistant 输出，出现注入条目 id（≥6 字符）或唯一 ≥12 字标题前缀即回填 `cited_ids_json`；**前缀碰撞两条都不标**（宁可漏标不可瞎标，对齐 dsh autoCite 原则）。
- **独立 Sati 自有状态库** `~/.sati/state/memory-recall-log.db`（env `SATI_RECALL_LOG_DB` 可覆盖），与 knowledge.db 完全解耦。
- **fail-open**：打开/写入失败一次性 warn 后停用（`assets/degradation/registry.yaml` 已登记 `memory-recall-log-db` 条目），绝不影响检索与注入主流程。
- `MemoryRetrieveResult` 契约新增**可选** `hits` 字段（provider 渐进实现，未实现行为与现状一致）；composite resolver 透传合并。
- 不新增 AgentEvent/gateway 帧——可观测走 DB 侧，避开事件矩阵膨胀（WS2 若走 UI 再评估）。

## Alternatives considered

- **写入 knowledge.db（`~/.sati/knowledge/knowledge.db`）** — 落选：该库是 XiaoNuo 管道产物（只读边界 + schema 版本契约），写运行日志会污染外部数据契约，且与 `documents` 层数据生命周期纠缠。
- **写入 edgeclaw 记忆库（memory rootDir 的 SQLite）** — 落选：global/project 双 scope 语义与日志的纯会话维度不一致，还会随记忆库清理/导出动作一起被处理。
- **随会话 transcript（JSONL）落日志** — 落选：日志与会话历史生命周期纠缠（删会话即丢观测），滚动清理也无从做起。
- **复用 `openKnowledgeDb`（src/knowledge/shared/db-version.ts）打开日志库** — 落选：该协议为「真源 fail-loud / 派生 needsRebuild」设计，日志库有自己的迁移阶梯语义；仅对齐其 application_id + user_version 协议精神，不引依赖（context 层保持对 knowledge 层零依赖）。
- **新增 AgentEvent 记忆帧承载可观测** — 落选：WS1 阶段消费方只有 DB 查询，上事件流会把文件:line 硬编码的事件矩阵成本引入每次检索路径；待 WS2 UI 面板立项时再评估。
- **引用判定用 fuzzy/语义匹配** — 落选：注入条目规模小、判定须可解释可审计；保守字面匹配（id + 唯一前缀）的漏标成本远低于误标成本（失真的证据比没有证据更糟）。

## Consequences

换来了：注入链全路径可审计（`skip_reason` 使「未核验」与「已核验无问题」可区分，铁律 11）；「知识是否被用上」首次可量化（`cited_ids_json` 回填率）；provider 有了渐进上报结构化命中的契约钩子。

付出了：每轮一次 SQLite 写入（毫秒级，异步于主流程之外的同步短写）；`MemoryRetrieveResult` 契约面扩大一个可选字段；引用判定目前是字面匹配，跨语言/改写场景的引用会漏标（保守优先的既定取舍，未来如需提高召回再引入标题归一化，不得放松碰撞不标原则）。
