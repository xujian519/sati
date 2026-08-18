# 专利撰写 SOP 可执行化优化计划（patent-drafting-sop-plan）

> 状态：草案（待批准）
> 关联：`assets/workflows/patent/prosecution-draft.yaml`、`assets/prompts/patent/cap01-orchestrator.md`、
> `src/patent/workflow/manifests.ts`、`src/patent/atoms/handlers/builtin/`、`src/patent/worker-contract.ts`

## 1. 背景（审计结论）

对"申请撰写流程"的代码级审计发现：单点工具链完整可运行，但编排 SOP 层存在纸面与代码脱节：

| # | 断层 | 证据 |
|---|------|------|
| F1 | `prosecution-draft.yaml`（撰写 SOP）**零代码消费**，schema 与 `WorkflowManifest` 不兼容 | 全仓 grep `prosecution-draft` 在 src/ 零匹配；yaml 字段（worker/has_checkpoint/depends_on）vs manifest 字段（id/stages[].strategy/atom） |
| F2 | 7 个内置 manifest 全是分析/答复类，**无撰写全链路 manifest** | `manifests.ts`：disclosure 只有 draft-claims 原子；patentability 的 draft 阶段"原子路径不支持，收口模式" |
| F3 | YAML 引用的 12 个 worker 七成未注册 | `defaultPatentWorkers()` 仅 6 个；project-probe/rule-explorer/patent-search-planner/patent-search-executor/bcip-retrieval/patent-slop-cleaner/provision-disclosure 均无注册 |
| F4 | CAP01 手册引用 6 个**不存在的工具** | `plan_workflow`/`list_workers`/`suggest_checkers`/`run_checker_review`/`run_patent_rules`/`list_checkers` 在 src/ui 零匹配 |
| F5 | subagent_type 命名双轨且 fail-closed | 手册下划线（technical_analyzer/novelty_checker/…）vs 注册 kebab（patent-analyzer/patent-novelty-checker/…）；`agent.ts:337` 未注册即抛 `Unknown subagent_type`，`normalizeRequestedSubagentType` 无别名映射 |
| F6 | worker 契约系统半接线 | `WorkerRegistry`/`validateWorkerOutput`/`WorkerMonitor` 唯一消费方是手动工具 `patent_worker_validate`；`runWorkflow` 不自动校验 |
| F7 | 质量门槛靠 prompt 自觉 | 检索 ≥3 篇/全文标注、slop 总分<35 均无确定性 gate 原子 |
| F8 | manifest 路径 HITL 中断无断点续跑 | `patent_workflow_run` 注释明示"再次调用会从零重跑全部阶段" |

## 2. 目标

1. **让撰写 SOP 可引擎执行**：新增内置 `patent_drafting_v1` manifest，`patent_workflow_run(manifestId=patent_drafting_v1)` 一键跑完整撰写链路（解构→检索→对比→充分公开→权利要求→说明书→校验→反套话→规则门）。
2. **消除纸面与代码漂移**：手册引用的工具/角色/worker 全部真实存在或修订手册；静态检查防回潮。
3. **质量门槛硬性化**：检索质量、反套话评分、规则门全部确定性 gate 原子化。
4. **契约强制化**：worker 输入/输出契约接入执行引擎自动校验。

## 3. 任务清单（按迭代分组）

### 迭代一：核心撰写链路可执行（P0-1）

#### T1 — 新增 `draft-spec` 原子（说明书撰写 + 确定性校验）
- **改动文件**：`src/patent/atoms/handlers/builtin/draft.ts`（扩展）、`src/patent/atoms/handlers/builtin/index.ts`（注册）
- **实现要点**（镜像 `draft-claims` 原子结构）：
  - `draftSpecAtom: Atom`，category: `extract`，inputSchema: `["claims_draft", "pfe_triples", "merge_result", "distinctive_features", "source_text"]`，outputSchema: `["spec_draft", "spec_validation"]`
  - `DraftSpecHandler`：LLM 按 `specification-writing-v1.md` 规范撰写七部分（名称/技术领域/背景技术/发明内容/附图说明/具体实施方式/摘要）→ **内部调用确定性校验**（复用 `src/patent/spec/checks.ts` 的 checkEffectQuantification/checkNumericRangeCoverage + 章节完整性正则，与 `validate_specification` 同一纯函数层）→ 校验报告写入 `spec_validation`
  - 缺失 provider 时 `requireLlm` 降级；输入为空时 `degraded`
- **测试**：`tests/patent/atoms.spec.ts` 追加（或新建 `tests/patent/draft-spec-atom.spec.ts`）——mock provider 断言 LLM prompt 含七部分要求、校验报告结构

