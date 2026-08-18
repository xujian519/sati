# Changelog

本文件按版本记录 Sati 的重要变更。桌面端版本号（`release(desktop)`）与根 `package.json` 由 `scripts/bump-version.mjs` 同步维护。

## v0.1.3 - 2026-08-18

> **版本目标（2026-08-18）**：申请撰写 SOP 可执行化（`docs/patent-drafting-sop-plan.md` 四迭代，PR #112-#115）——`patent_drafting_v1` 撰写 manifest 一键执行（从技术交底书到权利要求书+说明书+校验报告），HITL 审批门断点续跑，worker 契约接入执行引擎，SOP 引用静态门禁与单一数据源治理，全链路确定性验收。

### Feat
- feat(patent): `patent_drafting_v1` 撰写 manifest（22 阶段，映射 `prosecution-draft.yaml` 12 步 SOP）——PFE 提取→HITL 确认解构→检索→检索质量门→逐特征对比→充分公开审查→`draft-claims`→`draft-spec`→反套话门→HITL 定稿；`patent_workflow_run(manifestId="patent_drafting_v1")` 一键执行，工具收尾自动跑确定性规则门
- feat(patent): 新原子 `draft-spec`（说明书七部分 LLM 撰写 + `validateDraftSpec` 确定性校验：章节完整性/效果定量/数值范围端点+中间值/名称长度）、`quality-gate`（`checkSearchQuality` 检索门槛：对比文件≥3 篇/相关度 X·Y·A 标注/全文≥2 篇/布尔+IPC 检索式）、`slop-gate`（slop-engine 5 维评分，总分<35 判需修订）；内置原子 11→14
- feat(patent): manifest 路径 HITL 断点续跑——`JsonFileManifestCheckpointStore` 每阶段落盘（`<caseDir>/workflow-runs/`），`resumeCheckpointId` 续跑跳过已完成阶段（LLM 副作用不重放），`approveStageIds` 批准审批门后继续
- feat(patent): worker 契约接入执行引擎——`WorkflowStage.worker` 声明后产出经 `validateWorkerOutput` 校验（`workerValidation` 附结果，仅提示不改变 degraded 判定），`WorkerMonitor` 记录真实运行统计；撰写 manifest 的 search 阶段标注 `patent-search-commander` 契约
- feat(patent): subagent_type 别名映射 8 条（cap01 手册下划线名 `technical_analyzer` 等 → 真实注册 kebab 角色 `patent-analyzer` 等），旧命名照常可调度
- feat(patent): 新增 3 个 provision 条款角色 SKILL.md（`provision-disclosure` P-A05 / `provision-drafting-claims` P-D01 / `provision-drafting-spec` P-D02，type: role 可经 `agent` 调度）
- feat(patent): SOP 治理双门禁——`check:patent-sop`（`scripts/check-patent-sop-references.mjs` 校验手册/YAML 引用的工具/角色/worker/manifest/原子五类真实存在，幽灵引用即红）+ `check:patent-workflow-docs`（`scripts/gen-patent-workflow-docs.ts` 以 `builtinPatentManifests` 为唯一真相生成 `assets/workflows/patent/generated/*.yaml` 人读快照，幂等校验）；均挂根 lint
- docs(patent): CAP01 编排手册修订——§2 意图路由表加 manifestId 列（撰写→`patent_drafting_v1`）；§3.5 改 kebab 注册名+别名说明；6 个幽灵工具（`plan_workflow`/`suggest_checkers`/`run_checker_review`/`list_checkers`/`list_workers`/`run_patent_rules`/`tool_search`）替换为真实工具（`patent_workflow_run`/`flexible_plan`/`patent_eval`/`rule_check`/`mcp_status` 等）

### Test
- 新增 `tests/patent/drafting-sop.spec.ts`（17 用例：原子契约/行为/纯函数三态/manifest 结构/全链路跑通至审批门中断）、`tests/patent/workflow-resume.spec.ts`（7 用例：断点续跑不重放 LLM/审批门放行续跑/checkpoint 往返/worker 契约三态/monitor 统计）、`tests/patent/drafting-sop-fullrun.spec.ts`（2 用例：mock provider + 批准全部审批门 → 22 阶段完整跑通，撰写产物断言）
- `tests/test-support/llm-replay-drafting.spec.ts` 重放骨架（真实 key 录制 fixture 缺失时跳过，录制后自动生效；录制流程注释于文件头）
- `tests/skills/patent-roles.spec.ts` SKILLS_ROOT 路径修复（`findRepoRoot` 向上定位仓库根，兼容源/dist 双布局，18 个 ENOENT 失败转绿）
- 修复：工具 inputSchema 描述性改动不再破坏 llm-replay fixture 请求键（`resumeCheckpointId` 描述恢复原样，说明移入工具 description——`toolSchemaDigest` 含 inputSchema，改后须重录 fixture）

## v0.1.2 - 2026-08-18

> **版本目标（2026-08-18）**：专利创造性判断（A22.3 三步法）质量优化 P0+P1+P2 落地（`docs/patent-inventiveness-optimization-plan.md`）——检索反思回路、LLM 节点韧性、对比文件公开日、D2 组合建模、引用真实性硬校验、结论方向指标与 a22.3 专属基准，以及 P2 批次的并行化/模型分层、IPC 领域注入、LLM Judge 双轨与 HITL 反馈回流。

