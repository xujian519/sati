# Sati 全仓代码精炼与审阅中期计划（保守档）

- 计划日期：2026-08-18
- 执行深度：**保守档**（用户确认）——只做无行为变化的清理，不拆大文件、不动架构、不升级依赖
- 范围：`src/`、`ui/src`、`ui/server`、`tests/`、`scripts/`（约 1828 个 TS/TSX 文件、31 万行）
- 周期：约 8–9 周，42 张日卡，每天一张

## 一、目标与成功标准

**目标**：对全部代码做一轮全覆盖的「审阅 + 精炼」。审阅先行、精炼后置，**只做无行为变化的清理**，保持全部功能不变。

**成功标准（可量化验收）**：
1. **审阅覆盖率 100%**：42 张日卡全部完成，本进度表可逐卡追溯
2. **每卡门禁全绿**：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`（UI 卡为 `pnpm --filter sati-ui test/typecheck`），零新增 warning
3. **行为不变**：全部提交为 refactor/chore/docs 类，无 feat/fix 混入；全量测试保持全绿
4. **指标目标**（基线见 §六）：裸 console 657 处 → <300；`any`/`@ts-expect-error` 20 处 → ≤10（主链路清零，外围加 `// SAFETY:` 注释）；无参 `catch {}` 485 处显著下降；TODO/FIXME 24 处 → ≤5
5. **产出终审报告** `docs/code-refinement-report.md`：指标对比、遗留清单、未来专项建议（含超长文件拆解候选）

**明确排除（保守档边界）**：不拆 >600 行大文件（仅记录"待拆建议"）、不动 `ui/server` 深层 import 与架构、不升级依赖、不改工具 `inputSchema`（会破坏 LLM replay fixture）、事件面/协议面零改动（`check:event-matrix` 门禁保护）、不触碰 `edgeclaw-memory-core` 的构建方式与 `ui/server/routes/memory.js` 的 lib 直连路径。

## 二、阶段划分

| 阶段 | 周期 | 内容 | 卡数 |
|---|---|---|---|
| 阶段 0 | 第 1 天 | 基线测量 + 建立本计划文档与进度表 | — |
| 阶段 1 | 第 1–2 周 | 核心后端：agent / cli / model / gateway / context / tool | 11 |
| 阶段 2 | 第 3–5 周 | 业务域：patent / adapters / knowledge / router / always-on / session / cron / rule / mcp / extension / web 等 | 15 |
| 阶段 3 | 第 6–7 周 | UI：ui/src 大组件轮转、ui/server 清理、i18n key 对齐 | 9 |
| 阶段 4 | 第 8–9 周 | 测试/脚本审阅 + 横切治理（console / any / catch / TODO）+ 终审报告 | 7 |

**合计 42 张日卡**，每天一张；周五下午留 30 分钟周复盘（卡数、指标变化、下周取卡）。

## 三、每日执行格式（一张"日卡" = 约 2–3 小时）

1. **取卡**：按进度表优先级取未完成卡（大文件多、主链路模块优先）
2. **审阅**：通读该模块全部文件，按审阅清单逐项核查，产出审阅记录（发现分级：P0 行为缺陷 / P1 复杂度 / P2 一致性 / P3 风格）
3. **精炼**：仅执行无行为变化的清理——死代码/孤儿导出删除、命名一致性、重复逻辑合并、类型收窄（`any`→`unknown`/联合类型）、注释治理（删赘注/补必要注释）、嵌套三元改 if/else、i18n 缺失 key 补齐
4. **验证**：对应门禁全绿（后端卡跑 4 件套；UI 卡跑 vitest + typecheck；edgeclaw 子包卡先 `pnpm --filter edgeclaw-memory-core build`）
5. **提交**：Conventional Commits（`refactor(<scope>): …`），一个关注点一个提交；**P0 发现不混入精炼提交**，记录后另开 fix 卡
6. **记录**：更新本进度表（状态 + 发现摘要 + 指标计数）

**审阅清单（每卡必查 10 项）**：
- [ ] 死代码、未使用导出、孤儿文件
- [ ] `any` / `@ts-expect-error` 逃逸（新代码禁 any）
- [ ] 无参 `catch {}` 静默吞错
- [ ] 裸 console（应走 `src/telemetry/` 或结构化错误）
- [ ] 嵌套三元、>100 行函数、过深嵌套
- [ ] 重复代码可提取、冗余抽象
- [ ] 命名与文件命名规范（kebab-case / PascalCase / UPPER_SNAKE）
- [ ] CLAUDE.md 规范一致性（protocol/runtime/config 分层、barrel、错误类、i18n 提取）
- [ ] TODO/FIXME/legacy 标注核实
- [ ] 测试与注释是否随精炼同步更新

## 四、日卡清单

### 阶段 1 — 核心后端（W1–W2）

| 卡 | 模块 | 规模/热点 | 状态 |
|---|---|---|---|
| C01 | src/agent | 44 文件/8.1K 行；AgentLoop.ts 2127（loop 模块族） | ✅ 2026-08-19 |
| C02 | src/cli | 15/5.3K；createLocalGateway.ts 1942、sati.ts 1021（console 热点 54 处） | ✅ 2026-08-18 |
| C03 | src/model/catalog | providers.ts 1766 | ✅ 2026-08-20 |
| C04 | src/model 其余 | streaming/streamModel.ts 995、embedding、resolveModelInfo | ✅ 2026-08-20 |
| C05 | src/gateway | 32/5.9K；InProcessGateway.ts 1057、protocol/server | ✅ 2026-08-21 |
| C06 | src/context 非 memory | projection、budget、compression、vectors | ✅ 2026-08-21 |
| C07 | src/context/memory 主包 | EdgeClawMemoryProvider 等（不含子包） | ✅ 2026-08-22 |
| C08 | edgeclaw-memory-core 子包 | sqlite.ts 1716、llm-extraction.ts 1573、file-memory.ts 1147、llm-prompts.ts 997；独立 build 验证 | ✅ 2026-08-23 |
| C09 | src/tool registry/execution/audit | createBuiltinRegistry、ToolRuntime | ✅ 2026-08-23 |
| C10 | src/tool/builtin 上半 | readFile.ts 988、filesystem 组 | ✅ 2026-08-23 |
| C11 | src/tool/builtin 下半 | patentPdfDownload.ts 945、patentWorkflow 等 | ✅ 2026-08-23（专利工具族；executeCode/webSearch/validateSpecification 等非专利项留待后续） |

### 阶段 2 — 业务域（W3–W5）

| 卡 | 模块 | 规模/热点 | 状态 |
|---|---|---|---|
| C12 | src/patent workflow+flexible-plan+plantask | 126 文件/20.5K 总分 3 卡 | ✅ 2026-08-23 |
| C13 | src/patent evidence+problem+atoms | 26 文件（evidence 10 / problem 2 / atoms 14） | ✅ 2026-08-24 |
| C14 | src/patent graph+claim-chart+document | ✅ 2026-08-24 |
| C15 | src/patent data/nuo+figure+evaluate 其余 | ✅ 2026-08-24 |
| C16 | src/adapters 大渠道 | wecom 1760、weixin 1459、feishu 1332 | ✅ 2026-08-25（关联 #190） |
| C17 | src/adapters 其余 18 渠道+protocol | ImLiveReplyController.ts 1016 | ✅ 2026-08-25 |
| C18 | src/knowledge | 44/7.1K；case-law、legal、kg-store、wiki | ✅ 2026-08-26 |
| C19 | src/router | 26/4.3K；RouterRuntime.ts 1258 | ✅ 2026-08-27 |
| C20 | src/always-on | 38/8K；DiscoveryFire.ts 1252 | ✅ 2026-08-27 |
| C21 | src/session + task + status + pilot | 34/4.8K + 3 小模块 | ✅ 2026-08-27 |
| C22 | src/cron + src/rule | 18/3K + 11/1.9K | ✅ 2026-08-27 |
| C23 | src/mcp + literature + methodology | 16/1.4K + 13/1.3K + 13/0.7K | ✅ 2026-08-28 |
| C24 | src/extension + permission + lifecycle | SkillManager.ts 904 | ✅ 2026-08-28 |
| C25 | src/web + workflow + telemetry | 12/3.5K + 11/1.8K + 5/0.8K | ✅ 2026-08-29 |
| C26 | 小模块合卡 | network/shared/fs/browser/test-support | ⬜ |

### 阶段 3 — UI（W6–W7）

| 卡 | 模块 | 规模/热点 | 状态 |
|---|---|---|---|
| C27 | main-content-v2 组 | SkillsV2.tsx 2502、DashboardV2.tsx 1351 | ⬜ |
| C28 | chat-v2 组 | MessagesPaneV2.tsx 1375、ComposerV2.tsx 1061、processGrouping.ts 1231 | ⬜ |
| C29 | chat/hooks | useChatComposerState.ts 1596、useChatSessionState.ts 1168、useChatRealtimeHandlers.ts 973 | ⬜ |
| C30 | chat/view + stores | MessageComponent.tsx 969、useSessionStore.ts 1435 | ⬜ |
| C31 | code-editor/view | PdfDocumentPreview.tsx 1860、CodeEditorBinaryFile.tsx 1522 | ⬜ |
| C32 | app-shell + hooks | SidebarV2.tsx 1273、AppShellV2.tsx 887、useProjectsState.ts 898 | ⬜ |
| C33 | main-content 其余 | MainContent.tsx 1051、CronV2.tsx 1097、FilesV2.tsx 960 | ⬜ |
| C34 | ui/server | 98 JS/29.7K 行；只做行为不变清理（死代码、重复、命名），深层 import 仅记录 | ⬜ |
| C35 | ui i18n + e2e | en/zh-CN key 对齐、Playwright 用例审阅 | ⬜ |

### 阶段 4 — 横切与收尾（W8–W9）

| 卡 | 内容 | 状态 |
|---|---|---|
| C36 | tests/ 审阅 A：agent/tool/context（伪测试治理、断言质量） | ⬜ |
| C37 | tests/ 审阅 B：patent/knowledge/gateway/session 等其余 | ⬜ |
| C38 | scripts/ 32 文件审阅精炼 | ⬜ |
| C39 | 裸 console 收束（→telemetry wrapper，行为不变） | ⬜ |
| C40 | any/类型逃逸收敛（主链路优先 + SAFETY 注释） | ⬜ |
| C41 | 无参 catch 治理 + TODO/FIXME 核实 | ⬜ |
| C42 | 终审：docs/code-refinement-report.md + 技术债报告追加注记 | ✅ 2026-08-20（报告见 docs/code-refinement-report.md；注记见 technical-debt-report.md「2026-08-20 注记」段；进度 7/42，C07-C41 共 35 卡遗留） |

## 五、进度表（每日更新）