#### T2 — 新增 `quality-gate` 原子（检索质量门槛，确定性）
- **改动文件**：`src/patent/atoms/handlers/builtin/gate.ts`（扩展）、`index.ts`（注册）
- **实现要点**：
  - `qualityGateAtom: Atom`，category: `gate`，inputSchema: `["prior_art", "search_results"]`，outputSchema: `["quality_report"]`
  - 纯函数 `checkSearchQuality(text): { passed: boolean; failures: string[] }` 确定性校验：对比文件条数 ≥3（按专利号/公开日正则提取计数）、每篇含相关度标注（X/Y/A）、全文标注 ≥2 篇、检索式含布尔逻辑（AND/OR）与 IPC 限定
  - 不通过 → 返回校验报告（不抛中断，由后续 `approval-gate` 挂 HITL 决策"退回重做"）；通过 → 占位输出
  - 纯函数下沉至 `src/patent/spec/` 同层（如 `src/patent/quality/`）便于单测，gate.ts 引用
- **测试**：纯函数单测（达标/缺全文/缺 IPC 三态）+ 原子集成

#### T3 — 新增 `slop-gate` 原子（反套话评分门，确定性）
- **改动文件**：`src/patent/atoms/handlers/builtin/gate.ts`（扩展）、`index.ts`（注册）
- **实现要点**：
  - `slopGateAtom: Atom`，category: `gate`，inputSchema: `["report_text"]`，outputSchema: `["slop_report", "slop_score"]`
  - 复用 `src/patent/slop-engine.ts` 的 `analyzeSlop`/`scoreDocument`：5 维评分总分 <35 → 输出 `needs_revision` 报告 + 变更清单（等同 prosecution-draft.yaml step 11 语义）
  - 不抛中断；由主代理或后续 approval-gate 决策
- **测试**：复用 slop-engine 既有 fixture，断言 gate 输出结构

#### T4 — 新增内置 manifest `patent_drafting_v1`（核心交付）
- **改动文件**：`src/patent/workflow/manifests.ts`（+builtinPatentManifests 目录项）
- **阶段映射**（prosecution-draft.yaml 12 步 → manifest stages；无原子阶段沿用"透传输入"语义，与 disclosure 的 preprocess 一致）：

| # | stage id | 原子 | 说明 |
|---|----------|------|------|
| 1 | `preprocess` | — | 透传交底书全文（probe+rules 由主代理预置，YAML step 1-2 并入） |
| 2 | `extract_problem` / `extract_features` / `extract_effects` | `extract` | PFE 三路提取（复用 disclosure 参数） |
| 3 | `merge` | `merge` | PFE 融合 |
| 4 | `groundedness` | `groundedness` | 原文依据过滤 |
| 5 | `consistency` | — | PFE 一致性（retry rewindTo extract_problem，maxRetries 1） |
| 6 | `deconstruct_approval` | `approval-gate` | HITL：确认七维解构与核心特征（YAML step 3） |
| 7 | `figure` / `chemistry` | — | 无原子透传：主代理先行调用 `analyze_patent_figure`/`recognize_chemical_structure` 并写入阶段文本（YAML step 4-5；图片通道不在 StageProvider 契约内，首版保持主代理工具完成） |
| 8 | `generate_keywords` / `search` | `keywords` / `search` | 检索执行（YAML step 6-7） |
| 9 | `search_quality` | `quality-gate`（T2） | 门槛校验（YAML step 8） |
| 10 | `search_approval` | `approval-gate` | HITL：确认对比文件列表 |
| 11 | `prior_art_compare` | `compare` | 现有技术 CAP02 对比（复用 compare 原子，prompt 注入 distinctive-features 输出要求）（YAML step 9） |
| 12 | `compare_approval` | `approval-gate` | HITL：确认区别特征 |
| 13 | `disclosure` | `llm` 原子（新 `provision-disclosure` handler 或复用 reason） | 充分公开审查 + 撰写建议（YAML step 10） |
| 14 | `disclosure_approval` | `approval-gate` | HITL：审核充分公开与撰写建议 |
| 15 | `draft_claims` | `draft-claims`（复用） | 权利要求草稿 |
| 16 | `draft_spec` | `draft-spec`（T1） | 说明书草稿 + 确定性校验 |
| 17 | `slop_clean` | `slop-gate`（T3） | 反套话润色报告（YAML step 11） |
| 18 | `rule_gate` | 确定性规则门 | 复用 `runRuleGate` 语义：`RuleEngine` + `defaultPatentRules` 评估（域 `patent_disclosure,patent_claims`）（YAML step 12） |
| 19 | `final_approval` | `approval-gate` | HITL：定稿确认 |

  - `validation: { requireAllSteps: true, maxRetries: 2 }`；checkDomains: `["patent_disclosure", "patent_claims"]`