### Feat
- feat(patent): 创造性图检索反思回路——`recall_check` 覆盖度检查 + `refine_query` 确定性补检（最多 2 次重检，降级/解析失败直接放行）+ union 多轮去重 + `converge_prior_art` top-N 收敛；`patent_workflow_run` 新增 `retrievalRounds`（缺省 2，0 = 关闭回路保持旧行为）
- feat(patent): `llmNode` 重试 + JSON required 校验——`maxAttempts`/`timeoutMs`（`Promise.race` 超时，不扩展 `callLLM` 接口），瞬时错误与结构化输出校验失败自动重试，耗尽才降级
- feat(patent): `prior_art` 携带公开日（`publication_date` 透传）+ `closest` 逐篇标注公开日并判断是否早于申请日/优先权日；`build_query` 检索式带申请日时间基准（`after:YYYYMMDD`）
- feat(patent): `combination`（D2 组合）节点——组合动机/技术障碍/反向教导（teaching away）显式建模，输出拼接 hint/conclude 论证
- feat(patent): `citation_gate` 引用真实性校验——结论引用（专利号/文档标识）与检索结果比对，未接地引用经 `ruleGateNode(precomputedFailures)` 并入规则门（既有 pass → needs_revision，blocked/needs_revision 保持；novelty/enablement 不传行为不变）
- feat(patent): `conclusion_direction` 结论方向指标（只认 `结论：具备创造性`/`结论：不具备创造性` 单行标记，旧 suite 恒为 1）+ a22.3 专属基准 fixture（10 条，具备/不具备各 ≥3）
- fix(patent): `patent-eval.mjs` graph 模式 provider 变量遮蔽 + 模型不支持 structured output 时降级为普通调用（prompt 内嵌 JSON 要求）
- feat(patent): P2-1 并行化 + 模型分层——hint/secondary 同超步并行（SuperStep fan-out）；9 个 LLM 节点 `modelHint` 标识（cheap×4 / strong×5）经 `StageProvider.callLLM` 透传，`buildWorkflowProvider({ modelHints })` 按节点映射模型，未配置时行为不变
- feat(patent): P2-2 IPC 领域知识注入——`domain_inject` 确定性节点经 `classifyIpc` 把命中部的 `inventivenessFocus`（化学"预料不到的技术效果"等）注入 closest/diff/hint 提示；领域规则包（medical/mechanical/inventiveness.yaml）复用不重复实现
- feat(patent): P2-3 LLM Judge 双轨——`patent_workflow_run({ judgeSamples })` 对结论报告打 0-1 分（N 次采样中位数）附结果尾部，仅参考不改变规则门判级，缺省关闭
- feat(patent): P2-4 HITL 反馈回流——读侧已接线：`patent_workflow_run`（graph=inventiveness + caseId）读取 `data/cases/<caseId>/inventiveness-feedback.jsonl` 历史反馈注入 conclude 提示（仅提示，不强制）；写侧为宿主接线点：`PatentOutputGate.onDecisionFeedback` 回调暴露审批 modified/rejected 的 `ApprovalRecord`（`feedback/inventiveness-feedback.ts` 纯函数 + paths 约定已就绪，gateway 审批上下文暂无 caseId，生产接线待宿主侧落地）

### Test
- 新增 44 个测试：`graph/llm-node.spec.ts`（重试/超时/校验/降级）、`graph/citation-check.spec.ts`（引用提取/接地/合并规则）、`patent/metrics.spec.ts`（结论方向指标）、`data/nuo/searchProvider.spec.ts`（公开日透传）、domains.spec/patentWorkflowRun.spec 增补回路与工具开关断言
- P2 新增：`feedback/inventiveness-feedback.spec.ts`（回流闭环）、output-gate 决策反馈回调、domains.spec 并行/模型分层/领域注入、patentWorkflowRun.spec Judge 双轨与反馈注入
- 重录 `tests/fixtures/llm-replay/deepseek-v4-flash-basic`（工具 schema 变更后按显式流程重录，重放测试恢复通过）

## v0.1.1 - 2026-08-17

> **版本目标（2026-08-17）**：首个 Beta（0.1.0）之后的工程质量与性能迭代版本——巨无霸函数拆解专项（轨道 A/B）全部收尾、edgeclaw-memory-core 拆解与 lint 开闸、`as never` 类型逃逸批量清理、性能两批卡点修复，另含专利搜索与下载模块优化 Sprint 1-3。

### Refactor
- 拆解专项轨道 A 收尾：workflow 目录化（signal/executor 下沉）、legal-search 拆 4 纯件、kg-store 3 子模块、McpClient 收口为纯门面（operations/connection/errors/toolSpec/transport 下沉）、InProcessGateway 四轮下沉（~2344→1057 行，toolResultSanitize / providerError / normalizers / eventMapping / telemetry / attachments 6 模块）
- 拆解专项轨道 B 收尾：`ui/server/index.js` 3845→244 行，12 个新模块（websocket/{broadcast,chat,shell}、services/{filesystem,uploads,projects-watcher,rate-limit,server-boot}、routes/{system,project-sessions,project-files,project-preview,project-uploads,token-usage}）；冒烟修复分片运行时缺陷后二次精简
- edgeclaw-memory-core：5 大文件拆解 + llm-extraction 类方法级拆分（G8）+ 孤儿导出清理 + lint 开闸（清 132 处未使用 import/死代码）+ 测试纳入 typecheck
- ui/server 深层 import 收口到 src barrel（14 处）+ 边界门禁脚本鲁棒性增强（`check-ui-server-boundary.mjs`：注释/字符串剥离 + .cjs 覆盖 + 白名单自检）
- 桌面端 verify-dmg / verify-installer 精简（端口函数统一 + 死代码/重复检查删除）