| 日期 | 卡号 | 模块 | 审阅发现摘要 | 提交数 | 状态 |
|---|---|---|---|---|---|
| 2026-08-18 | C02 | src/cli | P1 渠道构建重复×2 / 死 try-catch；P2 错误强转×2 / 路径解析重复；P3 横幅错位 / 重复 import；记录不处理：DEFAULT_USER=xujian、双份 readStringFlag；P0 无 | 2（refactor + docs） | ✅ |
| 2026-08-19 | C01 | src/agent | P1 同分支三元死代码×1；P2 `void ctx` 命名不一致 / 无参 catch 缺注释×2；P2 记录不处理：TurnRunner 失败收尾 4 处相似块（细节差异大，抽取有漂移风险）、AgentLoop `errors![0]!` 断言 ~20 处（结构性，需 errors 类型重构）；P0 无 | 1（refactor） | ✅ |
| 2026-08-20 | C03 | src/model/catalog | P2 openai/openai-responses models 块逐字节一致（5728B×2）→ 提取 OPENAI_SHARED_MODELS（-174 行）；P2 记录不处理：multimodal 模板重复 / 数字下划线风格 / minimax PascalCase 与 volc_ark snake_case 配置键；P0 无 | 1（refactor） | ✅ |
| 2026-08-20 | C04 | src/model 其余 | P2 streamModel debug-dump ×2 / 重试警告 ×2 → 提取辅助函数；P2 findBalanced 两函数泛化合并；P2 死代码：providers/registry.ts 零消费、providerEndpoint 单变体 ×2、looksLikeUnparsedToolCall、extractStructuredOutput 死分支；P2 记录不处理：repairOpenAIToolPairing 兜底 / splitThinkContent FSM 重复 / 9 文件解析助手重复 / repairToolName 平局守卫（修复=行为变更）；P0 无 | 3（refactor×2 + docs） | ✅ |
| 2026-08-21 | C05 | src/gateway | **P0 帧解析异常冒泡**：websocket.ts handleData 中 readClientFrame 抛错 → uncaughtException → 进程退出（安全缺陷）→ 已修复（try/catch + destroy + return）；P2 死代码：InProcessGateway `now` 字段（零消费者）、AsyncQueue fail()/error 字段、buildAttachmentPathNote 死参数、5 处 readonly setter 的 as 断言（readonly 只禁重赋值）；P3 私有化收紧 ×7、嵌套三元 → if/else ×2、无参 catch 补注释 ×6、legacy 断言合并；P3 记录不处理：runMemberScan 转 async（TS 80006 建议，复杂闭包大 diff，保守档跳过） | 4（fix + refactor + docs×2） | ✅ |
| 2026-08-21 | C06 | src/context 非 memory | P2 死代码批量删除：TokenBudgetManager estimate* 别名 ×2、TokenAccountingRuntime estimateResponseEvents、CachedMicroCompactionEngine validateCacheHit、SnipEngine ×2 + 私有化、MicroCompactionEngine 死常量 ×2、InstructionDiscovery scopeDescription、ToolResultBudget flattenToolResultText、cosineSimilarityInt8、MessageProjector hasToolCalls、AutoCompactionPolicy evaluate（连带 tokenBudget 字段/Options 删除，6 调用点简化）、DefaultContextRuntime truncateSecondKeepRatio 死配置；P3 barrel 7 个已删符号 export 清理、summaryInput 重复 JSDoc、CompactionEngine 嵌套三元、PluginRuntimeExtensionResolver 过时注释；P0/P1 无 | 3（refactor×2 + docs） | ✅ |
| 2026-08-22 | C07 | src/context/memory 主包 | P2 EdgeClawMemoryProvider telemetry 块 ×5 重复（module/ownerModule/executionKind 恒 "memory"）→ 提取 trackMemoryStage 私有 helper；P3 setCachedRetrieve/trackRetrieveLoopEnd 单行转发内联、semantic-index isServiceClosedError 冗余条件（"this statement…" 被 "statement…" 子串覆盖）、MemoryAttachmentBuilder throwAbortError 单调用点内联、resolveMemoryLlm as 断言消除（memoryApiTypeForProtocol 返回类型收窄为 EdgeClawMemoryLlmOptions["apiType"]，两类型字面量集合相同）；P3 barrel 4 个零消费 type re-export 删除（EdgeClawCaptureTurnResult 等，测试走源文件导入）；P2 记录不处理：CanonicalMessagesToMemoryMessagesOptions 零消费但属公共函数 options 契约类型保留导出；P0/P1 无 | 1（refactor）+ docs | ✅ |

| 2026-08-23 | C08 | edgeclaw-memory-core 子包 | P2 重复逻辑合并：sqlite normalizePreferredSessionKeys×3→helper、getPipelineState 委托 readPipelineState、countTableRows×2（clearAll/clearCurrent）；file-memory markEntriesDeprecated/restoreEntries 对称合并为 setEntriesDeprecated、listProjectIdentityHints 冗余别名删除、repairManifests memoryFileCount 提取；llm-prompts project/feedback 字段映射两处重复→mapDreamProjectFields/mapDreamFeedbackFields；P3 readWorkspaceDirFromDb 无参 catch 补意图注释；子包扫描无裸 console/无 any 类型逃逸/无 TODO；P0 无 | 1（refactor） | ✅ |
| 2026-08-23 | C09 | src/tool registry/execution/audit | P2 barrel 死导出批量清理：src/tool/index.ts 163 导出中 ~110 零外部消费（builtin/web 组整块、各工具 Input/Output 类型与 creator、constraints 辅助等）→ 删除，净 -153 行；保留有消费者的核心面（ToolRuntime/ToolRegistry/schedulers/protocol types 等）；P3 ToolRuntime isPlanMarkdownPath 双重 resolve 简化、deliverAuditRecord catch 补意图注释；三目录扫描零 console/any/TODO/catch；P0/P1 无 | 1（refactor + event-matrix） | ✅ |
| 2026-08-23 | C10 | src/tool/builtin 上半 | P2 重复收敛：readFile readState.set ×5 → markRead 闭包；read-more 双 notice 函数合并（reason 参数）；auto-page 双 while 循环合并为 shrinkToBudget helper；writeFile/editFile 的 freshness 错误字符串匹配块 ×2 → snapshotGuardIssueMessage（writeSnapshots 导出）；writeFile/editFile execute 写盘收尾序列 ×2 → finalizeWorkspaceFileWrite（新建 writeFinalize.ts）；readFile/sendAttachment workspace 外权限检查 ×2 → checkReadonlyPathPermission（新建 readPermissions.ts）；stat ENOENT catch ×3 → statIfExists；ensureWriteSnapshotFresh changed-throw ×2 局部去重；P3 pathSafety/readFile 双重 resolve 模式简化（同 C09 ToolRuntime）；P0/P1 无 | 1（refactor） | ✅ |
| 2026-08-23 | C11 | src/tool/builtin 下半（专利工具族） | P2 重复收敛：patentPdfDownload 专利号归一化+去重 ×2 → normalizeUniquePatents；patentWorkflowTool/patentWorkflowRunTool/patentFlexiblePlanTool 阶段/节点输出预览截断 ×4 → previewText helper；P2 assembleGraphJudges 冗余 spread（`...{modelHint}`）+ 双非空断言 → 局部变量 + 直接 modelHint；P3 summarizeCheck 嵌套三元 → CHECK_VERDICT_LABEL 查表；P0/P1 无；记录不处理（C10/C09 已述）：错误消息字符串匹配判定、inputSchema 契约、console 诊断日志归 C39 | 1（refactor） | ✅ |
| 2026-08-23 | C12 | src/patent workflow+flexible-plan+plantask | P2 死代码删除：attachArticleJudgment `if (target === undefined)` 不可达（findStageIndex 已保证）→ 非空断言；worker-contract TIER_LABELS 全仓零消费死导出删除；P3 formatTechnicalField 命名一致（detail 提取后改用原字段）；index.ts barrel 删 ROLE_WORKER_TIERS 导出（零外部消费，定义保留）；四块扫描零 console/any/TODO/catch；P0/P1 无 | 1（refactor） | ✅ |

