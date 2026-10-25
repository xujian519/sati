# Agent Note: workflow run 记录规则包指纹

Status: implemented

## Problem

每条 workflow run 都无法回答「这一轮用的是哪版规则包」。`computeRulePackFingerprint()` 此前只服务 `rule_check(scope:"pack")` 的缓存失效，结果没有进 run 记录。规则包升级后（改 `rules/base` / `rules/domains/*` / 项目 overrides 任一文件）复核历史结论时，只能靠运行日期猜当时加载了什么；评测对比也缺少「同规则包」这一前提。图模式更彻底：run 只在 `workflow-runs/checkpoints/` 留状态，没有「跑了什么、完成到什么程度、用了哪版规则」的审计记录。

## Decision

**run 级快照（manifest 与 graph 同源）**

- 新增 `src/patent/workflow/rulePackInfo.ts` 的 `resolveRunRulePack({ manifestPath? })`：调 `computeRulePackFingerprint()` 取内容指纹（清单解析结果 + 各层规则文件 `文件名@mtime`，原样字符串，变化可直接定位到层），并读取项目清单显式声明的 `version`。
- `RulePackManifest` 增可选 `version`；`parseRulePackManifest` 仅在声明时输出该键。`version` 不进聚合：各层 `pack.yaml` 的版本彼此独立，拼一个「总版本」是臆造语义，缺失时留空。
- `WorkflowRunOptions` 增 `rulePackManifestPath?`（测试注入；缺省走 `.sati/rules.yaml` 约定）。它只影响 run 记录里的指纹，不改变实际加载/评估的规则集。
- `WorkflowRunResult` / `GraphRunResult` 增可选 `rulePack?: { fingerprint: string; version?: string }`。`runWorkflow` 在**执行开始**计算（本次 run 的所有阶段按同一版规则评估；执行期间文件再变不改写归属），随结果返回并由 `JsonFileWorkflowRunStore` 自动落盘。
- 指纹**每次 run 重新计算**，不复用模块级缓存：gateway 等长驻进程跨 run 存活，缓存会让后续 run 顶着旧指纹落盘。
- 旧 run JSON 无该字段仍可读（可选字段，无迁移）。

**图 run 摘要**

- 新增 `src/patent/graph/runSummary.ts`：`buildGraphRunSummary` + `writeGraphRunSummary`，写到 `<runsDir>/graph/<runId>.json`，含 `graph` / `runId` / `rulePack` / `completed` / `steps` / `degraded` / `revisions` / `interrupted?` / `error?`。
- 图 run 的 `runId` 为 `<caseKey>__graph-<graphId>`（manifest run 是 `<caseKey>__<manifestId>`），且放在独立 `graph/` 子目录：`JsonFileWorkflowRunStore.listIds()` 会把顶层每个 `.json` 直接 cast 成 `WorkflowRunResult`，摘要混在顶层会被当成 manifest run。
- 写入放在 `finally`：审批中断与异常路径同样落盘；异常路径记 `error`、`completed: false`。摘要写失败只改工具输出的提示行，不覆盖原始错误。

## Alternatives considered

- **写进 `provenance.db`** — 该库在 `knowledge/shared/schema-versions.ts` 里登记为 `source` 类、**不可重灌**，加列意味着不可逆的 schema 迁移；且 provenance 是节点级因果图，run 级快照塞进去会混淆两个粒度。run JSON 本来就是「一 run 一文件」的审计载体，随结果落盘成本更低、可直接 diff。
- **给 `WorkflowRunResult` 加 `rulePackVersion` 标量** — 版本号无法证明内容：改了规则文件但忘改版本时标量不变，恰好制造「看起来对账过」的假保证。指纹取文件系统实际状态，版本只作为清单声明的附加信息。
- **复用 `rule_check` 的模块级 pack 缓存** — 长驻进程会拿到旧值，正是本议题要消除的「规则升级后无法复核」。
- **图摘要写进同一个 `runsDir` 顶层** — 会被 `listRuns()` 当 manifest run 读出并在 cast 后缺字段；独立子目录 + `graph-` 前缀两层隔离。
- **图摘要只在正常完成时写** — 中断与异常恰是最需要「当时用的哪版规则」的场景。
- **把指纹塞进 `GraphState`** — state 会进检查点与下游节点提示，污染模型可见面；`GraphRunResult.rulePack` 是结果侧元数据。

## Consequences

- 任意新 run JSON（manifest）与图 run 摘要都带指纹；改任一层规则文件后，下一次 run 的指纹变化可定位到具体层与文件。
- `WorkflowRunResult` / `GraphRunResult` 各增一个可选字段（向后兼容），无 DB schema 变更、无迁移。
- `RulePackManifest` 新增可选 `version`；清单里声明版本会让指纹的 manifest 段变化（版本是清单内容的一部分）。
- 图模式每次带 `caseId` 的 run 多写一个小 JSON；摘要写失败在工具输出可见，不静默。