### Perf
- 第一批性能卡点修复：token 计数缓存 + 统计异步落盘 + 流式数组累积（#105）
- 第二、三批性能卡点修复：随机采样/LRU/token 增量/静态资产/重连清理/异步 IO/prepare 缓存/分页/日志/基准门禁（#106）

### Feat
- 专利搜索与下载模块优化 Sprint 1-3 全量落地（16 任务）（#101）

### Test
- 移除 `as never` 类型逃逸共 137 处（分散测试 20 + patent 域 31 + toolContext 10 + output-schema 8 + session 16 + file-memory 18 + edgeclaw 27 + egoBrowser 7）
- InProcessGateway 前置伪测试治理：submitTurn 核心路径盲区测试、prepare_weixin_login 伪测试改行为断言；memory.js 设计标注 + memory-core 测试增强（债务 Tier1 风险消除）

### Fixed
- ui/server 分片引入的运行时缺陷：缺 import / barrel 缺失导出 `isVisibleFailureAgentStatus`（ui/server 启动即崩）
- verify-dmg 检查 `SATI_DESKTOP` 守卫的新位置（server/services/server-boot.js）

### Docs
- 拆解专项计划/进度/收尾文档更新（轨道 A/B 完成注记、ui/server-unused-import-cleanup-plan、拆解专项残留引用清理）

## v0.1.0 - 2026-08-16

> **版本目标（2026-08-16）**：**首个测试版（Beta）里程碑**——版本号从 0.0.x 跃迁到 0.1.0，宣告功能面成型、进入公开测试阶段（原规划的 v0.0.30 内容并入本版）。本版落地 nuo 专利规则激活专项：把 96 条沉睡的确定性专利规则（XiaoNuo 移植）激活为生产能力，接入 `rule_check` 显式自检（A 链）与规则驱动输出门禁（B 链）；附 31 条 `action: block` 逐条评审与降级补丁。

### Added
- **nuo 规则激活评审**：31 条 `action: block` 逐条评审（样本验证实证 3 处 keyword 误伤）——2 保留 block（占位专利号/编造案号，零误伤）、1 降 review、15 降 warn（完整性提醒）、13 降 log（语义弱/过宽/重复）；48 warn + 17 log 批量复核全量接入。评审结论落 `rules/README.md`，机器可读权威落 `rules/patent/activation-overrides.yaml`（轻量补丁，加载时字段级覆盖 action）
- **A 链（`rule_check` 显式自检）**：新增 `scope=patent-full` = compliance + nuo 全量（100 条，经 override 降级后 2 block / 2 review / 66 warn / 30 log）；存量 `scope=patent` 保持 4 条不变；`loadPatentFullRuleSet()`（显式 nuo 清单，规避 evidence-rules/synonyms 等非宪法资产误加载）+ `loadActivationOverrides()` + `applyRuleOverrides()`（字段级合并，与整条覆盖的 `mergeRuleSets` 互补）
- **B 链（规则驱动输出门禁）**：`RuleOutputGate` 首次接入生产输出路径——`PatentOutputGate` 内部集成可选 `ruleGate`（两段式串接：关键词门禁 → 规则门禁），block/review 命中复用既有 `GatewayApprovalBus` 审批闭环（挂起可放行/拒绝），warn 命中追加合规提示；`selectGateRules()` 只保留「出现即违规」的 keyword_blocklist 规则（nuo 9 条，排除 compliance PAT-* 与 structural_analysis）；`PendingPatentMessage.ruleViolations` 供审批 UI 展示规则依据

### Docs
- `docs/nuo-rules-activation-plan.md`（专项实施计划：调研/评审/三链接线/实证修正/验收）
- `rules/README.md` 新增「nuo 规则激活评审（2026-08-16）」章节（31 条逐条结论表 + 样本验证记录 + 4 项遗留）
- `docs/technical-debt-report.md` 中期项 #9 勾选完成

### Test
- 新增 `tests/rule/patent-full-rule-set.spec.ts`（7 用例：规则数/降级生效/字段级合并/目录容错）+ `tests/patent/output-gate-rule.spec.ts`（6 用例：block 挂起/warn 提示/零污染/降级放行/两段式串接）；patent 域 355 + rule 域 104 用例全绿

## v0.0.29 - 2026-08-16

> **版本目标（2026-08-16）**：deepseek-harness 优秀设计引入进入阶段四并全部落地（两个迭代 T1–T10）——测试可验证性（LLM 重放）、请求可重建（request invariant）、凭证双码、工具 outputSchema 强制、durable 边界、跨进程任务续算；另落地专利文档渲染管线与 cron 加固。