| 2026-08-24 | C13 | src/patent evidence+problem+atoms | P3 删除 engine.ts/date.ts 零消费类型 re-export（CredibilityLevel/DateReliability/DateSourceType）+ 连带未用 import 清理；readPriorArt 私有化（仅 llm.ts 内部使用）；5 处防御式无参 catch 补意图注释；search.ts 提取 previewQuery 去重查询串截断；P0/P1/P2 无；P3 记录不处理：3 处裸 console（receipt.ts ×2 / mapper.ts ×1）归 C39 横切治理 | 1（refactor） | ✅ |
| 2026-08-24 | C14 | src/patent graph+claim-chart+document | P3 无参 catch 补意图注释 ×4（enablement.ts:483 / inventiveness.ts:610 / claim-chart store.ts:38 / document brandInjector.ts:64；state.ts:15、stylePreset.ts:51 已注释）；嵌套三元改 if/else ×1（graph/adapter.ts:120 主输出键序列化）+ 查表 ×1（claim-chart gap-detector.ts reason 文案提取 GAP_REASON_LABELS，与原内联三元逐字一致）；P2 记录不处理：validatePinCiteFormat/stripWhitespace 为同包或 chart.ts 消费的公共 export 保留、splitClaimSegments 仅同文件内消费但作公共 API 一致保留；P0/P1/P2 无行为缺陷；三模块横切扫描：零裸 console、零 any/@ts-expect-error、零 TODO/FIXME | 1（refactor） | ✅ |
| 2026-08-25 | C16 | src/adapters 大渠道（wecom/weixin/feishu） | P3 无参 catch 补 fail-safe 意图注释 ×9（wecom 583/1608/1700、weixin 1215/1348、feishu 57/1101/1230/1245）；P0/P1/P2 无；三渠道整体质量高：零裸 console（weixin 3 处登录二维码横幅属 CLI 交互提示、保留）、零 any/@ts-expect-error、零 TODO/FIXME、零死代码/未使用导出 | 1（refactor） | ✅ |
| 2026-08-25 | C17 | src/adapters 其余渠道+protocol | P3 全 18 个无参 catch 补 fail-safe 意图注释（protocol 5 + 渠道 Channel 12 + web 1）；记录不处理：createWebStaticMount 恒等 stub、tui/app UI 层、SessionMapper/render 薄封装；P0/P1/P2 无；横切零 any/console/TODO | 2（refactor + docs） | ✅ |
| 2026-08-26 | C18 | src/knowledge | P2 冗余：assemble.ts 末尾重复 re-export diagnostics.js 能力符号（resolveKnowledgeCapabilities/formatKnowledgeCapabilities/logKnowledgeCapabilities + 4 type），全仓（src+tests）零消费（index.ts 已从 diagnostics.js 直接导出同名）→ 删除；P3 注释：9 处无参 catch 补 fail-safe 意图注释（version-meta:120/diagnostics:40/legal-search:92/personal-note-store:134/fts:22/embedding-consistency:59/wiki-card-loader:325/kg row-mapper:58/schema-introspector:85）；P0/P1 无；横切零 console/any/TODO、无嵌套三元；记录不处理：KnowledgeLawSearchOptions2 命名瑕疵（改公共导出面风险大）、ipc-classifier.ts 779 与 case-law-search.ts 656 超 600 行（待拆建议） | 1（refactor） | ✅ |
| 2026-08-27 | C19 | src/router | P3 注释：无参 catch 补 fail-safe 意图注释 ×2（RouterRuntime.ts:1132 protocolForProvider 未知 provider 回退默认 openai 协议、TokenStatsCollector.ts:291 rebuildFromJsonl 读 stats.jsonl 失败按空数据重建）；P0/P1/P2 无；横切零 console/any/@ts-expect-error/TODO/死代码、无嵌套三元；记录不处理：RouterRuntime.ts 1258 行（保守档待拆建议） | 1（refactor） | ✅ |
| 2026-08-27 | C20 | src/always-on | P3 注释：无参 catch 补 fail-safe 意图注释 ×8（DiscoveryStateStore:40、WorkCycleStore:99、SnapshotCopyProvider:30、DiscoveryPlanService:266、AlwaysOnRunHistoryService:132/141/419/516）；P0/P1/P2 无；横切零 console/any/@ts-expect-error/TODO/死代码、无嵌套三元；记录不处理：DiscoveryFire.ts 1252 行（保守档待拆建议） | 2（refactor + docs） | ✅ |
| 2026-08-27 | C21 | src/session + task + status + pilot | P2 死代码：session/worktree 孤儿 barrel、SessionList listAllSessions/searchSessionsByTitle（含 2 options 类型）、pilot createPilotConfigStore/PilotRouterConfig/redactedValue、task/status/pilot barrel 死 re-export ×11；P2 重复收敛：mergeMetadata ×2→import SessionMetadataStore、BackgroundTaskRuntime stdout/stderr handler→onChunk、parseToolsConfig enabled 块 ×2→parseEnabledFlag、FileArtifactCollector mimeType 双调用、WorkspaceLedger cloneLedger 单调用点内联；P3 无参 catch 补 fail-safe 意图注释 ×11 + timedOut 等价简化；P0 候选 ×6 只登记（saveAiTitle 死条件、safeReadText 恒等分支、legacy 缓存 diagnostics 未拷贝、BTR entries 永不清理+maxTasks 上限、memory 平铺 schedule 字段静默失效、TaskOutputStore.readSlice 字节切片切碎 UTF-8）；记录不处理：replaySubagentTranscript 零消费（C3.S5 预留 SDK 面，按 C07/C17 判例保留）、getDiagnostics 零消费、跨文件重复（isNotFoundError ×3、provider/model 拆分 ×3、readOptionalPositiveInteger ×2）、killForAgent/killAll 微重复、isRecord 数组语义差异；测试缺口登记：resumeAgentSession/formatChatHistorySearch 零直接测试 | 4（refactor×4） | ✅ |
| 2026-08-27 | C22 | src/cron + src/rule | P2 死代码：CronTaskStore getTask/replaceTask（连带 cron-fire.spec mock 脚手架 replaceCalls/replaceResults/replaceOk）、resolveRuleAsset、barrel defaultCronConfig；P2 死参数 CronFire.updateTaskAfterRun outcome（连带 void outcome; 删除）、CronScheduler 冗余 `as Promise<void>`；P2 重复收敛：createTask/updateTask 归一化+校验块 ×2→resolveScheduleAndNextRunAt、标题截断 ×2→firstLineTitle、patent-compliance 降级告警序列 ×3→loadComplianceBase、CronTaskStore normalize 双调用+`!` 断言 ×2；P2 恒真三元 RuleEngine:121（CITATION_RE 捕获组恒等）→ `match[1]`；P3 无参 catch 补意图注释 ×6（CronTimezone:5、CronStoreMigration:155/377、CronTaskStore:116/198、RuleEngine:97）+ mapCronRunOutcome 防御分支注释；P0 候选 ×2 只登记（CronManager.ensureRuntime start 失败永不重试、runTaskNow 绕过注入时钟+一次性任务累积）；记录不处理：RuleLoader structural/synonym 要素循环相似提取（漂移风险，C12 判例）、CronManager ENOENT catch ×3（warn 文案/行为各异）、原子写跨文件重复；测试缺口登记：CronManager/parseCronConfig/asset-location 无直接测试 | 2（refactor×2） | ✅ |
| 2026-08-28 | FIX | C21/C22 P0 候选批次修复 | 8 项按 ①②>③④>⑤⑥>⑦⑧ 排序逐项修复，每项独立提交 + 附测试（关键回归用例先验证旧代码红再恢复绿）：①BTR 注册表（maxTasks 只数活跃任务 + 终态 entry finishedTaskTtlMs 默认 1h 惰性清扫）②CronManager.ensureRuntime 失败回滚注册表 + stop 兜底，下次调用重建重试（新增 cron-manager.spec，CronManager 首次有测试）③memory 平铺 schedule 字段被 schedule 段遮蔽时发 CONFIG_MEMORY_FLAT_SCHEDULE_FIELDS_IGNORED 警告（语义不变）④TaskOutputStore.readSlice UTF-8 码点边界对齐（尾部不完整序列回退 nextOffset 零丢失，头部孤立 continuation 跳过）⑤FileHistoryStore.safeReadText 非 ENOENT 经 options.warn 告警（stats fail-safe 语义不变）⑥TranscriptReader legacy 缓存命中 diagnostics 拷贝（与 entries/tail 路径一致）⑦runTaskNow 改用注入时钟（run-now 孵化-自删语义保留）⑧saveAiTitle 死分支移除，JSDoc 写明覆盖保护由调用方负责（TurnRunner 已实现）；决策记录 docs/notes/implemented/2026-08-28-p0-fix-batch-c21-c22.md | 8（fix×7 + refactor×1） | ✅ |
| 2026-08-28 | C23 | src/mcp + literature + methodology | P2 死代码：methodology keywordMatch hasAnyKeyword 全仓零消费删除、triz TRIGGERS/loadMatrix/detectParamNumbers 死导出收窄为模块私有（测试仅消费 triz/lookupMatrixCell）；P2 重复收敛：parsePluginMcpServers streamable_http url 双重 expandMcpString（构造时已展开）→ 直用变量、isStringRecord 改类型守卫消 2 处 as；P3 PluginToToolBridge 图片扩展名嵌套三元 ×4 → IMAGE_MIME_BY_EXT 查表（文案逐字等价）；P3 无参 catch 补 fail-safe 意图注释 ×2（literature http hostOf 非法 URL、shared/text safeCodePoint 孤立代理码位）；P0/P1 无；记录不处理：4 connector 的 authors「前 4 + et al.」格式化跨文件 ×3（C04 判例）、ConnectorRegistry.all 零外部消费（注册表 API 面，C22 asset-location 判例）、8 个 methodology 组件结构同构但 prompt 主体全异（参数化加间接层无收益，C12 判例）、McpRuntime:65 `(err as Error).message` 强转（错误格式化行为面，保守档不动） | 3（refactor×3） | ✅ |
| 2026-08-28 | C24 | src/extension + permission + lifecycle | P2 死代码删除 14 文件：extension/protocol 目录整体（SatiExtensionError/SatiExtensionSource/SatiExtensionContributionKind，被 plugins/protocol 取代的早期词汇层）、plugins/protocol/errors.ts SatiPluginError、PluginContributionLoader、PluginReloadPolicy/defaultPluginReloadPolicy、hooks/execution/aggregateHookResults.ts 孤儿单行 barrel、contributions 5 个死类型文件（Command/Hook/Tool/Mcp/PermissionRule；Prompt/Router 有 plugin.ts 消费保留）、lifecycle LifecycleDispatcher.ts 孤儿单行 barrel + LifecycleObserver.ts 零消费类型；P2 barrel 死 re-export 清理：extension/index.ts 删 loadPluginHooks/defaultPluginReloadPolicy 等 8 项、skills/index.ts 删 hashDirectoryTree（连带收窄 export，模块内自用）、lifecycle/index.ts 删 LifecycleObserver；P2 重复收敛：SkillManager isValidSlug 导出为单一事实源、migrateSkills 删内联副本（迁移须与导入同规则）、scan/listSkillsIn symlink→statIsDirectory、validateFromDisk/Manifest 规模硬限尾块→pushBundleLimitIssues、单文件体积检查→pushFileSizeIssues；P2 死方法 AsyncHookRegistry.list 恢复保留（parse-hook-output.spec 有消费，首查 grep 过滤器误报）；P3 无参 catch 补 fail-safe 意图注释 ×14（extension 12 + permission 1 + skills 2 组内含）；P0 候选 ×1 只登记（SkillManager walkDir readdir 失败静默 return，EACCES 目录被跳过 → fileCount/totalBytes 少报可让超限 bundle 过校验，import 时 fs.cp 才暴露）；记录不处理：toLegacyHookInput/SATI_NOT_APPLICABLE_LEGACY_HOOK_EVENTS（legacy 钩子契约预留面，C21 replaySubagentTranscript 判例）、isBlockingOutput 跨文件微重复 ×2、4 个 hook executor 结果包装结构相似（行为分支各异）、expandHome ×2 同目录重复（泛用 util，提取加导出面）、SatiLifecycleRuntimeError 零生产消费仅测试构造（疑预留错误契约面）；测试缺口登记：SkillManager scan/import 零直接 spec（skill-manager-builtin 只覆盖部分）；横切零 console/any/@ts-expect-error/TODO | 5（refactor×5） | ✅ |

| 2026-08-29 | C25 | src/web + workflow + telemetry | P3 无参 catch 补 fail-safe 意图注释 ×6（workflow DagEngine 节点失败收集 / InputResolver 不可序列化降级、web forkSession 转写重写跳过非 JSON 行、telemetry context git 探测 ×2 处降级注释）+ types.ts 过时 JSDoc 文件引用修正（SubagentAgentFactory→SubagentWorkflowAgentFactory）；P0/P1/P2 无行为缺陷；记录不处理：workflow 引擎整体「已移植未接线」（引擎/存储/检查点仅测试消费，模块头注明的预留面，C21/C22 判例保留）、limitToolResultPreview ×2 与 isSearchToolName ×2 跨文件重复（签名/语义差异：unknown→"" vs string→undefined，合并需改契约）、webMessage.ts agent_status payload 双写 contentI18n/userHintI18n（wire 契约面，UI 消费）、DEFAULT_HISTORY_CONTEXT_TOKENS 零外部消费（定义处文档化默认值常量，保留）；三模块零 any/零 TODO/零裸 console（telemetry logger 为统一入口属合法）| 3（refactor×3：workflow/web/telemetry） | ✅ |
### 日卡记录

#### C01 src/agent（2026-08-19）

- **审阅发现**：
  - P1 SubAgentSession.ts:142 同分支三元死代码（`? event.message : event.message`）→ 已删除
  - P2 doomLoop.ts `void ctx;` 占位（其余检测器均用 `_ctx` 前缀约定）→ 统一为 `_ctx`
  - P3 AgentLoop.ts:1359 / modelContextWindow.ts:23 无参 catch 缺注释 → 补意图注释（均为防御式回退，非吞错）
  - P2 记录不处理：TurnRunner 失败收尾 4 处相似块（recordErrorResult/flushReadySessionTitle 细节各异，抽取有行为漂移风险）；AgentLoop `result.errors![0]!` 非空断言 ~20 处（结构性问题，需重构 AgentTurnResult.errors 类型，保守档不碰）；PlanTodoState `normalized.id!`（有构造保证，可接受）
  - P0：无行为缺陷。模块整体质量高（零 any、6 处无参 catch 均有明确意图）
- **精炼项**：SubAgentSession 死三元删除、doomLoop 参数命名统一、2 处 catch 补注释
- **验证**：`pnpm typecheck` ✅ 0 错误；`pnpm lint` ✅（含 event-matrix 重生成，纯行号偏移）；`biome check src/agent` ✅；agent 测试 150/150 ✅
- **提交**：`refactor(agent): drop dead ternary, unify doomLoop param naming, document fallback catches`

#### C02 src/cli（2026-08-18）

- **审阅发现**：
  - P1 sati.ts：渠道构建逻辑在 server 启动与 adapter 热重载两处重复（feishu/qq/wecom 各 2 份，约 90 行）→ 已提取 4 个构建函数收敛
  - P1 gatewaySetup.ts：`attemptFeishuQRCreation` 的 try/catch 为死代码（try 体不可能抛错，两分支均 return null）→ 已删除
  - P2 createLocalGateway.ts：2 处 `(err as Error).message` 强转（非 Error 时丢信息）→ 统一为 `instanceof Error` 模式
  - P2 discoveryIo.ts：项目名解析逻辑重复 2 份 → 提取 `resolveProjectRoot` 辅助函数
  - P3 satiServer.ts：同模块重复 import 3 处 → 合并；gatewaySetup.ts 横幅边框错位（45 vs 52 宽）→ 对齐
  - P2 记录不处理：patentSearch.ts `DEFAULT_USER = "xujian"`（开发者个人默认值，改默认值属行为变化，需人工决策）；chatSearch.ts 与 sati.ts 各有一份语义不同的 readStringFlag（不合并避免行为漂移）
  - P0：无行为缺陷
