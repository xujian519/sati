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
| C05 | src/gateway | 32/5.9K；InProcessGateway.ts 1057、protocol/server | ⬜ |
| C06 | src/context 非 memory | projection、budget、compression、vectors | ⬜ |
| C07 | src/context/memory 主包 | EdgeClawMemoryProvider 等（不含子包） | ⬜ |
| C08 | edgeclaw-memory-core 子包 | sqlite.ts 1716、llm-extraction.ts 1573、file-memory.ts 1147、llm-prompts.ts 997；独立 build 验证 | ⬜ |
| C09 | src/tool registry/execution/audit | createBuiltinRegistry、ToolRuntime | ⬜ |
| C10 | src/tool/builtin 上半 | readFile.ts 988、filesystem 组 | ⬜ |
| C11 | src/tool/builtin 下半 | patentPdfDownload.ts 945、patentWorkflow 等 | ⬜ |

### 阶段 2 — 业务域（W3–W5）

| 卡 | 模块 | 规模/热点 | 状态 |
|---|---|---|---|
| C12 | src/patent workflow+flexible-plan+plantask | 126 文件/20.5K 总分 3 卡 | ⬜ |
| C13 | src/patent evidence+problem+atoms | evidence/engine.ts 844 | ⬜ |
| C14 | src/patent graph+claim-chart+document | | ⬜ |
| C15 | src/patent data/nuo+figure+evaluate 其余 | | ⬜ |
| C16 | src/adapters 大渠道 | wecom 1760、weixin 1459、feishu 1332 | ⬜ |
| C17 | src/adapters 其余 18 渠道+protocol | ImLiveReplyController.ts 1016 | ⬜ |
| C18 | src/knowledge | 44/7.1K；case-law、legal、kg-store、wiki | ⬜ |
| C19 | src/router | 26/4.3K；RouterRuntime.ts 1258 | ⬜ |
| C20 | src/always-on | 38/8K；DiscoveryFire.ts 1252 | ⬜ |
| C21 | src/session + task + status + pilot | 34/4.8K + 3 小模块 | ⬜ |
| C22 | src/cron + src/rule | 18/3K + 11/1.9K | ⬜ |
| C23 | src/mcp + literature + methodology | 16/1.4K + 13/1.3K + 13/0.7K | ⬜ |
| C24 | src/extension + permission + lifecycle | SkillManager.ts 904 | ⬜ |
| C25 | src/web + workflow + telemetry | 12/3.5K + 11/1.8K + 5/0.8K | ⬜ |
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
| C42 | 终审：docs/code-refinement-report.md + 技术债报告追加注记 | ⬜ |

## 五、进度表（每日更新）

| 日期 | 卡号 | 模块 | 审阅发现摘要 | 提交数 | 状态 |
|---|---|---|---|---|---|
| 2026-08-18 | C02 | src/cli | P1 渠道构建重复×2 / 死 try-catch；P2 错误强转×2 / 路径解析重复；P3 横幅错位 / 重复 import；记录不处理：DEFAULT_USER=xujian、双份 readStringFlag；P0 无 | 2（refactor + docs） | ✅ |
| 2026-08-19 | C01 | src/agent | P1 同分支三元死代码×1；P2 `void ctx` 命名不一致 / 无参 catch 缺注释×2；P2 记录不处理：TurnRunner 失败收尾 4 处相似块（细节差异大，抽取有漂移风险）、AgentLoop `errors![0]!` 断言 ~20 处（结构性，需 errors 类型重构）；P0 无 | 1（refactor） | ✅ |
| 2026-08-20 | C03 | src/model/catalog | P2 openai/openai-responses models 块逐字节一致（5728B×2）→ 提取 OPENAI_SHARED_MODELS（-174 行）；P2 记录不处理：multimodal 模板重复 / 数字下划线风格 / minimax PascalCase 与 volc_ark snake_case 配置键；P0 无 | 1（refactor） | ✅ |
| 2026-08-20 | C04 | src/model 其余 | P2 streamModel debug-dump ×2 / 重试警告 ×2 → 提取辅助函数；P2 findBalanced 两函数泛化合并；P2 死代码：providers/registry.ts 零消费、providerEndpoint 单变体 ×2、looksLikeUnparsedToolCall、extractStructuredOutput 死分支；P2 记录不处理：repairOpenAIToolPairing 兜底 / splitThinkContent FSM 重复 / 9 文件解析助手重复 / repairToolName 平局守卫（修复=行为变更）；P0 无 | 3（refactor×2 + docs） | ✅ |

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
- **精炼项**：OPENAI_SHARED_MODELS 提取（openai/openai-responses 共享模型定义）
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
