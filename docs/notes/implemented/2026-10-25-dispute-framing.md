# Agent Note: OA / 无效 / 侵权三场景先定争点再 parse

Status: implemented

## Problem

OA 答复、无效、侵权三个场景原先都是「全量 parse → 再定争点」：解析阶段把与争议无关的事实一起展开，主代理随后才在报告里收窄。顺序反了，既浪费上下文，也让下游的规则校验缺少「争议边界」这一输入。Sati 没有独立的争点粗定位阶段；`patent_inventiveness_v1` 的 `domain_inject` 解决的是领域注入，不是对手主张的边界。

## Decision

**只给三场景**

- `patent_oa_response_v1`、`patent_invalidation_v1`、`patent_infringement_v1` 在 `parse` 前插入 `dispute_framing`（`strategy: "chain"`，无 atom）。
- `novelty` / `inventiveness` / `patentability` 不插：这些场景围绕「技术方案 vs 现有技术」展开，不围绕对方主张收窄提取面；为整齐统一加一层会制造无意义阶段并改变既有 SOP 计数。

**文本契约而非 atom**

- 新增 `src/patent/workflow/disputeFraming.ts`：阶段输出固定两段 `## dispute_grounds`（争议法条/理由）与 `## dispute_claims`（涉及权项），`parseDisputeFraming(text)` 解析为 `{ grounds, claims, unidentified }`。
- 无 atom 阶段的产出由主代理（`patent_workflow` 收口模式）或脚本化 executor 提供，没有 `outputSchema` 可挂；用文本分段可在不新增 atom、不改工具 schema 的前提下让下游确定性读取。
- 项目符号与编号都接受；`未识别` / `N/A` 等占位行不计为条目（避免把「没有争点」当成一条争点）。
- 两段都为空 ⇒ `unidentified: true`。下游提示与报告必须写「未识别争点」，不得写「无争点」——后者会被读成「已确认没有争点」，静默收窄提取面。

**parse 描述**

- 三场景 `parse` 描述改为「消费 dispute_framing 过滤；未识别时按全文解析并注明未识别争点」。
- OA 额外保留审查意见通知书的**程序理由全量解析**：程序缺陷不因争点范围被过滤掉。

**自动执行路径的显式降级**

- `patent_workflow_run` 的 manifest 模式对无 atom 阶段默认回显输入原文。对 `dispute_framing` 这会伪装成「已定争点」；改为输出 `renderUnidentifiedDisputeFraming()`（两段空标题 + `未识别争点`），让下游按全文解析且不静默。

## Alternatives considered

- **新增 `dispute-framing` atom** — 计划明确不新增 atom；原子契约需要 `outputSchema`，而这里真正要锁的是文本分段，建 atom 还要配套 handler/LLM 调用与注册，收益低于成本。
- **给所有 manifest 统一加一层** — 新颖性/创造性/撰写不是围绕对方主张展开的；统一加会让阶段数与 SOP 文档漂移，且产生永远不会被消费的输出。
- **在 `parse` 描述里内联要求「先想争点再解析」** — 没有落盘产物，下游无法核对是否真的收窄，也无法在报告中引用争点清单；两段文本让顺序与内容都可检查。
- **把 `unidentified` 写成空数组 + 下游自行判断** — 下游会把「空」误读为「无争点」；显式布尔 + 唯一合法措辞把语义钉住。
- **自动执行路径直接跳过该阶段** — 阶段顺序会与 manifest 契约不一致；显式「未识别」既保顺序又保诚实。

## Consequences

- 三场景 manifest 各多一个阶段；`pnpm gen:patent-workflow-docs` 生成物同步，`check:patent-workflow-docs` 覆盖漂移。
- 收口模式（`patent_workflow`）需为 `dispute_framing` 提供输出；缺省会进 `degradedSteps`（不静默）。
- 自动执行模式（`patent_workflow_run`）下该阶段固定输出「未识别争点」，`parse` 按全文解析：这是显式降级，不是争点识别。
- 无新增 atom、无工具 schema / AgentEvent / gateway / i18n 变更；无需重录 llm-replay。
