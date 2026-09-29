# Agent Note: 专利案卷轮次状态机（docket）与 flexible-plan 分层

Status: implemented（2026-09-29）

## Problem

专利「交底书 → 申请文件」是一个多轮返工过程：每一轮由"未决缺口"（无法确认的事实、缺少的实验数据、待补材料）驱动，代理人需要在有限轮次内把缺口收敛到零再定稿。竞品调研（`handsomestWei/patent-disclosure-skill` 的 `patent-docket` 子技能等纯文本 Agent Skill）验证了这个节奏是真实业务需求，但它们只是把流程写进 prompt，没有强制力——大模型可以跳过缺口、无限重写、或在缺口未清时"顺手定稿"。Sati 已有 `flexible_plan`（阶段级生命周期：创建/执行/逐阶段确认/回退），但它管的是**单个计划内的阶段**，不表达"跨阶段的案卷轮次"这一维度。缺口：需要一个能强制轮次上限、把定稿门控在缺口清零之后、并按轮次留档版本的案卷层。

## Decision

新增 `src/patent/docket/`（纯函数状态机 + `JsonFileDocketStore` 持久化 + `archiveRevision` 版本留档），经 `patent_docket` 内置工具接入生产路径，与 `flexible_plan` **分层协作**：

- `flexible_plan` 继续管理**阶段**生命周期（`run`/`confirm`/`rollback`），`rollback` 是"新一轮修订"的触发点；
- `patent_docket` 管理**案卷轮次**：`triage` 分诊派工（`draft`/`revise(round)`/`finalize_ready`/`escalate_human`）、`set_gaps` 维护缺口清单、`record_revision` 记一轮（强制 `round ≤ maxRounds`，默认 3）、`finalize` 在未决缺口非空或 `round=0` 时 fail-closed 拒绝；
- 达 `maxRounds` 仍有缺口 → `escalate_human`，工具层**停止自动修订并转人工**，不静默继续；
- 每轮阶段产物经 `archiveRevision` 另存 `revisions/round-N/`（旧稿不动、修订记录独立留档），对齐竞品的 merger 留档语义。

案卷按 caseId 持久化于 `<工作区>/data/cases/dockets/`，跨会话 `get`/`list` 续办。技能接线见 `skills/patent-agent/SKILL.md` 的「案卷迭代协议」。

## Alternatives considered

- **并入 `FlexiblePlanState`（给阶段加轮次字段）** — 否决：阶段生命周期与案卷轮次是两个正交的变化轴，合并会把 `fromJSON` 的校验面撑大（既要校验阶段又要校验轮次/缺口/归档），且 `flexible_plan` 已上线、其 inputSchema 变更会破坏 llm-replay 重放契约。薄层独立状态机让两者各自演进。
- **照抄竞品的纯文本 docket（只写进 SKILL.md）** — 否决：无轮次强制与持久化，大模型可跳过缺口直接定稿，正是本次要治理的失效模式。落成状态机才有 fail-closed 约束。
- **归档走 `patent/shared/index-store` 的原子写 + 版本守卫** — 否决：index-store 面向"单文件索引 + 版本乐观锁"，与"按轮次写目录树"的语义不匹配；直接复用 `persist-utils` 的 `atomicWriteJson` 更贴合，且与 `flexible-plan-store` 同一实现。

## Consequences

换来：缺口闭环、轮次上限、定稿门控都变成可测试的硬约束（`tests/patent/docket-state.spec.ts` 16 例覆盖），代理返工不再无界。付出：案卷层与计划层是两个工具，编排者（`patent-agent`）需要知道何时建案卷——简单一次性分析不应建，协议文档已写明边界。`archiveRevision` 读产物文件失败时降级为提示、不阻断记账（轮次事实已成立），避免归档 I/O 拖垮状态迁移。