### Added
- **阶段四迭代一（测试与请求可验证性）**：LLM 重放测试基础设施（`src/test-support/llm-replay/`：record/replay/sidecar 注入/`assertConsumed` + `scripts/record-llm-replay.ts`），无 API key 走完整 agent 回路；`request_header` 快照条目（log-only，记 digest 不记正文）+ `requestInvariant` 重建对拍器（`SATI_VERIFY_REQUEST_RECONSTRUCTION`）；凭证双错误码 `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL`（`assertUsableCredential`）；工具 canonical `outputSchema` 强制校验（`TOOL_OUTPUT_SCHEMA_MISMATCH`）与注册表 `requireOutputSchema` 选项
- **阶段四迭代二（门禁与工具卫生）**：`resolveModelInfo` 统一能力解析（entry→catalog→默认 + 来源标注）+ `assertInputModality` 模态门禁（analyze_patent_figure 显式 image 门禁）；durable 边界检查点（`flushCheckpoint` + 工具副作用前 checkpoint fail-closed + 稳定 `retryId` + 孤儿 turn `interrupted` 收尾）；文件观测三态（`src/tool/builtin/filesystem/observation.ts`，稳定错误码 `file_not_observed` / `file_stale_version`）；工具超时强制（`SatiToolDefinition.timeoutMs` + signal 熔合 + `TOOL_TIMEOUT`）+ 连续重复工具软提醒（`repeatToolReminder`）；配置 last-good-facts 显式化 + 持续坏配置周期告警；事件生产者/消费者矩阵生成器（`scripts/gen-event-matrix.ts` + `--check` 挂 lint 门禁 + `docs/event-producer-consumer.md` 生成物）
- **T9 收尾（outputSchema 全覆盖）**：全部内置工具声明 `outputSchema` 成功契约（46 个默认工具 + 条件注册工具 memory×6/task×5/read_skill），`createBuiltinRegistry` 开启 `requireOutputSchema: true`（新工具未声明即注册期 fail-loud）
- **跨进程任务续算**：`TaskResumeScanner` 启动扫描 (a) 形态断点（`request_header` 后无 durable 消息）→ 经 `gateway.submitTurn` 自动续算；重试轨迹 `retry_schedule` 条目进 transcript 权威序列（log-only）+ `policyKey`；`SATI_TASK_RESUME_ENABLED` 开关（默认开）；详见 `docs/cross-process-retry-resume-plan.md`
- **真实模型 LLM-replay fixture**：DeepSeek v4 flash 真实会话录制（纯问答，无工具调用）入库 `tests/fixtures/llm-replay/deepseek-v4-flash-basic/`，CI 无 key 重放完整 AgentLoop 回路（`llm-replay-real.spec.ts`）
- **专利文档渲染管线**：`src/patent/document/`（templateResolver/brandInjector/pdfRenderer）+ `render_patent_document` 内置工具（domain: patent），5 个专利文书模板（可专利性意见/检索报告/OA答复/权利要求+说明书/无效意见），品牌 CSS 变量注入（theme.json 覆盖），HTML 落盘 + 可选 Chrome headless 打印 PDF；`assets/templates/patent/` 模板资产（build 拷贝）
- **cron 加固**：revision 乐观并发（写回 CAS 409 `CONFIG_CONFLICT`）+ 闰日调度 + cron turn 事件桥接 web chat + 编辑冲突错误本地化

### Changed
- `SatiJsonSchema.additionalProperties` 扩展支持 schema 对象（嵌套约束）
- skills：docx 技能采用上游 understand→build→review 工作流；pdf/pptx/spreadsheets 迁移 `SKILL_ROOT` 占位符；docx deliver 相对输出解析到 `.sati` workspace 布局；清理剩余 PilotDeck 品牌残留
- 事件矩阵启发式精化：消费者列补事件流消费点（`for await` 语汇流）、产/消同源重复归零、GatewayEvent 家族补入（43→62 行）

### Fixed
- 文档渲染管线错误加固（render 错误兜底 + 桌面打包对齐）
- UI：陈旧动态 chunk 崩溃恢复（reloadOnChunkError）、gateway 状态不可用时保持 active session、cron revision 编辑接线到 API 面
- 桌面端 L1 验证步骤 4b/4c/5 此前从未实际执行的问题
- 移除 UI 死文件并标注 v1/v2 命名；nanoid override 升级至 3.3.18

### Perf
- Windows 桌面打包从 40–90 分钟降至约 4 分钟（`apps/desktop/scripts/build-win.bat` 等，详见 `docs/windows-packaging-speed-plan.md`）

### Test
- 新增 phase4 测试 70+ 用例（llm-replay 8 + request-invariant 6 + credential-codes 6 + output-schema-validation 7 + output-schema-batch 5 + resolve-model-info + tool-timeout 6 + repeat-tool-reminder 4 + interrupted-turn 6 + retry-scope/state + env-hooks 等）+ 文档渲染（293 行 spec）+ 跨进程续算（T-A/T-B 9 + T-C 7）全绿；全量后端测试 2792 pass

### Docs
- `docs/deepseek-harness-phase4-plan.md`（阶段四实施文档：调研/任务/实施结果/Code Review 处置/遗留项落地）
- `docs/cross-process-retry-resume-plan.md`（跨进程续算专项计划 v0.2 + 实施结果）
- `docs/event-producer-consumer.md`（事件矩阵生成物，重新生成）
- 记录 2026-08-14 债务清理审计（`docs/technical-debt-report.md`）

