# 工作流族工具契约（patent-tool-contracts / workflow）

本分片覆盖 patent 域「工作流族」6 个工具：`patent_workflow_run` / `patent_workflow_assemble` /
`flexible_plan` / `patent_docket` / `patent_worker_validate` / `patent_candidate_rerank`。

工具 `description` 因提示面预算（TD-PATENT-N38：顶层 ≤200 字符、属性 description ≤60 字符）
只保留「做什么 + 硬约束 + 只读提示」；**口径、边界、失败模式、领域图清单、审批语义全部在本文件**。

---

## patent_workflow_run

**用途**：执行专利工作流——**manifest 路径**（按 `WorkflowManifest` 声明的阶段顺序跑；声明了
`atom` 的阶段由本工具注入 provider 自动执行：LLM 驱动 extract / merge / groundedness / reasoning /
keywords / novelty / draft-claims，nuo-patent 驱动 search；无 atom 的阶段如 preprocess / report 透传
输入文本）或**领域图路径**（`graph` 模式，跑 novelty / inventiveness / enablement / claim_breadth /
citation_check 子图：LLM + 检索 + 规则门）。两条路径互斥。

**关键入参**：
- `manifestId`：内置或自定义 manifest id（默认 `patent_disclosure_v1`）。
- `graph`：领域图 id —— `novelty`（A22.2 单独对比 + 数值范围）、`inventiveness`（A22.3 三步法）、
  `enablement`（A26.3 三步审查 + 化学/计算机领域规则，末端接 checker 规则门）、`claim_breadth`
  （`claimText`=权利要求、`input`=说明书）、`citation_check`；**与 `manifestId` 互斥**。
- `resumeCheckpointId`：从被中断（审批门挂起）的检查点续跑。
- `approveCheckpointId` / `approveStageIds`：放行审批门（图路径用前者，manifest 路径用后者）。
- `caseId`：运行时持久化键（运行与检查点落 `<caseDir>/workflow-runs/`）。
- `input` / `claimText` / `chartTargets`（`[{id,kind}]`，`kind` ∈ prior-art|product）/ `maxResults`
  （默认 5）/ `retrievalRounds`（默认 2，0 关闭）/ `judgeSamples`（>0 追加 0-1 参考分）/
  `judgeModels`（多 judge `modelHint` → 共识判定 + Verdict Envelope）。

**硬约束与失败模式**：
- **审批门会挂起运行**：门阶段抛 `InterruptStageError` → 返回 `interrupted`，后续阶段不再执行；
  **未放行则不续跑**。
- 断点续跑：manifest 路径需 `resumeCheckpointId` + `caseId`（**无 `caseId` 不可续跑**）；
  `approveStageIds`（如 `['review_gate']`）放行已批准的门；图路径用 `approveCheckpointId`。
- **需要模型客户端**（`context.model` 或注入的 `deps.model`）；无模型时 LLM 阶段不可用。
- 带 `caseId` 时运行与检查点持久化到 `<caseDir>/workflow-runs/`；持久化失败只提示（`persistWarning`）。
- 缺硬契约字段只标 `degraded`（不中断）；worker 校验结果挂在 `workerValidation`。
- `judgeModels` 路径：多 judge 并行投票（失败票 fail-open）→ 共识（中位数 + 极差分歧检测，
  spread>0.25 判 disagree 供 HITL）→ Verdict Envelope（typed verdict 审计 + sha256 内容哈希）；
  `judgeSamples` 单模型路径保留（向后兼容）。

**口径与依据**：审查指南第二部分第四章（新颖性 A22.2 / 创造性 A22.3 / 充分公开 A26.3）对应的
三性领域子图与门禁；评估门三级化（机械规则门层 → 语义票层 → 共识层，overall 保守序
blocked > disagree > needs_revision > pass）。

**内置 manifest 目录（8 个，`formatManifestCatalog()` 动态生成，描述里保留全量 id）**：

