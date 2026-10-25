# Agent Note: 专利著录项与法律状态不再静默返回空字段

Status: implemented

## Problem

Google Patents 详情页结构变化后，vendor 解析器对选择器命中 0 个元素不抛异常，`patent_metadata` / `patent_legal_status` 仍返回 `success:true`，但发明人、受让人、申请日、法律状态全为空，`parseWarnings` 也是空数组。模型与用户都无法区分「该专利没有这些字段」与「解析器坏了」，渲染层只能显示 `N/A`。

## Decision

`mapper.ts` 计算 `missingFields`（title / inventors / assignees / filingDate / grantDate / legalStatus），并区分两种降级：

- 必需字段（title + inventors + assignees + filingDate）全空 → `PARSE_ERROR`（`tool_execution_failed`），不再返回 `success:true`；
- 部分缺失 → `degraded: true` + `degradedReason` + `missingFields` + `dataSource: "html-microdata"`，并在工具文本里显式写「页面结构变化，字段不可用」。

`patent_legal_status` 逐条输出同样的降级信号，空状态归一为 `UNKNOWN`。两条降级路径登记在 `assets/degradation/registry.yaml`（`patent-metadata-page-structure` / `patent-legal-status-page-structure`），负向演练指向对应工具测试。

## Alternatives considered

- **继续显示 `N/A` 并依赖 parseWarnings** — vendor 只在 catch 里 push warning，选择器空命中不会产生 warning；这条路径在结构变化时永远不触发。
- **任何字段缺失都抛错** — 现行页面只稳定保留标题，会把「部分可用」误判为整页故障，工具完全不可用。
- **只在 UI 层提示** — 工具输出先进入模型上下文；模型拿不到降级信号仍会得出「该专利无发明人」的结论。
- **等上游 nuo-patent 升级解析器** — 结构性修复仍应推上游，但适配层必须先让缺失可见，否则等待期主链路继续静默。

## Consequences

部分可用的专利会带 `degraded=true` 返回，模型可据此降权结论；整页不可解析时工具 fail-loud。字段缺失的可见性依赖 `missingFields` 的字段清单，后续新增期望字段需要同步 `computeMissingFields` 与测试。