## v0.0.28 - 2026-08-14

> **版本目标（2026-08-14）**：以内部工程质量迭代为主——AgentLoop 核心重构（模块化拆解 + 遮蔽式压缩重放 + Web 消息投影收敛）与权限守卫体系落地，spill 溢出存储运维补强，TRIZ 确定性查表与 claim-chart 校验收尾加固。

### Refactor
- AgentLoop 模块化拆解：4685 行巨型循环拆分为 8 个独立模块（messages / modelErrors / subagentExecutor / tokenCapManager / toolContext / toolFailure / turnRuntimeState / misc），各模块配套独立单测
- 遮蔽式压缩重放（shadowed compaction replay）：压缩历史完整重放 + Web 消息投影收敛（`injectWebMessages` / `readSessionMessages` / `webMessageFlatten`），UI 新增压缩边界渲染组件 `CompactBoundaryRow`
- 权限守卫体系：`ToolGuard` / `ToolGuardRegistry` 注册机制 + `PermissionRuntime` 接线

### Added
- spill 溢出存储补强：`ToolResultsCleanup` 孤儿目录回收（gateway 启动时清理无对应 transcript 且超 30 天 mtime 的 `.sati/tool-results/` 目录）+ `scripts/trim-tool-results.ts` 手动治理 + 直调路径 `maxResultBytes` 截断兜底

### Fixed
- MiniMax / Google provider 配置与官方文档对齐（含 onboarding 同步）
- 模型选择器空引用防护 + DeepSeek 默认模型修正
- claim-chart 三关校验加固（chart 原子字段级防御 / element-validator 空白剥离 / pin-cite 补强）与持久化完善
- TRIZ 确定性查表接入 execute 并收敛触发词（此前仅数据组件）
- 桌面端 L3 发布 gate 断链清理 + Windows 构建/签名脚本硬化（build-win / publish-win / verify-signature-win / release-l3）

### Docs
- `docs/agentloop-refactor-plan.md` + DeepSeek harness 两阶段计划（phase1 / phase2）

## v0.0.27 - 2026-08-13

> **版本目标（2026-08-13）**：继续增强专利业务处理能力——落地权利要求对照图（claim-chart）全链路与 TRIZ 方法论组件，精修附图/检索提示词，扩展多模态路由与国产模型支持。

### Added
- claim-chart 权利要求对照图全链路：协议层（要素/行/gap/模式）、要素校验器（verbatim 子串 + 编号连续性）、映射状态机（场景合法性 + 新颖性/区别特征推导）、gap 检测器（缺口聚合/排序/建议动作）、pin-cite 校验器（格式 + 段号存在性 + quote 子串）、`build-claim-chart` 原子（LLM 拆分 + 三关校验 + 打回重做 + gap 检测）、`claim_chart_build` 工具（domain: patent，落盘路径透出）、持久化与 markdown/json 双产物渲染
- 4 个内置 manifest 接入五场景（可专利性/OA答复/无效复审/侵权），`chart_mode`/审批断言补全（T12 收尾）
- TRIZ 方法论组件：40 发明原理 + 39×39 矛盾矩阵查表（Altshuller 经典矩阵，来源 kamil-szczepanik/TRIZ-Agents）+ 专利场景落点
- 路由设置新增多模态模型选择项 + 模型下拉图标标注；媒体重路由纯函数化 + `fallback.media` 多模态候选键
- 模型设置内置 DeepSeek/Kimi/GLM 等国产模型并置顶，onboarding 默认 DeepSeek

### Fixed
- claim-chart target 字段归一化（source_path/product）+ 引用完整性校验
- 附图提示词精修（标号谨慎/图面证据粒度）+ JSON 自愈 + 工具审计字段
- TRIZ 矩阵回归纯 XLS 1190 格（移除无来源单值格）+ prompt 行列语义修正 + 计数断言
- element-validator 剥离空白比较防换行误报；claim-chart store chartId 安全校验
- 桌面端：Windows 打包后重建 pnpm junction 修复本地服务启动失败；build-win.bat 编码与延迟展开 bug 修复；bundle 排除 `@sati` 冗余依赖

### Docs
- M-Cube 多模态深度研究 + 路由/提示词落地方案文档
- claim-chart + TRIZ 实现计划（12 任务 TDD）与内核/设计文档（按代码架构审阅修订）

## v0.0.26 - 2026-08-13

> **迭代基准（2026-08-13）**：v0.0.25 实测使用效果良好，作为体验基线；后续迭代版本须以不低于 v0.0.25 的稳定性与使用体验为基准。

### Added
- Cron 计划配置 UI（对齐 PilotDeck #482）：Recurring 支持每日/每周/每月/每年快捷计划（周几多选、每月几号、月份）与自定义五字段 cron 表达式（带校验）；任务编辑（表单回填 + 保存，running 任务禁止编辑）；删除增加行内两态确认；`cron_update` 网关方法（`src/cron` + gateway 桥 + `PUT /api/always-on/cron-jobs/:taskId`）

