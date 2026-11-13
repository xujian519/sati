# 专利工具契约档案（patent-tool-contracts）

本目录是 **patent 域 32 个工具的详细契约**：用途、关键入参、硬约束与失败模式、口径与依据、边界。

## 为什么工具描述里没有这些细节

工具的 `description` 是**模型必读的提示面**，有硬性长度预算（仓库 R-06 门禁：patent 域
`description + inputSchema` 合计 ≤ 43 000；单工具顶层描述 ≤ 300；单个属性描述 ≤ 60；
且顶层描述**不得为空**）。
把完整口径塞进描述会让提示面膨胀、挤掉其它工具的可用预算，也让描述本身变成难扫的长文。

⇒ 分层：**描述只留「做什么 + 硬约束 + 失败模式」**（模型据此就能判断能不能用、失败会怎样）；
**完整口径下沉到本目录**（人查、模型按需检索）。

## 什么时候读

当你要用某个工具、但描述不足以判断以下任一问题时，按工具名查对应分片：

- 这个工具**适用与不适用**的边界在哪；
- 某个入参的**取值域、默认值与联动规则**；
- 失败时**会返回什么**（fail / warn / 降级 / pending）——⚠️ 本仓的失败形态很多是「**明确降级并说明**」而不是「抛错」；
- 结论的**法条/标准依据**（细则、审查指南、37 CFR、PCT Rule、GB/T）。

## 分片索引

| 分片 | 覆盖工具 |
|---|---|
| [figure.md](figure.md) | `patent_figure_generate` / `_check` / `_project` / `_annotate` / `_compare` / `_manifest` |
| [workflow.md](workflow.md) | `patent_workflow_run` / `patent_workflow_assemble` / `flexible_plan` / `patent_docket` / `patent_worker_validate` / `patent_candidate_rerank` |
| [search-verify.md](search-verify.md) | `patent_search` / `patent_metadata` / `patent_legal_status` / `patent_kg_query` / `patent_case_search` / `patent_wiki_search` / `patent_fees` / `patent_deadlines` / `evaluate_evidence` / `claim_chart_build` |
| [drafting-evidence.md](drafting-evidence.md) | `render_patent_document` / `patent_pdf_download` / `recognize_chemical_structure` / `validate_specification` / `knowledge_note_save` / `patent_eval` / `draft_claims` / `draft_specification` / `search_patent_figure` / `analyze_patent_figure` |

## 相关的制图规则（不在本目录）

附图本身的**法域规则**另见同目录上级的三份文档：`cn-drawing-rules.md`、`pct-drawing-rules.md`、
`uspto-drawing-rules.md`（细则第 20/21 条、审查指南一部一章 4.3/4.5.2/4.6、37 CFR 1.84、
PCT Rule 11、GB/T 4457.5 等）。
