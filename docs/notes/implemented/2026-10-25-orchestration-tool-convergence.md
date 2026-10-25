# Agent Note: 编排工具面 5 合 3 与 manifest 描述动态生成

Status: implemented

## Problem

`patent_workflow` 描述首句是 “Run…”，但只做装配与规则门；`patent_workflow_run` 才是执行器；`patent_plan_task` 与 `flexible_plan` 职责重叠；8 个内置 manifest 在工具描述里只列了 3 个 / 2 个；专利面契约 56,400 字符，模型选择工具的噪音与漂移同时存在。

## Decision

收敛为三个入口：`patent_workflow_assemble`（装配 + 规则门）、`patent_workflow_run`（原子/图执行）、`patent_docket`（案卷生命周期）。旧名 `patent_workflow` 保留为 alias；`patent_plan_task` 的 `transition/sync/replan` 无状态动作并入 `flexible_plan`，旧名同样保留为 alias。

manifest 清单由 `formatManifestCatalog()` 从 `builtinPatentManifests` 生成并拼进 `patent_workflow_run` 描述，装配工具指向该目录；一致性测试断言 8/8 manifest 至少出现在一个工具描述中。描述预算落到：单工具 ≤1,200 字符、属性 description ≤200 字符、专利面总契约 ≤40,000 字符。

## Alternatives considered

- **删除旧工具名** — 提示词、技能与用户脚本仍在引用；一个版本的 alias 是低成本迁移窗。
- **保留 5 个入口只改描述** — 模型仍要在重叠职责间选择；收敛到三个动作语义更清晰。
- **把 `patent_workflow_run` 与装配合并** — 执行需要模型客户端与原子注册表，装配是确定性纯函数；合并会让无模型会话无法做收口。
- **只在文档里生成 manifest 清单** — 工具描述是模型实际看到的契约面，文档不会影响路由。
- **不设字符预算** — 56k 的契约面会持续膨胀；预算测试把膨胀变成 CI 红灯。

## Consequences

专利域注册工具从 30 降到 29（`patent_plan_task` 成为 alias），`docs/code-facts.md` 与 README claim 已同步。旧名调用仍可用，但新代码应使用 `patent_workflow_assemble`。描述瘦身删除了部分实现细节，运行时校验（`assertFigurePayloads`、输入类型/枚举）仍保留硬约束。