- **测试**：`tests/patent/` 新增 manifest 结构测试（validateWorkflowManifest 通过、阶段依赖完整、原子均可 lookup）+ 复用 `flexible-plan-atomic.spec.ts` 模式做一次 provider mock 全链路跑通测试
- **文档**：更新 `src/patent/workflow/README.md` 与 cap01 意图路由表

> ✅ **迭代一完成记录（2026-08）**：T1-T4 全部落地（PR 见 git 历史）。实现偏差（均为简化/增强，无语义回退）：
> 1. T1 `draft-spec` 输入键用 `novelty_conclusion`（衔接 novelty 原子输出）替代计划的 `distinctive_features`；校验纯函数 `validateDraftSpec` 导出供单测；章节完整性纯函数 `checkSectionCompleteness` 下沉至 `src/patent/spec/checks.ts`（与 validate_specification 同层）。
> 2. T2 `quality-gate` 输入键为 `["search_summary", "prior_art"]`（prior_art 数组序列化为"对比文件 N"条目）；纯函数 `checkSearchQuality` 落地 `src/patent/quality/`（新模块）。
> 3. T4 实际 22 阶段：`figure`/`chemistry` 独立两阶段（无原子透传）；`consistency` 用 `reasoning` 原子（含 retry rewindTo）；`prior_art_compare` 用 `novelty` 原子（输出 `novelty_conclusion` 直接衔接 draft-claims/draft-spec）；`disclosure` 用 `reasoning` 原子（params.reasoning_prompt 注入充分公开审查指令）。
> 4. `rule_gate` **不设阶段**：消费方 `patent_workflow` / `patent_workflow_run` 在收尾时已按 `builtinPatentManifests` 的 checkDomains 自动运行确定性规则门（runRuleGate），避免双跑。
> 5. 新发现：`patent_workflow_run` 已支持 `approveStageIds`（manifest 模式审批门批准后重跑放行）——T10 的审批侧能力已存在，迭代三仅需补 checkpoint 续跑。
> 6. 测试：`tests/patent/drafting-sop.spec.ts` 17 用例（原子契约/行为/纯函数三态/manifest 结构/全链路跑通至审批门中断/审批门放行推进）；`atoms.spec.ts` 原子名单断言 11→14。

### 迭代二：一致性治理（P0-2 / P0-3）

#### T5 — subagent_type 别名映射
- **改动文件**：`src/tool/builtin/agent.ts`（`normalizeRequestedSubagentType`）
- **实现要点**：加入手册名→注册名映射表：`technical_analyzer→patent-analyzer`、`novelty_checker→patent-novelty-checker`、`creativity_checker→patent-creativity-checker`、`infringement_checker→patent-infringement-checker`、`invalidity_checker→patent-invalidity-checker`、`retriever→patent-retriever`、`quality_checker→patent-quality-checker`、`reviewer→patent-reviewer`。映射表带注释"与 cap01-orchestrator.md §3.5 同步"。
- **测试**：`tests/tool/`（或 agent 既有测试）追加别名解析断言；`patent_orchestrator` 无角色注册问题记录到 T8 一并处理

#### T6 — SOP 引用静态检查脚本（防回潮门禁）
- **改动文件**：新建 `scripts/check-patent-sop-references.mjs`；根 `package.json`（`check:patent-sop`）或挂 `pnpm lint`
- **实现要点**（仿 `scripts/check-ui-server-boundary.mjs` 范式，纯文本静态校验）：
  - 数据源：① `assets/prompts/patent/cap01-orchestrator.md`（§3.1-3.6 工具/worker/subagent_type 表）；② `assets/workflows/patent/*.yaml`（worker: 字段）；③ `src/patent/worker-contract.ts`（defaultPatentWorkers）；④ `src/agent/sub/builtinSubagentTypes.ts` + `skills/*/SKILL.md`（type: role 注册名）
  - 校验：yaml/手册引用的 worker ∈ defaultPatentWorkers ∪ skills 角色名 ∪ 白名单；手册引用的工具 ∈ createBuiltinRegistry 注册名 ∪ 白名单；subagent_type ∈ 内置 4 个 ∪ 角色注册名 ∪ 别名映射
  - 白名单段（有意保留的文档性引用，如 `patent_orchestrator`、`bcip-retrieval`、`markitdown`），缺失输出清单 exit 1