| manifest id | caseType | 收口规则门检查域 | 用途 |
| --- | --- | --- | --- |
| `patent_novelty_v1` | novelty_search | patent_novelty | 新颖性检索分析（解析→关键词→检索→对比→结论→人工确认） |
| `patent_disclosure_v1` | disclosure_analysis | patent_disclosure, patent_claims | 交底书披露分析（PFE 提取→检索→逐特征初判→报告→复核→权要布局→权要草稿） |
| `patent_inventiveness_v1` | inventiveness_analysis | patent_inventiveness | 创造性三步法（时间基准→最接近现有技术→三步法 Step1-3→辅助因素→人工确认） |
| `patent_patentability_v1` | novelty_search | patent_novelty | 可专利性（解析→要素级映射→权要布局→人工确认） |
| `patent_oa_response_v1` | oa_response | patent_claims, patent_inventiveness | 审查意见答复（要素映射→理由识别→意见陈述草稿→人工确认） |
| `patent_invalidation_v1` | invalidation_analysis | patent_invalidation, patent_novelty, patent_inventiveness | 无效分析（只用请求人指定证据，不自行检索） |
| `patent_infringement_v1` | infringement_analysis | patent_infringement | 侵权比对（全面覆盖 + 等同 + 现有技术抗辩） |
| `patent_drafting_v1` | drafting | patent_disclosure, patent_claims | 申请撰写 SOP（29 阶段：清晰度准入门→PFE→HITL 解构→检索→充分公开→权要→说明书→定稿） |

**边界**：不消费主代理已产出的阶段文本做收口（那是 `patent_workflow_assemble`）；不管理案卷轮次与
缺口（那是 `patent_docket`）；不写文书（那是 `render_patent_document`）。

---

## patent_workflow_assemble

**用途**：**收口语义**——主代理已按 manifest 各阶段产出文本，传入本工具做结果组装、完整性校验
（缺阶段标 `degraded`）、确定性规则门判定与摘要；**确定性执行，无 LLM 调用**（本工具传空
`StageHandlerRegistry`，禁用原子执行）。

**关键入参**：
- `manifestId`：workflow manifest id（默认内置目录首个 `patent_novelty_v1`）。
- `outputs`：按 `stageId` 给出各阶段文本；**缺失的阶段标 `degraded`**（不中断）。
- `caseId`：结果记录与审计键；给了就持久化到
  `<caseDir>/workflow-runs/<caseId>__<manifestId>.json`（并补写 `.mmd`），失败仅提示。
- `checkDomain`：逗号分隔的规则门检查域，**覆盖 manifest 设定**；**空字符串关闭规则门**。

**硬约束与失败模式**：
- 未知 `manifestId` → 返回可用 manifest 清单的提示文本（不抛错）。
- manifest 结构校验失败 → 返回校验失败信息（不执行）。
- **只读性随入参变化**：`isReadOnly = !caseId`——不给 `caseId` 是只读工具；给 `caseId` 会写文件，
  因此不能声明为只读（否则会绕过写审批）。
- 规则门对**全部非降级阶段产出拼接文本**评估；`runRuleGate` 无可评估产出时 **fail-explicit**
  报「无可评估产出」，不假装通过。
- 别名：`patent_workflow`（旧名，保留一个版本）、`run_patent_workflow`、`PatentWorkflow`。

**口径与依据**：dual-track 确定性规则门（`src/patent/checker`）：按内置 manifest 目录条目读取
检查域（`defaultPatentRules`），判级 `pass` / `needs_revision` / `blocked` 与失败明细拼入输出，
供主代理据此修订或放行；自定义 manifest 不在目录内且未显式给 `checkDomain` 时**不跑规则门**
（fail-open，已在文档声明）。

**边界**：不执行原子（handler 内部调 LLM/检索）——需要原子自动执行时用 `patent_workflow_run`；
不做 HITL 轮次与缺口管理——用 `patent_docket`；不渲染文书。

---

## flexible_plan

**用途**：**阶段级 HITL 计划**——create 建计划（可选 IPC 技术领域推断）→ run 把未确认阶段经
`toManifest()` 交 `runWorkflow` 原子执行（provider 装配与 `patent_workflow_run` 共享
`buildWorkflowProvider`：LLM + nuo-patent 检索）→ confirm / rollback 逐阶段确认或回退重做；
add / remove / reorder 运行时增删改阶段；complete / abandon 收尾。