- **精炼项**：sati.ts 渠道构建去重（-90 行）、gatewaySetup.ts 死代码+横幅、createLocalGateway.ts 错误格式化 ×2、discoveryIo.ts 去重、satiServer.ts import 合并
- **验证**：`pnpm typecheck` ✅ 0 错误；`pnpm lint`（eslint src/cli）✅ 0 error/0 warning；`biome check src/cli` ✅；cli 测试 30/30 ✅（tsx 直跑）
- **提交**：`refactor(cli): dedupe channel construction and clean up CLI entry helpers`

#### C03 src/model/catalog（2026-08-20）

- **审阅发现**：
  - P2 providers.ts：openai 与 openai-responses 的 models 块逐字节一致（5728 字节 × 2，9 个模型）→ 提取 `OPENAI_SHARED_MODELS` 共享常量（`Record<string, CatalogModelEntry>` 显式标注，防上下文类型丢失导致 multimodal.input 拓宽为 string[]），两协议 spread 引用，净 -174 行
  - P2 记录不处理：multimodal 模板重复（`{ input, maxImagesPerRequest: 20, supportedImageMimeTypes, imageDetail }` 约 20 处，提取共享模板会耦合全部模型，改动面大收益有限）；数字字面量下划线风格不统一（1048576 vs 1_048_576 等，纯风格 diff 噪音大）；minimax 模型 id PascalCase（MiniMax-M3 等）/ volc_ark provider id snake_case（配置键，改则破坏兼容）
  - P3 aliases 空数组冗余（无害）；P0 无行为缺陷。数据文件注释质量高（deprecated 标注 / 实测反馈 / 官方文档引用）
- **精炼项**：OPENAI_SHARED_MODELS 提取（openai/openai-responses 共享模型定义）。⚠️ 两协议 `models` 为浅拷贝共享同一批对象引用——当前 catalog 全链路只读；若未来需按协议特化某模型能力，将对应条目移出共享块（常量上方注释已写明）
- **验证**：`pnpm typecheck` ✅ 0 错误；`pnpm lint` 全量 ✅（eslint 全仓 + event-matrix/patent-sop/workflow-docs/html-templates 4 check fresh）；`biome check .`（2093 文件）✅；`pnpm test` 3504 pass / 0 fail ✅；改前/改后 `PROVIDER_CATALOG` JSON 逐字节一致（行为等价）✅
- **提交**：`refactor(model): extract shared OpenAI model catalog between protocols`

#### C04 src/model 其余（2026-08-20）

- **审阅发现**：
  - P2 streamModel.ts：model-debug dump 块 ×2（动态 import fs/os/path + 写盘 + log）→ 提取 `dumpRequestForDebug`；complete() 重试 console.warn ×2 → 提取 `warnCompleteRetry`（顺带 `(error as Error).message` → `instanceof Error` 保真）
  - P2 parseTextToolCalls.ts：`findBalancedJsonObjectEnd`/`findBalancedJsonArrayEnd` 逐行相同（仅 {/} 与 [/] 之别）→ 泛化合并为 `findBalancedEnd`（-33 行，16 用例行为等价验证）；`hasQwenMarker` 冗余转发 → 合并
  - P2 死代码删除：`providers/registry.ts`（ModelProviderRegistry 全仓零消费）、`providerEndpoint.ts` 单变体转发 ×2（Candidates 变体保留）、`toolCallFormats.ts` `looksLikeUnparsedToolCall`、`extractStructuredOutput.ts` 不可达分支
  - P3 清理：clone/multimodal 冗余 `as` 强转 ×3、`contentBlockToInputModality` 多余 export、`_messageIndex`/`_provider` 参数、`TRANSIENT_ERROR_TYPES` 提升模块级、JSDoc 修正 ×2（probe stale-while-revalidate / resolve 配置错误限定）、防御式 catch 补注释 ×3、openai/stream JSDoc 重复句
  - P2 记录不处理：`repairOpenAIToolPairing` 与 `splitThinkContent` FSM（行为敏感/无直接单测）；9 文件重复的 `asRecord/readString` 等解析助手（跨文件重构）；`repairToolName` 平局守卫边界缺陷（修复=行为变更需决策）；8 处 console 诊断日志（C39 横切）；`google/stream.ts` `ended` 字段（子代理误判为只写不读，实有 streamModel.ts:442 读取点，未动）
  - P1/P0：无行为缺陷
- **精炼项**：重复提取（streamModel ×2 组、findBalanced 合并）、死代码/未使用导出删除（4 处）、类型/命名/注释清理（约 12 处）
- **验证**：`pnpm typecheck` ✅ 0 错误；`pnpm lint` 全量 ✅（event-matrix 重生成，纯行号偏移）；`biome check src/model` ✅（全仓 format:check 红系用户未提交的 `assets/templates/patent/tokens.css` 排版改动，非本次引入）；`pnpm test` 3504 pass / 0 fail ✅；`extractTextToolCalls` 16 用例改前/改后行为等价（剔除随机 id）✅
- **提交**：`refactor(model): extract stream debug/retry helpers, unify balanced JSON parsing`、`refactor(model): drop dead exports, remove redundant casts, document fallback catches`、`docs: regenerate event matrix (streamModel line shifts)`
- **审查后续（code-review，2026-08-20）**：审查发现 complete() 非 google 路径重试警告漏提取（初始仅提取 google 路径）→ 补齐 `warnCompleteRetry`；新增 `tests/model/streaming/parse-text-tool-calls.spec.ts`（12 用例）锁定五格式解析行为

#### C05 src/gateway（2026-08-21）

- **审阅发现**：
  - **P0（安全缺陷）** websocket.ts handleData 的 while 循环中 `readClientFrame` 解析失败时抛出的异常会从 socket data 回调冒泡为 uncaughtException，**直接终止整个进程**（恶意/畸形客户端可远程触发）→ 已修复：try/catch + `socket.destroy()` + return，按非法客户端断开（独立 `fix(gateway)` 提交，不混入 refactor）
  - P2 死代码：`InProcessGatewayOptions.now` 字段（全仓零消费者；连带 createLocalGateway/Gateway.ts createGateway/2 测试删除传参）；AsyncQueue `fail()`/error 字段（iterator 内 error 分支不可达）；`buildAttachmentPathNote` 死参数 `directContentPaths`（4 参 → 3 参）；InProcessGateway 5 处 readonly options 字段 setter 的 `as` 断言（readonly 只禁止重赋值，断言是噪音）→ 全部删除
  - P2 eventMapping.ts：context_budget 的 totalContextTokens 双重三元 → `??` 等价简化（数学验证：undefined 语义逐 case 等价）
  - P3 私有化收紧（export 未外泄）：`withGatewayRunId`/`mapAgentEventForTurn`（同文件内部用）、`attachmentDiagnosticsGuidance`（同文件内部用）、toolResultSanitize 3 常量 + `sanitizeGatewayToolDataValue`
  - P3 其他：createGatewayPermissionHook 嵌套三元 ×2 → if/else；InProcessGateway legacy 三元链断言合并为单一对象类型断言、冗余 `.catch(() => {})` 删除、687 行 console.warn 补注释；无参 catch 补意图注释 ×6（SessionRouter/memoryDiagnostics/staticAssets/providerError/probeServer ×2）
  - P3 记录不处理：runMemberScan 转 async（TS 80006 建议；闭包内 .then/.catch 链 + 密集注释，转换 diff 大且零收益，保守档跳过）
  - P0 之外的 P1：无行为缺陷
- **精炼项**：P0 修复 1、死代码删除 5 组、断言/三元简化 8 处、私有化 7 处、注释补全 7 处、测试同步 3 处（净 -22 行）
- **验证**：`pnpm typecheck` ✅ 0 错误；`pnpm lint` 全量 ✅（event-matrix 重生成，纯行号偏移：createLocalGateway/InProcessGateway/CompactionEngine 位移）；`biome format --write` 修复 6 处缩进后 `format:check` ✅；`pnpm test` 3640 pass / 0 fail ✅
- **提交**：`fix(gateway): guard frame parse errors from escaping socket callback`（P0，单独）、`refactor(gateway): drop dead fields and redundant casts, tighten exports`、`docs: regenerate event matrix (gateway/context line shifts)`

#### C06 src/context 非 memory（2026-08-21）

- **审阅发现**：
  - P2 死代码批量删除：TokenBudgetManager `estimateForFileType`/`estimateBlockTokens`（Legacy 别名零消费，连带删除对应测试用例）；TokenAccountingRuntime `estimateResponseEvents`；CachedMicroCompactionEngine `validateCacheHit`；SnipEngine `projectSnippedView`/`isSnipBoundaryMessage`（`createSnipBoundary` 私有化）；MicroCompactionEngine `MICROCOMPACT_FAILURES_FOLDED`/`MICROCOMPACT_RECOVERED_FAILURE_PREFIX`（仅保留 MICROCOMPACT_CLEARED）；InstructionDiscovery `scopeDescription`（DefaultContextRuntime 保留本地私有副本）；ToolResultBudget `flattenToolResultText`（doomLoopIntegration 用本地副本）；cosine `cosineSimilarityInt8`（`int8Dot` 有测试消费者，保留）；MessageProjector `hasToolCalls`（空 if 清理后失活）；AutoCompactionPolicy `evaluate`（连带删除 tokenBudget 字段/Options/构造参数，6 处调用点简化——evaluateSnapshot 只依赖传入 snapshot，行为零变化）；DefaultContextRuntime `truncateSecondKeepRatio` 死配置（options/常量/字段/赋值，全类零读取，ContextOverflowRecovery 有独立副本）
  - P3：`src/context/index.ts` barrel 清理 7 个已删符号 export（createToolResultBudgetState/flattenToolResultText/MICROCOMPACT ×2/isSnipBoundaryMessage/projectSnippedView/scopeDescription/AutoCompactionPolicyOptions）；summaryInput.ts 两段逐字重复 JSDoc 删除；CompactionEngine.ts:235 嵌套三元 → if/else；PluginRuntimeExtensionResolver.ts 过时注释更新（"TODO marker" 措辞，聚合器已实现）
  - P2 连带：createLocalGateway `sharedSessionStore` 死字段 + `SessionRouterStore` import 删除（审阅时误在 gateway 卡中，实为 registry 字段，随 C05 提交）
  - P0/P1：无行为缺陷
- **精炼项**：死代码删除 17 组（净 -195 行）、私有化 3 处、barrel 清理 7 处、注释/结构清理 4 处、测试同步 6 处
- **验证**：`pnpm typecheck` ✅ 0 错误（含 edgeclaw-memory-core）；`pnpm lint` 全量 ✅；`biome format --write` 修复 6 处缩进后 `format:check` ✅；`pnpm test` 3640 pass / 0 fail ✅（context 套件全绿）
- **提交**：`refactor(context): remove dead compaction/budget helpers and unused config`（与 event-matrix docs 提交共享）

#### C07 src/context/memory 主包（2026-08-22）