- **测试**：脚本自检（临时破坏一个引用 → 报错）

#### T7 — CAP01 手册修订（幽灵工具与命名对齐）
- **改动文件**：`assets/prompts/patent/cap01-orchestrator.md`
- **实现要点**：
  - §2/§6/§8：`plan_workflow`→`flexible_plan`/`patent_plan_task`；`list_workers`→真实等价物（`patent_worker_validate` 或注明"worker 目录见 src/patent/worker-contract.ts"）；`run_patent_rules`→`rule_check`(scope=pack) / `patent_workflow` 收口规则门；`suggest_checkers`/`run_checker_review`/`list_checkers`→`patent_eval` + `patent-unified-eval` 技能（或标注"规划中"）
  - §3.5 subagent_type 表 → kebab 真实注册名 + 别名说明
  - §3.1-3.2 worker 表 → 标注哪些已注册（defaultPatentWorkers）、哪些规划补齐（T8）
- **验证**：T6 脚本对修订后手册零缺失

> ✅ **迭代二完成记录（2026-08）**：T5-T7 全部落地。实现偏差/补充：
> 1. T5 别名映射表落 `src/tool/builtin/agent.ts` 的 `SUBAGENT_TYPE_ALIASES`（8 条），`normalizeRequestedSubagentType` 命中即转换；测试 `agent-subagent-type.spec.ts` 追加 8 组映射断言 + 未知类型 fail-closed 断言。
> 2. T6 脚本实际校验 5 类引用：工具名（builtin + law-search-tool）、subagent_type（内置 4 + skills type:role + 别名键）、worker（defaultPatentWorkers）、**manifest id**（manifests.ts `patent_*_vN`）、**原子名**（atoms/handlers/builtin 的 name，允许连字符）——manifest/原子两类是脚本开发中补加的权威清单；挂根 lint（`check:patent-sop`）；负向测试（注入幽灵引用 → exit 1）通过。
> 3. T7 修订 10+ 处：§2 路由表加 manifestId 列（撰写→`patent_drafting_v1`）；§3.1 worker 表标注注册状态；§3.5 改 kebab + 别名说明；§6/§7/§8/§10 幽灵工具全部替换（`plan_workflow`→`patent_workflow_run`/`flexible_plan`、`list_workers`→worker 契约目录、`suggest_checkers`/`run_checker_review`/`list_checkers`→`patent_eval`+HITL、`run_patent_rules`→`rule_check(scope=pack)`、`tool_search`→`mcp_status`/`list_mcp_resources`、`read/edit/write`→`read_file/edit_file/write_file`）；白名单幽灵条目已移除（手册不再引用即门禁生效）。
> 4. 顺手修复：`tests/skills/patent-roles.spec.ts` 的 `SKILLS_ROOT` 路径 bug（`../../../skills` 指向仓库外 → `../../skills`），18 个原本 ENOENT 失败的测试转绿。

### 迭代三：完整性（P1）

#### T8 — 补齐 provision-* 撰写角色 SKILL.md
- **改动文件**：新建 `skills/provision-disclosure/SKILL.md`（P-A05 充分公开）、`skills/provision-drafting-claims/SKILL.md`（P-D01）、`skills/provision-drafting-spec/SKILL.md`（P-D02）；`src/patent/worker-contract.ts`（WORKER_ROLE_MAP 增补）
- **实现要点**：`type: role` frontmatter（tools: ["*"] 或裁剪、domains: ["patent","drafting","quality"]、readOnly: false、systemPrompt 引用 cap00 契约 + cap09 输出规范）；角色与 `prosecution-draft.yaml` worker 名一致，供 orchestrator 直接调度
- **验证**：`pnpm lint`（SKILL.md 检查）+ 冒烟 `agent(subagent_type="provision-disclosure")` 可解析

#### T9 — worker 契约接入执行引擎（自动校验 + 监控）
- **改动文件**：`src/patent/workflow/types.ts`（WorkflowStage 增 `worker?: string`）、`src/patent/workflow/executor.ts`（runStageOnce 前后校验）、`src/patent/workflow.ts`（runWorkflow 装配 monitor）、`src/tool/builtin/patentWorkflowRunTool.ts`（透传 worker 契约校验结果到输出）
- **实现要点**：
  - runStageOnce 产出后：若 stage.worker 声明且命中 `defaultPatentWorkers()` → `validateWorkerOutput`（requiredFields 子串校验）→ 失败写 DegradationMark 到 stage（沿用 degraded 前缀语义，不中断）
  - runWorkflow 返回结果附 `workerValidation` 段（缺字段清单）；`WorkerMonitor.record` 真实运行记录
  - 新增 manifest 阶段声明 `worker` 字段（T4 的 19 阶段中 search/compare/disclosure 等映射 worker 名）
