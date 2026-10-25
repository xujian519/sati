# Agent Note: 空壳 outputSchema 注册期拒绝与只读声明按输入判定

Status: implemented

## Problem

`ToolRegistry` 只拦截 `outputSchema === undefined`，`{type:"object", properties:{}}` 可以注册；`ToolRuntime` 仅在 `data !== undefined` 时校验，空 properties 等于免检。10/30 个专利工具是空壳契约，`patent_workflow` 声明 `isReadOnly: () => true` 却在传 `caseId` 时写 `<caseDir>/workflow-runs/`，权限系统对只读工具在所有模式直接放行。

## Decision

注册期把「无 properties」与「空 properties」都视为空壳，非 MCP 工具直接 fail-loud；确需豁免的存量工具必须带非空 `outputSchemaExemptReason`，有真实 schema 时再带豁免视为冗余并报错。为专利面 10 个工具补齐真实 schema，并在有结构化返回的工具上补 `data` 信封（workflow / workflow_run / render / docket / flexible_plan / plan_task / worker_validate），使契约真正参与运行时校验。`patent_workflow_assemble` 的 `isReadOnly` 改为 `input => !input?.caseId`。

存量非专利面工具（memory / task 之外）以带理由的豁免过渡，理由统一指向 #713 记账。

## Alternatives considered

- **只在专利 domain 上启用严格检查** — 注册表规则会留下同类漏洞，下一批工具继续复制空壳。
- **一次性补齐全部存量工具 schema** — 范围会从专利审计扩散到 memory/task/read_file 等领域，且这些工具的成功返回形态需要单独设计。
- **保持豁免静默** — 豁免会变成永久免检标签；要求非空理由并在 backlog 记账，才能被审计。
- **把 `patent_workflow` 直接改成非只读** — 无 `caseId` 时确实不写盘，全部改为非只读会让正常收口调用多一次审批。

## Consequences

新工具无法再用空 properties 绕过契约门；存量豁免有书面理由但仍是待还债务。`patent_workflow` 传 `caseId` 时在默认模式下会触发审批，这是与真实副作用一致的代价。输出 schema 不进入 `toolSchemaDigest`，llm-replay 不受影响。