### Changed
- 品牌清理收尾：移除 pilotdeck 死代码桥/配置/hook（11 文件，4211 行）、历史消息 provider 标签统一为 "sati"、品牌前兼容 shim 标记 `legacy(pre-rebrand)`、清理注释与文档中过时 pilotdeck 引用
- pnpm overrides 加固传递依赖（audit 27 → 1）
- 桌面端日志超过 20MB 自动轮转归档

### Fixed
- 代理不可达时回退直连 fetch（`src/cli/proxy.ts` + `ui/server/utils/proxy.js` 双端）
- clawhub CLI 定位脱离桌面端最小 GUI PATH
- reasoning 模型显式 temperature 省略，修复会话标题与 Dream 400 错误
- always-on trigger 未启用时输出告警，避免常驻执行静默失效

### Perf
- 知识库检索优化与可观测性补齐（H1-H6 高优先级建议）
- always-on gate blocked 等调度噪音降 debug，SATI_DEBUG 门控
- router autoOrch/policy_skip/token-saver 噪音降 debug

### Test
- 新增 history-frame provider 契约测试（`tests/web/history-frame-provider.spec.ts`）

### Docs
- 修正计划文档计数与悬空 env.ts 引用；记录 2026-08-13 技术债清理与 ui-source keep 决策（`docs/technical-debt-report.md`）
- 知识库系统研究报告（架构/验证/性能/对标/建议）；删除高优先级建议重复标题

## v0.0.25 - 2026-08-12

### Added
- personal_note 语义召回 + embeddings int8 双格式 + chunks 压缩
- ego-browser 深度集成：egoSession 统一封装 + `patent_pdf_download` 下载拦截工具
- 跨平台浏览器后端抽象与级联降级路由
- google-patents learnings 站点包与安装脚本

### Fixed
- knowledge 审查修复：损坏 gzip 兜底 / 向量行防御 / 矩阵缓存失效 / 迁移原子化
- embedding 一致性自检不再阻塞 gateway 启动
- `patent_pdf_download` 统一拦截与 fetch 回退修复
- pdfjs-dist wasmUrl 配置（JBIG2/OpenJPEG/QCMS 解码）并同步测试 mock

### Docs
- 新增 THIRD_PARTY_NOTICES；项目文档同步至 v0.0.24 实际代码状态
- 专利检索与下载优先级统一为本地浏览器优先；跨平台浏览器自动化方案与 POC 报告
- CONTRIBUTING 增加测试运行指引

## v0.0.24 - 2026-08-11

### Added
- 输出门禁 HITL 审批闭环：审批门放行（`approvePendingOutput` / `rejectPendingOutput`）+ gateway 审批命令（`approvalDecide`，协议 1.2 新增可选方法）+ UI 审批卡片（`approval_pending` 事件）；`GatewayApprovalBus` 按 sessionKey 组织挂起条目
- HITL P1 收尾：`flexible_plan` 工具（阶段级计划增删改的显式工具入口）+ plantask 语义强制 + workflow 人工检查点

### Changed
- 移除 README 中过时的 WorkSpace 定位段落
- UI 统一 WebSocket 消息类型（`WsMessage`）并清理消费方 any；chat 工具渲染 / settings 配置聚合 any 清理
- rerank 默认 tei 风格遇到 oMLX 422 时自动降级 jina 重试；检索/点查加 LRU 缓存 + 并发合并，消除重复 ego-browser 调用

### Perf
- 批量下载改单会话提取 + 并发流式写盘

### Fixed
- 批量下载 tab 复用 URL 校验 + rerank 降级独立超时预算
- 排空测试遗留的 React setImmediate 调度任务，消除 CI unhandled error flake

### Docs
- 新增 THIRD_PARTY_NOTICES

## v0.0.23 - 2026-08-11

### Added
- Pregel graph engine（`src/patent/graph/`）：SuperStep 并行超步 + Reducer 确定性合并 + 条件边 + NodePolicy 重试/超时 + DegradationMark 数据降级 + 超步粒度检查点/resume；`manifestToGraph` 兼容既有 WorkflowManifest 与 10 个内置原子；`domains/` 提供三性领域子图（`buildNoveltyGraph` A22.2 / `buildInventivenessGraph` A22.3 / `buildEnablementGraph` A26.3）；`patent_workflow_run` 新增 `graph` 参数与 `resumeCheckpointId`；`scripts/patent-eval.mjs --mode graph` 跑图 + expected 打分（`pnpm test:patent-eval`）
- 原子化技术问题合规校验：`src/patent/problem/atomicChecker.ts` 四检验（不绑方案 / 单一因果 / 可测效果 / 手段可反推）+ 4 条 `INVENTIVENESS-PROBLEM-*` 规则接入创造性链路（`domain: patent_inventiveness` 双链路自动生效），详见 `docs/problem-atomization-minimal-plan.md`

### Changed
- UI 统一 WebSocket 消息类型（WsMessage）并清理消费方 any

### Fixed
- 语义索引预热关闭竞态收尾与重试

## v0.0.22 - 2026-08-10

### Added
- 补齐 Windows 桌面端（构建/托盘/验证/发布）
- 判例自动注入、知识声明、任务意图限额、项目偏好与笔记沉淀（`knowledge_note_save`）
- 吸收 PilotDeck docx skill（docxlib 全套 + 品牌适配）；专利技能补齐知识系统接线与校验规则
- 补齐零测试模块与纯函数层测试覆盖；cron/session/always-on 状态机与存储层测试