- **审阅发现**：
  - P2 EdgeClawMemoryProvider.ts：trackFeatureLoopStage 调用块 ×5 重复（module/ownerModule/executionKind 恒为 "memory"，phase/loopStage/outcome/errorCategory/metadata 变化，每块 9-11 行）→ 提取 `trackMemoryStage` 私有 helper 统一入口，净 -30 行
  - P3 冗余抽象内联：`setCachedRetrieve` 单行转发（2 调用点 → 直接 `retrieveCache.set`）、`trackRetrieveLoopEnd` 并入 trackMemoryStage、MemoryAttachmentBuilder `throwAbortError` 单调用点内联
  - P3 semantic-index.ts isServiceClosedError：第 4 条 `"this statement has been finalized"` 是第 1 条 `"statement has been finalized"` 的超集匹配（includes 子串语义），冗余条件删除
  - P3 createEdgeClawMemoryProviderFromConfig resolveMemoryLlm：`as EdgeClawMemoryLlmOptions["apiType"]` 断言消除——memoryApiTypeForProtocol 返回类型收窄为 `EdgeClawMemoryLlmOptions["apiType"] | undefined`（核实 EdgeClawMemoryApiType 与 PilotMemoryApiType 字面量集合完全相同，断言是历史遗留噪音）
  - P3 barrel 清理：src/context/index.ts 删除 EdgeClawMemoryProvider 的 4 个零消费 type re-export（全仓唯一消费者为测试文件，且走源文件相对路径导入）
  - P2 记录不处理：CanonicalMessagesToMemoryMessagesOptions 类型导出零外部消费，但属公共函数 canonicalMessagesToMemoryMessages 的 options 契约类型，保留导出语义
  - P0/P1：无行为缺陷。主包整体质量高——零 console/any/TODO，全部 catch 均带意图注释，缓存/并发去重/abort 传播逻辑有充分注释
- **精炼项**：telemetry helper 提取（5 处收敛）、冗余转发/包装内联 ×4、死条件删除 ×1、as 断言消除 ×1、barrel 死导出清理 ×4（净 -15 行）
- **验证**：`pnpm typecheck` ✅ 0 错误；`pnpm lint` 全量 ✅；`biome format --write` 修复 1 处单行超宽后 `format:check` ✅（2142 文件）；`pnpm test` 3685 pass / 0 fail ✅（context/memory 套件 45/45、context 全套 136/136）
- **提交**：`refactor(context): unify memory telemetry stage helper, drop redundant abstractions`

#### C08 edgeclaw-memory-core 子包（2026-08-23）

- **审阅发现**：
  - P2 重复逻辑合并（子包 4 大文件，活代码无死导出）：sqlite.ts `normalizedPreferredSessionKeys` 过滤 3 处逐字一致 → 提取私有 helper；`getPipelineState` 与 `readPipelineState` 仅 fallback 差异 → 前者委托后者；`clearAllMemoryData`/`clearCurrentWorkspaceMemoryData` 的 `SELECT COUNT(*)` 两表查询各重复 → 提取 `countTableRows(table)`；file-memory.ts `markEntriesDeprecated`/`restoreEntries` 除 `deprecated` 布尔外逐字一致 → 合并为 `setEntriesDeprecated(relativePaths, deprecated)`；`listProjectIdentityHints` 冗余别名 `const projectMeta = meta` 删除；`repairManifests` 三处 `collectAllEntries().length` → 提取局部 `memoryFileCount`；llm-prompts.ts `buildDreamFileGlobalPlanPrompt`/`buildDreamFileProjectRewritePrompt` 的 project/feedback 字段映射块逐字一致 → 提取 `mapDreamProjectFields`/`mapDreamFeedbackFields`
  - P3 `readWorkspaceDirFromDb` 无参 `catch {}` 补意图注释（读外部工作区 db 失败 → null，防御式）
  - P3 机械扫描（全子包 src）：无裸 console、无 `any` 类型逃逸（6 处均为提示词文本）、无 TODO/FIXME；8 处无参 catch 仅 1 处缺注释（已补），其余均带意图注释
  - P0：无行为缺陷。子包整体质量高（零 console/any/TODO，全部 catch 带注释，重复收敛后净 -约 70 行）
- **精炼项**：重复提取（6 组）、冗余别名删除 ×1、catch 注释 ×1、类型导入补齐（`LlmDreamFileRecordInput`）
- **验证**：`pnpm --filter edgeclaw-memory-core build` ✅；`pnpm --filter edgeclaw-memory-core typecheck`（tsc 两配置）✅；子包测试 233/233 ✅；`pnpm typecheck` 全量 ✅（主包 import 未破）；`biome check`/`eslint` 子包 ✅（format:write 修复 2 处行宽）
- **提交**：`refactor(memory): dedupe edgeclaw-memory-core helpers and document fallback catch`

#### C09 src/tool registry/execution/audit（2026-08-23）

- **审阅发现**：
  - P2 barrel 死导出批量清理：`src/tool/index.ts` 163 个导出符号中约 110 个全仓零外部消费（builtin/web 组整块——urlFetcher/urlContentCache/preapprovedHosts/secondaryPrompt/urlValidation 的常量/函数/类型、`__setWebFetchHookForTesting` 零测试使用；各工具 `XxxInput`/`XxxOutput` 类型与 creator 函数——消费者全部走源文件相对导入；constraints 的 build*/is* 辅助）→ 全部删除，净 -153 行。保留有消费者的核心面（ToolRuntime/ToolRegistry/ConcurrentToolScheduler/filterAvailableTools/protocol types/createBuiltinRegistry/createAgentTool/createReadFileTool 等 ~50 个）。⚠️ 消费者检测以 tsc 兜底验证（rg 管道扫描曾漏检 createReadMcpResourceTool，typecheck 报错后已恢复）
  - P3 ToolRuntime.ts isPlanMarkdownPath：`resolve(isAbsolute(p) ? p : resolve(cwd, p))` 双重 resolve 冗余 → `resolve(cwd, filePath)`（数学等价）；deliverAuditRecord 的 `.catch(() => {})` 补 fire-and-forget 意图注释
  - P3 记录不处理：repairToolName BUILTIN_ALIASES 表驱动设计良好不动；errorRecovery classifyWebFetchError/webFetchNextActions 结构相似但行为分支不同不合并
  - P0/P1 无行为缺陷。三目录横切扫描：零裸 console、零 any/@ts-expect-error、零 TODO、零无参 catch（除已注释的审计投递）
- **精炼项**：barrel 死导出删除 ~110 处、双重 resolve 简化 ×1、catch 注释 ×1
- **验证**：`pnpm typecheck` ✅；`pnpm lint` ✅（event-matrix 重生成，ToolRuntime 纯行号偏移）；`biome check src/tool` ✅；`pnpm test` 3728 pass / 0 fail ✅
- **提交**：`refactor(tool): drop dead barrel re-exports, simplify plan-mode path resolution`

#### C10 src/tool/builtin 上半 readFile + filesystem 组（2026-08-23）

- **审阅发现**：
  - P2 重复收敛（6 组）：
    - readFile.ts `readState.set(dedupKey, {...})` ×5 逐字一致（仅 mtimeMs 来源不同）→ 提取 `markRead(mtimeMs)` 闭包（readFileInRange 返回值已 floor，统一 Math.floor 等价）
    - readFile.ts renderReadMoreNotice/renderToolResultRefReadMoreNotice 仅中间句不同 → 合并为 reason 参数单函数
    - readFile.ts auto-page 双 while 循环（autoPaged / tool-result ref 两路径循环体一致，互斥执行）→ 合并为 `shrinkToBudget(markRef)` async helper
    - writeFile/editFile validateInput 的 freshness 错误字符串匹配块 ×2 → writeSnapshots 导出 `snapshotGuardIssueMessage(error)`
    - writeFile/editFile execute 写盘收尾序列（writeTextFile→stat→invalidate→snapshot→didChange/didSave）×2 → 新建 `filesystem/writeFinalize.ts` finalizeWorkspaceFileWrite（独立文件避免 writeTextFile↔writeSnapshots 循环依赖）
    - readFile/sendAttachment 的 workspace 外权限检查（passthrough→deny→ask+session rule 三段式）×2 → 新建 `filesystem/readPermissions.ts` checkReadonlyPathPermission(toolName, ...)
  - P2 stat ENOENT catch 块 ×3（writeSnapshots ×2 + writeTextFile ×1）→ 提取 `statIfExists` 导出；ensureWriteSnapshotFresh 内 changed-throw ×2 局部去重为 throwChanged 闭包
  - P3 路径解析 `resolve(isAbsolute? ... : join(cwd,p))` 模式简化 ×2（pathSafety.ts:28、readFile validateInput；与 C09 ToolRuntime 同款）
  - P3 记录不处理：writeFile/editFile 用错误消息字符串匹配判定快照守卫错误（脆弱但改抛结构化标志属行为面改动）；glob/grep/editNotebook/sendAttachment 主体质量高未动
  - P0/P1 无行为缺陷。横切扫描：零 console/any/TODO，catch 均带意图或语义清晰（mupdf 失败→undefined 等）
- **精炼项**：重复提取 6 组 + helper 收敛 3 处 + resolve 简化 2 处（净 -约 90 行，新增 2 个小模块）
- **验证**：`pnpm typecheck` ✅；`pnpm lint` ✅；`biome check src/tool` ✅（format --write 修复 1 处行宽）；`pnpm test` 3728 pass / 0 fail ✅（tool/filesystem 套件全绿）
- **提交**：`refactor(tool): dedupe filesystem tool helpers and read_file budget paths`

#### C11 src/tool/builtin 下半（专利工具族，2026-08-23）

- **范围说明**：本卡按计划点名聚焦 `patentPdfDownload.ts`（946 行）与 patentWorkflow 工具族（patentWorkflowTool / patentWorkflowRunTool / patentFlexiblePlanTool / patentPlanTaskTool / patentWorkerValidateTool）。`executeCode.ts` / `webSearch.ts` / `validateSpecification.ts` / `agent.ts` 等下半个文件本轮未翻（后续补卡）；三目录横切扫描已覆盖上述 5 文件。
- **审阅发现**：
  - P2 重复收敛（3 组）：
    - patentPdfDownload.ts 专利号归一化+去重（`map(normalizePatentNumber).filter(n => n.length > 0)` + `new Set`）×2（validateInput 与 execute 逐字一致）→ 提取 `normalizeUniquePatents` 模块级 helper
    - 阶段/节点输出预览截断（`length > 0 ? slice(0,80) + (length > 80 ? "…" : "") : empty`）×4（patentWorkflowTool stage 行、patentWorkflowRunTool stage 行 + graph state 行 `"(空)"`、patentFlexiblePlanTool stage 行）→ patentWorkflowTool 导出 `previewText(text, max, emptyLabel)`，三调用方复用（graph state 行 emptyLabel 传 `"(空)"` 保持差异）
    - patentWorkflowRunTool `assembleGraphJudges`：`...{ modelHint: hint }` 冗余包装（等价直接 `modelHint: hint`）+ 两次 `deps.modelHints![hint]!` 非空断言（可读性噪音）→ 提取局部 `mapped` 变量 + 直接字段
  - P3 `summarizeCheck` 嵌套三元（pass/needs_revision/blocked）→ `CHECK_VERDICT_LABEL` 查表（Verdict 恰为三分联合，行为等价）
  - P2 记录不处理：C10/C09 已述（writeFile/editFile 错误消息字符串匹配判定快照守卫——改抛结构化标志属行为面；inputSchema 契约红线；patentPdfDownload `console.warn` 诊断日志归 C39 横切）
  - P0/P1：无行为缺陷。专利工具族质量高——共享 provider 装配（buildWorkflowProvider/buildWorkflowRunContext/renderWorkflowResultText/resolveRunPersistTarget/writeRunArtifacts）已收敛，operation 表驱动（flexible_plan MUTATIONS）、状态机透传（patent_plan_task）结构清晰