**关键入参**：
- `action`：`create` / `get` / `run` / `confirm` / `rollback` / `add` / `remove` / `reorder` /
  `complete` / `abandon`（+ 旧 `patent_plan_task` 的 `transition` / `sync` / `replan`，
  **无状态、无需 caseId**）。
- `caseId`：计划主键，**除旧动作外全部必需**（计划按此键持久化）。
- `caseType` / `inputText`（create 持久化、run 可覆盖）/ `technicalField`（显式领域，缺省由
  `inputText` 推断 IPC 领域）/ `stages` / `stage` / `stageId` / `stageIds` / `reason`（abandon 审计）
  / `maxResults`（默认 5）/ `autoConfirm`。
- 阶段字段：`strategy`（`chain` | `react` | `sub_agent`）、`atom`（声明后 run 时交原子执行）、
  `params`（传给 StageHandler 的静态参数）、`artifacts`、`constraintIds`（规则约束 id）、
  `articleJudgments`（法条判定 `ArticleJudgment.articleId`）。

**硬约束与失败模式**：
- **run 只执行未确认阶段**（`pending` 待执行 + `rolled_back` 待重做）；`confirmed` 不重复执行，
  未确认阶段下次 run 会重新执行。
- `autoConfirm=true` → run 结束自动确认全部成功（非降级）阶段。
- rollback：目标阶段及其后已确认阶段置 `rolled_back`（审计保留），目标之前已确认保留，
  `pending` 保持；回滚后的阶段不再接收新的法条判定。
- complete：全部 `pending` 置 `confirmed`；abandon：`pending` 置 `rolled_back`（已确认保留审计），
  记录原因。
- 计划持久化于 `<caseDir>/workflow-runs/flexible-plans/`；跨调用状态由工具自身管理
  （区别于 `patent_plan_task` 的无状态透传）。
- **清晰度准入门用法要点**：撰写场景在解构前声明 `{id:'clarity_gate',atom:'clarity-gate'}`，
  清晰度不足时按清晰度暂停（人工决策：确认继续 / 补充交底书 / 退回）；force 放行走
  `approveStageIds`。

**口径与依据**：`clarity-gate` 原子——四维（问题 0.25 / 方案 0.30 / 效果 0.25 / 实施 0.20）语义
打分与 0/1 结构信号按 0.75 / 0.25 融合，Ambiguity = 1 − Σ(×权重)，门槛 0.2；未过经
`InterruptStageError` 挂 HITL；**LLM 不可用退化为纯机械分（semanticOnly + fail-open，不中断）**。

**边界**：只管阶段生命周期与确认/回退；案卷轮次、缺口清单与定稿门控由 `patent_docket` 管；
阶段执行细节（LLM 原子）由 `patent_workflow_run` 的 provider 装配承担。

---

## patent_docket

**用途**：**案卷级迭代循环的轮次控制**——create 立案（缺口清单可同步登记）→ set_gaps 维护缺口
→ triage 分诊派工 → record_revision 记一轮修订 → finalize 定稿 → abandon 放弃。

**关键入参**：
- `action`：`create` / `get` / `list` / `set_gaps` / `triage` / `record_revision` / `finalize` /
  `abandon`。
- `caseId`：案卷主键（`list` 除外必需）；`caseType`（create 必需）；`maxRounds`（修订轮次上限，
  默认 3）；`linkedPlanCaseId`（关联 `flexible_plan` 计划 caseId，缺省同案卷 id）；`notes`
  （案件/定稿备注）；`gaps`（缺口清单：`id` / `question` / `source`）；`answered`（本轮回答的缺口
  id 或问题原文）；`artifacts`（本轮归档产物 `{name,path}`，path 相对 cwd 读文件）；`reason`
  （abandon 原因，审计留痕）。

**硬约束与失败模式**：
- **finalize 在仍有 gap 时拒绝**（fail-closed）：未决缺口全部解决后才可定稿。
- `record_revision` 需 `answered`；**轮次上限强制**（默认 3），超限不再自动修订。
- 阶段产物经 `archiveRevision` 另存 `revisions/round-N/` 留档，**旧稿不动**；`answered` 匹配的
  缺口置 `resolved`（保留审计）。