### Changed
- UI 依赖大版本升级：Express 4 → 5、React 18 → 19（含 react-i18next 14 → 17）、Tailwind CSS 3 → 4、UI libs / dev tools
- 会话标题跟随用户语言并宽容解析模型输出
- 品牌环境变量读取收敛到 `src/env.ts`（前缀推导 + 特例 override）；执行环境键中性化（WORK_DIR/SESSION_ID/TURN_ID、RPC_*）
- 聊天直连切默认后回退：移除浏览器直连 gateway 路径，聊天统一走 ui/server 中转；WebSocketContext 将 ws 提升为 state；TUI 启动加速（惰性加载 + 远端优先）

### Perf
- 流式帧 latestMessage 短路修复并缓存侧栏会话树；记忆检索 TTL 缓存 + 与 prompt 组装并行（TtlCache 提升至 src/shared）
- always-on run 事件按 runId 复用 fd 的 JSONL 写入器（JsonlRunWriter）；case-law-search 热路径 SQL 预编译
- 会话列表目录快照缓存 + transcript mtime 感知缓存；always-on dashboard 事件聚合 TTL 缓存
- 修复搜索空转与启动加载慢；消除每次 turn 的 ProjectRuntime 重建（Ollama 探测摆动）；KnowledgeEmbeddingSearch 实例缓存

### Fixed
- 新会话 sessionKey 与磁盘文件名编码对齐，修复追问无法发送
- desktop bundle 包含 vendor/ 并移除 zod/hono 排除项；容忍空 provider stub，修复桌面端 Gateway 启动失败
- 语义索引预热在服务关闭时静默退出

## v0.0.20 - 2026-08-07

### Added
- 分层规则包复用体系：`rules/base` + `rules/domains/*` 三层合并加载（base → domains → overrides），项目清单 `.sati/rules.yaml` 装配，`pack.yaml` 包清单 + JSON Schema 校验；`rule_check` 新增 `scope=pack`（缓存按清单 mtime 失效，输出附分层摘要与覆盖审计）；`evaluateText` 新增可选 `domain` 过滤参数
- 创造性判断样板规则入库：base 层 INV-METHOD-001 / INV-EVIDENCE-001，领域层 MECH-INV-001（机械）/ MED-INV-001（医疗）；判例画布全文入库 `assets/patent-rules/inventiveness-canvas.md`
- IPC 分类两级精注入与多重分类并行注入（部级关键词 + 高频大类二级匹配，大类置信度达标时精注入 ipcDetail 卡片）
- 电学附图深度分析（Step3 电学符号识别、校验器与附图说明增强）+ P2 多图一致性、PDF 提取与网表可视化
- 化学式识别能力（RDKit 校验 + VLM 三路流水线 + 防幻觉闭环），`recognize_chemical_structure` 工具
- 弹性计划技术领域基于 IPC 分类自动推断
- 专利能力串联进业务工作流：申请撰写新增附图分析/化学式核验条件步骤与规则门禁收尾步；审查意见答复 CAP02 步接入附图/化学核验、定稿前规则检查；无效答复新增对比文件附图证据固化与创造性论证规则核验；编排器提示词新增内置分析工具目录（§3.6）
- 压缩摘要意图隔离与 compactionId 贯通，UI 透传压缩关联标识
- 收敛后端 no-explicit-any 存量警告并复用共享类型

### Fixed
- judge 调用支持超时中止、失败脱敏诊断与 provider 兼容性

### Changed
- nuo-patent 改为 workspace vendor（`vendor/nuo-patent`），随 sati-main bundle 分发

### Docs
- macOS 打包调研结论入库（`docs/macos-packaging-research.md`）

## v0.0.19 - 2026-08-07

### Added
- 复用 XiaoNuo `knowledge.db` 统一知识库：知识图谱（21.5 万+ 节点）/ 法规 / 判例 / embeddings 语义召回（bge-m3，14.4 万向量）单库接入，零重新构建
- `scripts/trim-knowledge-db.ts`：knowledge.db 裁剪版生成器（默认去 embeddings 7G → ~4.2G，`--no-fts` → ~1.6G）

### Changed
- 默认知识库目录迁移至 `~/.sati/knowledge`（`SATI_KNOWLEDGE_DIR` / `SATI_KNOWLEDGE_DB` 可覆盖）
- 全库异味消债：收敛重复实现并修复运行时隐患
- 依赖版本对齐并新增权限模块测试

### Fixed
- 修复 wiki 语义索引首次全量 embed 阻塞检索
- 修复记忆托管文件路径解析，聊天引用可正确打开 MEMORY.md
- 修复 build-knowledge-vectors 未传输出路径导致写入临时库

### Docs
- 新增知识库复用与检索/反思相关设计文档（`docs/design/import-xiaonuo-*.md`）

## v0.0.18 - 2026-08-06

### Added
- 判例全文检索：`patent_case_search` 内置工具、knowledge.db 接入与 FTS5 共享工具，invalidity/oa-response/agent 接线
- 附图智能分析：`analyze_patent_figure` / `search_patent_figure` 工具与索引持久化，draft/validate 自动附图说明与图文一致性校验
- 本地真实附图基准测试运行器与 ground truth 清单
- 知识库运行时能力自检与 gateway 可观测性出口；知识库能力面板与 embedding 语义增强配置表单
- CLI 支持 --version/--help 参数，避免未知参数静默进入交互模式
- 无效宣告特征化逐特征检索方法论技能（无效证据收集场景）