- **精炼项**：重复提取 3 组 + 查表 1 处（净 -13 行，新增 1 个导出 helper）
- **验证**：`pnpm typecheck` ✅ 0 错误；`pnpm lint` 全量 ✅（含 event-matrix/patent-sop/skill 校验 fresh）；`biome check` 4 文件 ✅；`pnpm test` 3728 pass / 0 fail ✅（专利工具族套件 78/78 全绿）
- **提交**：`refactor(tool): dedupe patent workflow helpers and pdf path normalization`

#### C12 src/patent workflow+flexible-plan+plantask（2026-08-23）

- **范围说明**：本卡聚焦四块——`src/patent/workflow/`（manifests/types/executor/checkpoint/signal/index，1005 行）、根级 `workflow.ts`/`workflow-dag.ts`/`workflow-store.ts`、`flexible-plan.ts`/`flexible-plan-store.ts`、`plantask.ts`、`worker-contract.ts`，合计约 2566 行。`approval.ts`/`output-gate.ts`/`quality-gate.ts`/`retry-hints.ts`/`slop-engine.ts` 等专利域其他功能不属本卡（后续卡）。
- **审阅发现**：
  - P2 死代码：flexible-plan.ts `attachArticleJudgment` 中 `if (target === undefined) throw ...` 不可达——`findStageIndex` 已保证阶段存在（不存在即抛错），删除冗余检查改非空断言
  - P2 死导出：worker-contract.ts `TIER_LABELS`（`Record<WorkerTier, string>`）全仓（含 ui/scripts）零消费 → 删除
  - P3 barrel 清理：src/patent/index.ts 删除 `ROLE_WORKER_TIERS` 导出（全仓零外部消费；定义保留，供内部 `workerAllowedForRole` 使用）
  - P3 命名一致：flexible-plan.ts `formatTechnicalField` 局部 `detail` 已提取，后两处仍直接用 `classification.detail` → 统一用 `detail`
  - P2 记录不处理：workflow.ts `runStageOnce`/`saveCheckpoint` 的副作用时序契约与并行组语义（注释明示勿改）；plantask.ts `syncPlanToTasks`/`replanTasks` 的 task 构建相似但 status 判据不同（合并有行为漂移风险）；flexible-plan.ts `createFlexiblePlan`/`fromJSON` 的 caseId 校验重复（错误消息差异，提取收益小）；workflow/types.ts `WorkflowStageResult`/`ManifestCheckpointStage` 的 workerValidation 内联类型重复（可提 `StageWorkerValidation`，但会新增导出面，收益有限）
  - P0/P1 无行为缺陷。四块横切扫描：零裸 console、零 any/@ts-expect-error、零无参 catch、零 TODO/FIXME
- **精炼项**：死代码删除 1 处（+非空断言）、死导出删除 1 处、barrel 导出清理 1 处、命名一致 1 处（净 -11 行）
- **验证**：`pnpm typecheck` ✅ 0 错误（含 edgeclaw-memory-core）；`pnpm lint` 全量 ✅（event-matrix/patent-sop/skill 校验 fresh）；`biome check .`（2166 文件）✅；`pnpm test` 3746 pass / 0 fail / 4 skip ✅
- **提交**：`refactor(patent): drop dead contract exports and redundant guard in flexible plan`

#### C14 src/patent graph+claim-chart+document（2026-08-24）

- **审阅发现**：
  - P3 无参 catch 缺意图注释 ×4：enablement.ts:483 / inventiveness.ts:610（结论 JSON.parse 失败→降级空）、claim-chart store.ts:38（损坏 JSON→无图表）、document brandInjector.ts:64（theme.json 解析失败→空品牌）；state.ts:15（structuredClone 兜底 JSON 往返）、stylePreset.ts:51（损坏预设文件忽略）已带注释
  - P3 嵌套三元 ×2：graph/adapter.ts:120 主输出键序列化（`typeof raw === "string" ? raw : raw === undefined ? "" : JSON.stringify(...)`）→ if/else；claim-chart gap-detector.ts:26 reason 文案内联嵌套三元 → 提取 `GAP_REASON_LABELS` 查表（与既有 `SUGGESTIONS` 风格一致，文案逐字一致）
  - P2 记录不处理：claim-chart `validatePinCiteFormat`（chart.ts 经非 barrel 路径消费）、`stripWhitespace`（pin-cite-validator 同包消费）为有意不暴露的公共 export 保留；`splitClaimSegments` 仅同文件内消费，但保留 export 维持公共 API 一致
  - P0/P1/P2：无行为缺陷。三模块共 33 文件/4066 行，整体质量高——零裸 console、零 any/@ts-expect-error、零 TODO/FIXME、零死代码
- **精炼项**：无参 catch 补注释 ×4、嵌套三元→if/else ×1、嵌套三元→查表 ×1
- **验证**：`pnpm typecheck` ✅（含 edgeclaw-memory-core）；`pnpm lint`（eslint src/patent）✅ 0 error；`biome check src/patent` ✅；`pnpm test` 3750 pass / 0 fail / 4 skip ✅
- **提交**：`refactor(patent): document defensive catches and flatten nested ternaries in graph/claim-chart/document`

#### C15 src/patent data/nuo+figure+evaluate 其余（2026-08-24）

- **审阅范围**：26 文件 / 4312 行（data/nuo 4：egoSession/mapper/patentCache/searchProvider；figure 16：analyze/types/validator/index/prompts/netlist-viz/retrieve/pdf-extract/multi-figure-consistency/analyze-electrical/index-store/preprocess/mime + symbols×3；evaluate 6：consensus/evaluator/index/llm-judge/metrics/runner）。
- **审阅发现**：
  - P3 无参 catch 缺意图注释 ×8（其余 4 处已带注释/warning 不重复处理）：egoSession.ts:142/199/249（探针失败→不可达、payload 非 JSON→null、权限不足→不可执行）、mapper.ts:41（非法 JSON 数组→空）、searchProvider.ts:70/141（单源/单 connector 失败 fail-open→空）、figure/preprocess.ts:33（sharp 不可用→格式未知 null）、evaluate/llm-judge.ts:91（单次采样失败→跳过该票）。注 retrieve.ts:196、index-store.ts:82/125 三处 catch 已带注释，确认不重复。
  - P0/P1/P2：无行为缺陷。横切扫描：零裸 console、零 any/@ts-expect-error、零 TODO/FIXME、零死代码；无明显需拆嵌套三元（既有三元均为合理短表达式，保守档不动）。各模块质量高——符号库（symbols/electrical-symbols.yaml 驱动）知识库模式、索引原子写+并发串行化、评估三层 verdict envelope 设计清晰。
- **精炼项**：无参 catch 补 fail-safe 意图注释 ×8（净 +8 行，行为零变化）
- **验证**：`pnpm typecheck` ✅（含 edgeclaw-memory-core）；`pnpm lint`（eslint src/patent/data src/patent/figure src/patent/evaluate）✅ 0 error；`biome check src/patent/data/nuo src/patent/figure src/patent/evaluate` ✅（26 文件）；`pnpm test` 3750 pass / 0 fail / 4 skip ✅。注：全仓 `pnpm check` 的 format:check 因 `.claude/settings.local.json`（未跟踪 / 非 C15 范围、pre-existing）报格式问题，非本卡引入，本卡文件不受影响。
- **提交**：`refactor(patent): 为 nuo/figure/evaluate 无参 catch 补 fail-safe 意图注释（C15）`

#### C17 src/adapters 其余渠道 + protocol（2026-08-25）

- **审阅范围**：`src/adapters` 去掉 C16 已覆盖的 wecom/weixin/feishu 三渠道后其余 18 渠道（api-server/bluebubbles/cli/dingtalk/discord/email/homeassistant/matrix/mattermost/qq/signal/slack/sms/telegram/tui/webhook/wecom-callback/whatsapp）的 Channel+SessionMapper+render，加 `protocol/`（15 文件，热点 ImLiveReplyController.ts 1016 行）与 `web/`（httpRouter/projectFiles/static-mount）及 `index.ts`/`loadEnabledChannels.ts`。
- **审阅发现**：
  - 横切扫描（全 adapters）：零裸 console、零 any/@ts-expect-error/any/@ts-ignore、零 TODO/FIXME/HACK；无参 catch {} 70 处（C16 已处理 wecom/weixin/feishu 上部，本卡处理其余）。
  - P3 无参 catch 缺意图注释 ×18：protocol 5（ImPermissionHelper:74 JSON 序列化失败→String 兜底、ChannelStatePersistence:37 读文件/解析失败→无状态、:99 unlink 失败→忽略、resolveWebSocketImpl:33 ws 不可用→回退全局 WS、ChannelRuntimeStatus:48 损坏快照→空）、渠道 Channel 12（webhook:211 非 JSON 载荷→raw 保留 / :348 签名非 hex→拒签、dingtalk:128 非 JSON→跳、homeassistant:175 非 JSON→跳、mattermost:131/143 非 JSON→跳 / :281 非 JSON 响应→原文本、email:221 正文解码失败→占位文本、sms:158 非法 body→400 / :201 签名非 hex→拒签、signal:131/281 读错误响应体失败→空 / :171 SSE 行非 JSON→跳、whatsapp:127 bridge URL 非法→默认端口、matrix:101 getUserId 失败→回退 option、bluebubbles:234 错误响应非 JSON→空对象、qqbot-gateway:307 token 预刷新失败→下次重取、wecom-callback:204 写回错误响应失败→忽略 / :310 错误响应非 JSON→空对象）、web 1（httpRouter:142 请求体非 JSON→undefined）。均属防御式回退（解析失败→降级/跳过、签名非 hex→保守拒签、清理失败→忽略、可选依赖未装→告警），补 fail-safe 意图注释使可审计。
  - P2 记录不处理：`createWebStaticMount`（web/static-mount.ts）零消费恒等函数 stub，属"待实现占位桩"，按 C07 先例保留；各渠道 SessionMapper/render 为三件套模式统一薄封装、无 dead code，提取收益小风险大。
  - 记录不处理：`tui/app/*.tsx`（TUI React 组件）属 UI 层，含 TuiApp.tsx:168 一处无注释 catch（降级处理语义清晰），归 UI 阶段；`.claude/settings.local.json`（未跟踪）format:check 报错为 pre-existing（C15 已记录）。
  - P0/P1/P2 无行为缺陷。热点 ImLiveReplyController.ts 质量高（全部 catch 带 error 参数经 reportTransportError）。
- **精炼项**：无参 catch 补 fail-safe 意图注释 ×18（净 +26/−2，行为零变化）。
- **验证**：`pnpm typecheck` ✅（含 edgeclaw-memory-core）；`pnpm lint` 全量 ✅（event-matrix 重生成，纯行号偏移：ApiServer/Sms 等适配器行位移）；改动文件 `biome format --write` 无改动 ✅；`pnpm test` 3812 pass / 0 fail / 4 skip ✅。
- **提交**：`refactor(adapters): 为其余渠道与 protocol 无参 catch 补 fail-safe 意图注释（C17）`、`docs: regenerate event matrix (adapters line shifts)`（PR #194）

#### C18 src/knowledge（2026-08-26）