- **测试**：`tests/patent/` 新增契约校验接线测试（构造缺 requiredFields 的 mock handler → 断言 degraded 标记）

#### T10 — manifest 路径断点续跑
- **改动文件**：`src/patent/workflow.ts`（runWorkflow 增 checkpoint 选项）、`src/patent/workflow/executor.ts`（逐阶段 checkpoint 写）、`src/tool/builtin/patentWorkflowRunTool.ts`（暴露 `resumeCheckpointId`）
- **实现要点**：复用 `src/patent/graph` 的 `JsonFileCheckpointStore` 语义——每阶段完成即落盘 `{runId}.checkpoint.json`（stage id + 输出 + 已批准 gate 标记）；resume 时跳过已确认阶段、approval-gate 经 `APPROVAL_GRANTED_KEY` 放行（与图路径同契约，gate.ts 注释已预留）；HITL 中断后主代理重新调用即可续跑
- **测试**：`tests/patent/workflow-resume.spec.ts`——中断后 resume 断言前序阶段不重跑、审批门放行

### 迭代四：治理与验收（P2）

#### T11 — 单一数据源：YAML 工作流与 manifest 统一
- **改动文件**：`scripts/gen-patent-workflow-docs.ts`（新建）或 manifests.ts 注释
- **实现要点**：以 `builtinPatentManifests` 为单一真相，**生成** `assets/workflows/patent/*.yaml` 文档（保持人读资产）；`prosecution-draft.yaml` 标记为"由 patent_drafting_v1 生成/同步，直接编辑无效"，杜绝双真相漂移。不做运行时 YAML 加载器（避免运行时 yaml 依赖 + schema 转换复杂度，收益低）
- **验证**：脚本幂等（再生成 diff 为空）

#### T12 — 端到端验收（llm-replay fixture）
- **改动文件**：`tests/patent/drafting-sop-replay.spec.ts`（新建）；`scripts/record-llm-replay.ts` 录制
- **实现要点**：按 `src/test-support/llm-replay/` 流程录制 `patent_drafting_v1` 全链路真实会话 → fixture 入库 → CI 无 key 重放断言完整跑通（含审批门中断点）；使"撰写流程可运行"成为 CI 断言
- **验证**：`pnpm record:replay` + `pnpm test`（llm-replay-real.spec.ts 模式）

## 4. 实施顺序与依赖

```
迭代一（T1→T2→T3→T4）    ← 核心价值，零件全部复用现有基建
   ↓
迭代二（T5→T6→T7）        ← 一致性；T6 脚本对 T7 修订做回归
   ↓
迭代三（T8→T9→T10）       ← 完整性；T9 依赖 T4 的 worker 字段
   ↓
迭代四（T11→T12）         ← 治理与验收；T12 依赖迭代一完成
```

每迭代结束：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` + 事件矩阵门禁（若事件面改动 `pnpm gen:event-matrix`）。

## 5. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| R1：figure/chemistry 阶段无图片通道，无法原子化 | 全自动链路不完整 | 首版混合模式（无原子透传，主代理工具完成）；StageProvider 图片通道列入后续演进 |
| R2：19 阶段 manifest 单次运行 LLM 成本高 | 费用/时长 | 复用 `modelHint` 模型分层（cheap/strong）；approval-gate 分阶段 HITL 天然分批 |
| R3：T10 未完成前 HITL 中断重跑全链 | 体验差 | 迭代三明确排期；此前文档声明限制 |
| R4：静态检查误报（手册非代码措辞） | 门禁噪音 | 白名单段 + 只解析表格/代码块内的引用 |
| R5：T4 阶段映射偏离原 YAML 语义 | SOP 行为变化 | 每阶段注释标注对应 YAML step；验收对照原 12 步 checklist |

## 6. 验收标准（完成定义）

1. `patent_workflow_run(manifestId=patent_drafting_v1)` 在 mock provider 下全链路跑通（tests/patent/ 断言）。
2. T6 脚本对修订后手册零缺失；任意引入幽灵引用 CI 变红。
3. `agent(subagent_type="technical_analyzer")` 等手册名可调度（别名生效）。
4. 撰写链路产出经 `draft-spec` 校验报告 + `slop-gate` 评分 + `rule-gate` 判定（确定性三段门）。
5. llm-replay fixture 在 CI 无 key 重放通过。