- `set_gaps` 需非空 `gaps`；**同 id 重开**，未提到的缺口保持原状态。
- triage 四种派工：`draft`（刚立案未登记缺口）/ `revise`（第 N 轮，派工修订）/
  `finalize_ready`（缺口已全解决）/ `escalate_human`（**轮次已达上限且仍有未决缺口 → 升级人工，
  不得继续自动修订**）。
- `abandon` 需 `reason`（审计留痕）；案卷按 `caseId` 持久化于 `<cwd>/data/cases/dockets/`
  （案卷 JSON 与 `revisions/` 归档同根，`list` 能扫到全部案卷）。
- 非法操作抛 `DocketError`（fail-closed），工具层转文本提示。

**口径与依据**：缺口问题来源（检索缺证据 / 交底缺参数 / 审查意见质疑……）；修订轮次上限默认 3
（竞品同款经验值：缺口最多改 N 轮，超轮升级人工）；案卷状态与 flexible-plan 分层——本层管
**案卷轮次**，flexible-plan 管**阶段生命周期**。

**边界**：只管案卷状态与轮次强制；**阶段执行本身走 `flexible_plan`**（run / confirm / rollback
回流，rollback 后重新 run 成功即「新一轮修订」的触发点）。

---

## patent_worker_validate

**用途**：按内置 Worker 契约（`defaultPatentWorkers`）校验 worker 输出中的 `requiredFields`
——契约级质量复核，确定性执行。

**关键入参**：
- `workerName`：内置 worker 目录（7 个）——`patent-technical-analyzer` /
  `patent-search-commander` / `patent-novelty-analyzer` / `patent-inventiveness-analyzer` /
  `patent-oa-writer` / `patent-adversary-reviewer` / `quality_checker`。
- `outputText`：待校验的 worker 输出文本。

**硬约束与失败模式**：
- **缺硬契约字段只标 degraded，不中断**（返回缺失字段清单与 pass / degraded 判定，不抛错）。
- `requiredFields` 以**子串形式**匹配输出文本。
- 未知 `workerName` → 返回可用 worker 清单的提示文本（非异常）。
- **只读**工具。

**口径与依据**：硬性 `requiredFields` 示例——技术问题 / 技术特征 / 技术效果（technical-analyzer）、
检索式 / 对比文件 / 公开日（search-commander）、新颖性结论 / 置信度（novelty-analyzer）、
主张 / 前提 / 脆弱点 / 反驳钩子 / factRef / articleRef（adversary-reviewer）、
质量评分 / 通过（quality_checker）。

**边界**：不生成内容、不改写产物、不判断法律结论——只判定契约字段是否齐备。

---

## patent_candidate_rerank

**用途**：对专利 / 文献**检索候选做 LLM 摘要精排**——一次批量调用给每条候选打相关性档位并给出
中文判定理由，替代人工逐条初筛（查新 / 无效证据收集的「筛选与排序」步骤，对齐
patent-prior-art-search 第三步的高 / 中 / 低相关分档）。

**关键入参**：
- `query`：技术方案描述（相关性判定基准）。
- `candidates`：`id`（公开号 / URL / 本地 id，候选内唯一）/ `title` / `snippet`（摘要或片段，
  ~400 字符）/ `publicationDate`（ISO，用于时间有效性语境）。
- `topK`：返回条数上限（可选，缺省返回全部含档位）。

**硬约束与失败模式**：
- **最多 20 条参与精排**（`MAX_RERANK_CANDIDATES`），超出按**未评级置尾**，
  `truncatedCount` 透出。
- 档位语义：`3` = 高相关（>80%）、`2` = 中相关（50-80%）、`1` = 低相关、`0` = 无关。
- **模型不可用或解析失败时降级返回原序**（`degraded=true`，`degradeReason` 给出原因），
  **不阻断检索流程**。
- **只读**工具；**只输出排序与档位，不改变候选集合**。

**口径与依据**：补 cross-encoder rerank 端点（需外部部署）之外的**零配置精排通道**；
高档位对齐检索实务中的「值得精读」分档。

**边界**：不做检索本身（检索由 `patent_search` / 检索技能负责）；不出新颖性 / 创造性法律结论；
不改写或扩充候选集合。