- **审阅范围**：44 文件 / 7866 行（不含 wiki 数据目录），含 case-law、legal、patent（ipc/standards/kg/wiki-card）、personal-note、shared（kg/vector/fts 等）。
- **审阅发现**：
  - P2 冗余：`assemble.ts` 末尾重复 re-export `diagnostics.js` 能力符号（resolveKnowledgeCapabilities/formatKnowledgeCapabilities/logKnowledgeCapabilities + 4 type），全仓（src+tests）零消费——index.ts 已从 diagnostics.js 直接导出同名符号 → 删除该重复导出。
  - P3 无参 catch 缺意图注释 ×9（version-meta：120 JSON 解析失败→空映射、diagnostics：40 探测失败→不可探测、legal-search：92 FTS 降级 LIKE、personal-note-store：134 读失败→空串哨兵、shared/fts：22 编译探测失败→按未编译、embedding-consistency：59 库打开失败→null、wiki-card-loader：325 缓存损坏→失效重扫、shared/kg row-mapper：58 law_refs 非 JSON→undefined、schema-introspector：85 FTS 未可用→降级 LIKE）→ 均补 fail-safe 意图注释。其余 4 处 catch（law-search-tool:49、chunk-compression:49、wiki-card-loader:337/348）已带注释，未重复处理。
  - P0/P1 无行为缺陷。横切扫描（全模块）：零裸 console、零 any/@ts-expect-error、零 TODO/FIXME、零死代码/孤儿导出、无嵌套三元需展平（`??` 配单三元、SQL `?` 占位符系误报）。
  - 记录不处理：`KnowledgeLawSearchOptions2` 构造 options 带怪异 `2` 后缀（改名属公共导出面变更，风险大）；`ipc-classifier.ts`（779）与 `case-law-search.ts`（656）超 600 行（保守档记录待拆建议）；跨文件 `errorMessage` 小函数重复（C04 先例：跨文件重构不处理）。
- **精炼项**：无参 catch 补 fail-safe 意图注释 ×9、冗余 re-export 删除 ×1（净 +9/−11，-2 行，行为零变化）。
- **验证**：`pnpm typecheck` ✅（含 edgeclaw-memory-core）；`pnpm lint` 全量 ✅（event-matrix/patent-sop/workflow-docs/html-templates/skills 各子门禁 fresh，无事件面改动故无需重生成矩阵）；改动目录 `biome check src/knowledge` ✅（46 文件）；全仓 format:check 仅报 `.claude/settings.local.json`（未跟踪/pre-existing，C15/C17 已记录，非本次引入）；`pnpm test` 3812 pass / 0 fail / 4 skip ✅。
- **提交**：`refactor(knowledge): 为 9 处无参 catch 补 fail-safe 意图注释，删除 assemble 冗余 re-export（C18）`

#### C21 src/session + task + status + pilot（2026-08-27）

- **审阅范围**：54 文件 / ~9.5K 行（session 34 / 5971、task 4 / 587、status 2 / 179、pilot 14 / 2760）。
- **审阅发现**：
  - P0 候选 ×6（只登记，另开 fix 卡）：
    1. `SessionMetadataStore.saveAiTitle` 两分支逐字相同死条件（疑"已有 title 不覆盖"逻辑未完成）；
    2. `FileHistoryStore.safeReadText` if/return-null 与 fallthrough return-null 恒等——非 ENOENT 错误（如 EACCES）被静默当"文件不存在"计入 diff stats；
    3. `TranscriptReader.ts:484` legacy 缓存路径只拷贝 entries 不拷贝 diagnostics（与 :173 tail 路径不一致），调用方 mutate 可污染进程级缓存；
    4. `BackgroundTaskRuntime.entries` 永不清理 + `maxTasks`（32）硬上限——长生命周期 gateway 累计 32 次 start() 后永久抛错，已完成任务 entry + 1MB 环形缓冲常驻；
    5. `parseMemoryConfig` 平铺 schedule 字段（reasoningMode/autoIndex…）在 `schedule:` 段存在时静默失效且零诊断；
    6. `TaskOutputStore.readSlice` 按字节切片可切碎 UTF-8 多字节字符（预览层 U+FFFD，nextOffset 字节语义自洽）。
  - P2 死代码删除：`src/session/worktree/index.ts` 孤儿 barrel（7 个 shared/paths re-export 全仓零消费）+ `session/index.ts` 对应转出；`SessionList.listAllSessions`/`searchSessionsByTitle` + `ListAllSessionsOptions`/`SearchSessionsByTitleOptions`（零消费零测试）；pilot `createPilotConfigStore`（async 转发 Sync 版，零消费）、`PilotRouterConfig` 别名、`PilotConfigDiagnostic.redactedValue` 死字段（零写零读）；barrel 死 re-export ×11（pilot config/index.ts ×4、task/index.ts ×3、status/index.ts ×3；类型本体保留，模块内部仍在用）。
  - P2 重复收敛：`mergeMetadata` 在 TranscriptReplay.ts 与 SessionMetadataStore.ts 逐字重复 ×2 → TranscriptReplay 改 import（metadata→transcript 仅类型依赖，无环）；BackgroundTaskRuntime stdout/stderr data handler 同体 ×2 → `onChunk`；parseToolsConfig enabled 解析块 ×2（仅 code/path 前缀差异）→ `parseEnabledFlag` helper（诊断消息逐字保留）。
  - P3：无参 catch 补 fail-safe 意图注释 ×11（FileHistoryStore:350、SessionLiteReader:44、SessionList:94/111/304/339/400、ToolResultsCleanup:81、searchChatHistory:240/260/317；原 19 处中 8 处已有注释、1 处随 listAllSessions 删除）；`wait().timedOut` 改 `outcome !== "completed"`（三分联合上数学等价）；FileArtifactCollector mimeTypeForPath 同参双调用提局部变量；WorkspaceLedger `cloneLedger` 单调用点单行转发内联。
  - 记录不处理：`replaySubagentTranscript.ts` 零消费零测试，但系 C3.S5 规划的 SDK 预留入口（按 C07/C17 占位桩判例保留）；pilot `getDiagnostics()` 接口方法零调用（API 面收缩留决策）；跨文件重复：`isNotFoundError` filesystem 内 ×3、provider/model 拆分 ×3、`readOptionalPositiveInteger` ×2（C04 判例：跨文件重构不处理）；`killForAgent`/`killAll` 各 4 行微重复（提取加间接层）；status 本地 `isRecord` 不排数组与 schema.ts 规范版不一致（当前调用点无数组入参）；types.ts 死 union 成员（"project"/"bootstrap"/"error"/"invalid"）疑预留契约面。
  - 测试缺口登记：`resumeAgentSession.ts`（138 行，仅集成间接触达）、`formatChatHistorySearch.ts` 零直接测试。
  - P0（已证实行为缺陷）：无。横切扫描：零裸 console、零 any/@ts-expect-error、零 TODO/FIXME。
- **精炼项**：死代码/死导出删除 15 组、重复提取 3 组、catch 注释 ×11、微清理 3 处（净 -约 330 行）
- **验证**：`pnpm typecheck` ✅（含 edgeclaw-memory-core）；改动目录 `biome check` ✅（92 文件）、`eslint` ✅ 0 error/0 warning；`pnpm lint` 全量 ✅（event-matrix 重生成：session/cron 行号偏移）；`pnpm format:check` ✅；`pnpm test` 3924 pass / 0 fail / 4 skip ✅（session/task/status/pilot 套件全绿）
- **提交**：`refactor(session): drop dead exports, merge duplicate mergeMetadata, document fallback catches`、`refactor(task): drop dead barrel re-exports, dedupe child process output handlers`、`refactor(status): drop dead type re-exports`、`refactor(pilot): drop dead config exports and dedupe enabled-flag parsing`
- **fix 卡回执（2026-08-28）**：本卡登记的 6 个 P0 候选已按排序修复（①④⑤⑥ 直接修复，③ 改为告警可审计，⑧ 判定为调用方已实现保护后移除死分支），详见进度表 2026-08-28 FIX 行与 `docs/notes/implemented/2026-08-28-p0-fix-batch-c21-c22.md`。

#### C22 src/cron + src/rule（2026-08-27）

- **审阅范围**：29 文件 / ~4.9K 行（cron 18 / 3036、rule 11 / 1867）。
- **审阅发现**：
  - P0 候选 ×2（只登记，另开 fix 卡）：
    1. `CronManager.ensureRuntime`：`runtime.start()` reject 后 runtime 已入 `this.runtimes` 而 starting 条目被 finally 清除，后续 ensureRuntime 命中 existing 分支直接返回未启动 runtime——定时任务静默不触发、无重试无告警；
    2. `CronRuntime.runTaskNow` 裸 `new Date()` 绕过注入时钟（同文件其余路径均 `this.now()`，fake-clock 测试漂移），且多次 run-now 累积一次性任务、原任务 lastRunId 不更新。
  - P2 死代码删除：`CronTaskStore.getTask`（全仓零消费）、`replaceTask`（生产零消费，连带 cron-fire.spec mock 的 replaceTask/replaceCalls/replaceResults/replaceOk 死脚手架）；`resolveRuleAsset`（孤儿导出，模块头注释描述的定位策略复用属实，仅该函数无消费者）；cron barrel `defaultCronConfig`（模块内 parseCronConfig 自用保留）。
  - P2 重复收敛：CronRuntime createTask/updateTask「归一化+时区+nextRunAt 校验」块 ×2（8 行，错误文案逐字保留）→ 私有 `resolveScheduleAndNextRunAt`；CronFire 标题截断表达式 ×2 → `firstLineTitle`；patent-compliance「加载 compliance → 缺失即降级告警」序列 ×3 → `loadComplianceBase`；CronTaskStore listRuns/readTaskFile `normalizeRun(parsed) ? [normalizeRun(parsed)!] : []` 双调用 ×2 → 局部变量消除断言。
  - P2 一致性：`CronFire.updateTaskAfterRun` 死参数 `outcome`（`void outcome;` 压 lint）→ 连带删除；`CronScheduler.scheduleNextTick` 冗余 `as Promise<void>`（catch 返回已是 Promise<void>）；`RuleEngine:121` 恒真三元（CITATION_RE 捕获组只会是两法条名之一）→ `const statuteName = match[1]`（C01 死三元判例）。
  - P3：无参 catch 补意图注释 ×6（CronTimezone:5 Intl RangeError→无效时区、CronStoreMigration:155 坏行入 invalidRunLines 不丢数据、:377 copyFile 回退 temp 清理、CronTaskStore:116 坏行跳过、:198 temp unlink ENOENT best-effort、RuleEngine:97 非法正则防御性视为不命中）+ `mapCronRunOutcome` 末行补「四值已穷尽、防御脏数据」注释。
  - 记录不处理：RuleLoader structural_analysis/synonym_match 要素循环近逐字（字段名/regex 校验/错误文案三处差异，参数化有漂移风险，C12 判例）；CronManager discoverCronProjectKeys ENOENT catch ×3（warn 文案与 rethrow 行为各异）；`CronTaskStore.writeTaskFile` 与 `CronStoreMigration.atomicWrite` 原子写跨文件重复（后续统一 util）；RuleLoader.parseCheck 116 行 / CronFire.runTask 158 行 5 层嵌套（拆分留专项）；`asset-location` findWorkspaceRoot barrel 导出零外部消费（API 面保留）。
  - 测试缺口登记：`CronManager`（332 行，含 P0-1 场景）无任何测试、`parseCronConfig` diagnostics 无直接测试、`asset-location` 无直接 spec。
  - P0（已证实行为缺陷）：无。横切扫描：零裸 console、零 any/@ts-expect-error、零 TODO、零嵌套三元（修复前仅 1 处恒真）。`src/cron/tool/` inputSchema 契约一字未动。