### Changed
- 修正 CONTRIBUTING.md 桌面端平台支持声明

## v0.0.17 - 2026-08-05

### Added
- Gateway 协议升级至 **1.1**：discovery-plan 协议化（`always_on_list_plans` / `always_on_read_report` / `always_on_list_cycles` / `always_on_archive_cycle` / `always_on_apply_cycle`）+ 浏览器直连聊天（P2b）双轨
- 引入 flexible-plan 层：阶段级生命周期管理（增删改/确认/回退/法条判定挂接），经 `toManifest()` 交 workflow 执行
- `patent_kg_query` 知识图谱查询内置工具；kg-store 支持 OR 分词检索与 FTS LIKE 兜底
- 增强说明书实质校验并接入 wiki 知识检索；专利技能接入知识图谱与 wiki 卡片必查清单
- 专利业务评测集（196 用例，6 类业务）+ 可复用评测脚本 `patent-eval`（真实 LLM + 规则门收口）
- 模型目录与 thinking registry 对齐 2026-08 官方文档（DeepSeek V4、Kimi 等）

### Fixed
- 加固 flexible-plan 状态机与存储层（code review 11 项）、workflow-run 持久化与 Mermaid 转义
- FTS5 不可用时降级 LIKE，避免 law_search 崩溃
- 修复模型选择链路与 runtime-config 端点、恢复侧边栏折叠按钮

### Perf
- 白盒记忆 SQLite 索引与热路径语句缓存；KG 检索语句缓存、批量 IN、键集分页与 trigram 迁移
- 工具注册表排序缓存与工具名索引缓存；预算评估快速通道；工作流并行度上限；cron 精确调度
- literature GET 缓存 LRU 上限与 Accept 键隔离；网关事件流批量发送与认证前帧上限防护
- UI 首屏按需加载、渲染短路与死代码清理

### Changed
- 统一版本管理（`src/version.ts` 向上解析根 package.json，协议版本独立维度）

## v0.0.16 - 2026-08-04

### Added
- 接线 workflow-runs 持久化与 DAG 桥接；新增独立专利创造性 workflow
- 桌面端 UI 全面美化：品牌色体系（正念蓝 `#4f9cff`）+「正念智能体」品牌名统一、侧边栏与输入框交互打磨

### Fixed
- 修复 pnpm workspace 启动并消除 memory-core 构建竞态

### Changed
- 去重 IM 渠道渲染与命令样板
- 清除 PilotDeck 残留并补充项目来源说明；新增桌面端 UI 美化实施概览文档（`overview.md`）

### CI
- 加固依赖安装 fetch 重试，规避 node-gyp 头文件下载偶发超时

## v0.0.15 - 2026-08-03

### Added
- 引入 nuo-patent 数据引擎与专利检索/元数据/法律状态三个内置工具（`patent_search` / `patent_metadata` / `patent_legal_status`）
- 补全 dual-track 确定性规则检查器与 disclosure 管线
- patent-retriever 角色检索方法升级为结构化工具优先
- 引入免费无 key 学术论文检索 `paper_search` / `paper_list_sources`（arXiv / OpenAlex / Semantic Scholar / Crossref）
- 知识系统能力自检与启动诊断、语义召回熔断与检索结果短时缓存；短 query 检索回退最近用户消息
- 角色工具域一致性校验提示

### Fixed
- 加固专利输出门禁（pending 时序、否定语境、中文数字、审批守卫）
- 修复压缩后 token budget 在聊天历史中的展示；恢复 vite 8 (rolldown) 下的生产构建
- 移植上游压缩一致性重构

### Changed
- 拆分压缩引擎并去重 compact budget
- 清理 lint 债务、补充核心子系统测试、同步 i18n
- 依赖升级并加固 audit 配置；强制 Node 22 major runtime
- 移除 `.reasonix` 本地会话索引与死掉的 PilotDeck 遗留文件
- 新增 nuo-patent 数据引擎集成方案文档（`docs/patent-data-layer-integration.md`）

## v0.0.13 - 2026-08-03

### Added
- 内置专利技能迁移：patent-search、google-patents-search、cnipa-query、patent-download 进入 builtin skills
- 新增 ego_browser 内置工具并接入专利检索链路
- MCP 模块完善可运行性：resources/status 工具、instructions 接线与健壮性修复
- 迁移 Mady 专利工作流能力（含审查加固质量门禁）

### Fixed
- gateway spawn 前兜底释放被占用端口，避免端口冲突导致启动失败
- PDF 预览改用 pdfjs-dist legacy 构建，兼容缺少 ES2025 Map API 的环境
- react-dom 与 react 18 对齐，移除已废弃的 xterm 选项
- edgeclaw-memory-core 在 dev/server 入口前重建，避免加载旧产物
- gateway 默认端口从 18789 调整为 19789，避免与 openclaw 冲突

### Changed
- 依赖升级：vite 8.2.0、@vitejs/plugin-react v6、@xterm/xterm 6.0.0、react-dom、@fontsource-variable/inter 5.3.0、string-width 8.2.2 等