- **精炼项**：死代码/死导出删除 5 组、重复提取 4 组、死参数/断言清理 3 处、恒真三元 1 处、catch/防御注释 ×7
- **验证**：`pnpm typecheck` ✅；改动目录 `biome check` ✅、`eslint` ✅ 0 error/0 warning；`pnpm lint` 全量 ✅；`pnpm format:check` ✅；`pnpm test` 3924 pass / 0 fail / 4 skip ✅（cron/rule 套件全绿，cron-fire spec mock 同步精简）
- **提交**：`refactor(cron): drop dead store methods, extract schedule resolution, document fallback catches`、`refactor(rule): drop dead asset resolver, dedupe compliance base loading`
- **fix 卡回执（2026-08-28）**：本卡登记的 2 个 P0 候选已修复（ensureRuntime 失败回滚重试；runTaskNow 对齐注入时钟，孵化-自删语义经决策保留），CronManager 测试缺口已随 fix 卡补齐（cron-manager.spec 3 用例），详见进度表 2026-08-28 FIX 行与 `docs/notes/implemented/2026-08-28-p0-fix-batch-c21-c22.md`。

#### C23 src/mcp + literature + methodology（2026-08-28）

- **审阅范围**：43 文件 / ~3.4K 行（mcp 16 / 1377、literature 13 / 1284、methodology 14 / 789）。
- **审阅发现**：
  - P2 死代码：`keywordMatch.hasAnyKeyword` 全仓（src+tests）零消费 → 删除；triz.ts `TRIGGERS`/`loadMatrix`/`detectParamNumbers` 导出面零消费（内部自用，其余 8 个组件同名符号均模块私有）→ 收窄 export（triz.spec 仅消费 triz/lookupMatrixCell，核实无破坏）。
  - P2 重复收敛：`parsePluginMcpServers` streamable_http 分支 `expandMcpString(url)` 双重展开——`url` 变量在三元构造时已展开 → 直用变量；`isStringRecord` boolean 改类型守卫（`v is Record<string, string>`），env/headers 两处 `as` 断言消除。
  - P3：PluginToToolBridge 图片扩展名 mimeType 嵌套三元 ×4 层 → `IMAGE_MIME_BY_EXT` 查表（`?? "image/png"` 与原 fallback 逐字等价，C11 summarizeCheck 判例）；literature 无参 catch 补意图注释 ×2（http.ts hostOf 非法 URL→不限速放行交 networkFetch、text.ts safeCodePoint 孤立代理码位→空串跳过）。
  - P0/P1 无行为缺陷。三模块横切扫描：零裸 console、零 any/@ts-expect-error、零 TODO/FIXME；mcp 40 处无参 catch 中其余 38 处均带注释（connection.ts 竞态语义注释尤其充分）。
  - 记录不处理：4 个 connector 的 `authors()`「前 4 + et al.」格式化尾部逐字一致 ×3（跨文件，C04 判例）；`ConnectorRegistry.all()` 零外部消费（注册表 API 面，C22 asset-location 判例）；8 个 methodology 组件文件结构同构（TRIGGERS + identify/execute）但 prompt 主体全异，参数化工厂加间接层无收益（C12 判例）；`McpRuntime.ts:65` `(err as Error).message` 强转（错误消息格式化行为面，保守档不动）；mcp/literature/methodology 三个 index.ts barrel 的零消费类型导出（SatiMcpStatus/CatalogEntry/MethodologyCategory 等约 20 项）——均为域模块公共契约面/导出类型图的组成部分，按 C07 判例保留。
- **精炼项**：死函数删除 1、死导出收窄 3、双重展开 1、类型守卫消断言 2、嵌套三元查表 1、catch 注释 2（净 -4 行，行为零变化）
- **验证**：`pnpm typecheck` ✅ 0 错误；`pnpm check` 全绿（lint/event-matrix/format/skills 门禁 fresh，无事件面改动）；`pnpm test` 3943 pass / 0 fail / 4 skip ✅
- **提交**：`refactor(mcp): dedupe placeholder expansion, table-drive image mime, simplify transport fallback`、`refactor(literature): document defensive catches in http/text helpers`、`refactor(methodology): drop dead hasAnyKeyword, narrow triz module-internal exports`

#### C24 src/extension + permission + lifecycle（2026-08-28）

- **审阅范围**：53 文件 / ~5.1K 行（extension 41 / 4058、permission 7 / 915、lifecycle 8 / 150）。
- **审阅发现**：
  - P2 死代码删除 14 个文件（全部经全仓 src+tests+ui/server+scripts 消费扫描确认为零消费）：
    - `src/extension/protocol/` 目录整体（errors/source/contribution 三文件：SatiExtensionError/SatiExtensionSource/SatiExtensionContributionKind——被 `plugins/protocol/` 取代的早期词汇层草稿）；
    - `plugins/protocol/errors.ts`（SatiPluginError）、`plugins/loading/PluginContributionLoader.ts`、`plugins/runtime/PluginReloadPolicy.ts`（reload 策略词汇表，零消费零接线）；
    - `hooks/execution/aggregateHookResults.ts`（单行孤儿 barrel）；
    - `contributions/` 5 个死类型文件（Command/Hook/Tool/Mcp/PermissionRuleContribution——同一词汇族中仅 PromptContribution/RouterContribution 有 plugin.ts 消费，保留这 2 个）；
    - `lifecycle/runtime/LifecycleDispatcher.ts`（单行孤儿 barrel；agent/loop 的同名 LifecycleDispatcher 是 misc.ts 本地定义的另一符号，无关）、`lifecycle/runtime/LifecycleObserver.ts`（零消费占位类型）。
  - P2 barrel 清理：extension/index.ts 删 8 项死 re-export（含 loadPluginHooks、defaultPluginReloadPolicy、5 个死 contribution 类型）；skills/index.ts 删 hashDirectoryTree re-export（连带定义收窄 export，模块内自用）；lifecycle/index.ts 删 LifecycleObserver。
  - P2 重复收敛：`SkillManager.isValidSlug` 导出为单一事实源（JSDoc 写明迁移必须与导入同规则），migrateSkills.ts 删除内联正则副本；SkillManager scan/listSkillsIn 的「symlink→stat 验目录」块 ×2 → `statIsDirectory` helper；validateFromDisk/validateFromManifest 的规模硬限尾块 ×2 → `pushBundleLimitIssues`、单文件体积检查 ×2 → `pushFileSizeIssues`（文案逐字保留）。
  - P2 复核纠错：`AsyncHookRegistry.list()` 首查误判零消费（grep 过滤器把 `registry.list()` 误排除），typecheck 报错后核实 parse-hook-output.spec 3 处消费 → 恢复保留（同 C09 rg 漏检判例，tsc 兜底有效）。
  - P3 无参 catch 补 fail-safe 意图注释 ×14（discoverLocalPlugins ×4、PluginLoader、PluginCommandLoader ×2、loadBuiltinPlugins、parseHookOutput、matchHook（fail-closed 语义注明）、migrateSkills、migrateLegacyBundledSkills、SkillManager ×2、PermissionRuntime summarizeInput；extension 原 40 处中其余均已带注释或为显式抛错转换）。
  - P0 候选 ×1（只登记，另开 fix 卡）：`SkillManager.walkDir` 的 readdir catch 静默 return——不可读目录（EACCES）被整体跳过且不推任何 issue，fileCount/totalBytes 少报可让超限 bundle 通过 validate（import 落盘时 fs.cp 才暴露失败）。
  - 记录不处理：`toLegacyHookInput` + `SATI_NOT_APPLICABLE_LEGACY_HOOK_EVENTS`（legacy 钩子 snake_case 契约预留面，C21 replaySubagentTranscript 判例）；`isBlockingOutput` HookRuntime/AsyncHookRegistry 跨文件微重复；4 个 hook executor（Callback/Http/Agent/Prompt）结果包装结构相似但行为分支各异（C22 RuleLoader 判例）；expandHome ×2 同目录重复（泛用 util，提取需新增导出面）；`SatiLifecycleRuntimeError` 零生产抛出点、仅测试构造（疑预留错误契约面，随其 spec 保留）；parseHooksConfig shell 白名单嵌套三元、SkillManager list() 条件 spread 嵌套三元（惯用法，展平反增行数）；SkillManager.ts 904 行（保守档待拆建议）；测试缺口登记：SkillManager.scan/import 零直接 spec。
  - P0（已证实行为缺陷）：无。横切扫描：零裸 console、零 any/@ts-expect-error、零 TODO/FIXME。permission 模块质量样板（Guard 单调 deny 语义、settings 损坏 fail-closed 均有充分注释）。
- **精炼项**：死文件删除 14、barrel 死 re-export 删除 10 项、重复提取 4 组、死导出收窄 2、catch 注释 ×14（净 -约 200 行，行为零变化）
- **验证**：`pnpm typecheck` ✅ 0 错误；`pnpm check` 全绿（event-matrix 无事件面改动，未触发生成）；`pnpm test` 3943 pass / 0 fail / 4 skip ✅（extension/permission/lifecycle 套件全绿）
- **提交**：`refactor(extension): drop dead protocol stubs, contribution types and barrel re-exports`、`refactor(lifecycle): drop orphan dispatcher re-export and observer type`、`refactor(skills): share slug validation with migration, extract bundle limit checks`、`refactor(extension): document fallback catches in plugin/hook io paths`、`refactor(permission): document unserializable-input fallback`

## 六、基线（2026-08-18 实测）

| 指标 | 基线值 | 目标 | 备注 |
|---|---|---|---|
| 裸 console（src + ui/server，含 .ts/.tsx/.js） | 657 处 / 83 文件 | <300 | 含 ui/server 手写 JS 大量输出 |
| `any`/`@ts-expect-error`（src + ui/src） | 20 处 | ≤10 | 主链路清零，外围加 SAFETY 注释 |
| 无参 `catch {`（src + ui/src） | 485 处 | 显著下降 | 含防御式（有注释）与隐患（无注释）两类 |
| TODO/FIXME/HACK（src + ui + ui/server + tests） | 24 处 | ≤5 | 需逐条核实业务语义 |
| TS/TSX 文件数 | 1828 | — | 全仓 |
| 测试文件数 | 458 | — | tests/ + ui/src + ui/e2e |
| 后端 >600 行文件 | 42 | 不强制下降（保守档） | 记录待拆建议 |
| UI >600 行文件 | 26 | 不强制下降（保守档） | 记录待拆建议 |
| ui/server JS 文件 | 98 / 29.7K 行 | — | 只做行为不变清理 |

## 七、风险与护栏

- **inputSchema 红线**：任何工具 `inputSchema` 改动都会使 LLM replay fixture 失配（CLAUDE.md 明示）——精炼时禁止改动，说明性文字只放工具顶层 description
- **事件面红线**：AgentEvent/gateway frames 零改动，每卡过 `pnpm check:event-matrix`
- **子包独立验证**：C08 涉及 edgeclaw-memory-core，须先 `pnpm --filter edgeclaw-memory-core build` 再 typecheck/test
- **P0 分流**：审阅发现的行为缺陷只登记，单独开 fix 卡处理，不混入精炼提交
- **提交纪律**：一个关注点一个提交；每日至少 1 个 commit；禁一次性大杂烩提交
- **周复盘**：每周五核对指标计数变化，异常（门禁红、指标反弹）当周修复
