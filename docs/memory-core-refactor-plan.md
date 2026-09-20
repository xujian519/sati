# edgeclaw-memory-core 拆解+补测试专项实施方案

- 创建日期：2026-08-17
- 状态：**批次完成；§5 DoD（≤600 行）未达标**（2026-08-17 记为「全部完成」，2026-09-20 复核后按 §5 实测更正：5 个文件 690–1728 行，差异已登记 `docs/technical-debt/metrics.md` 的 vendored 节）——批次 0-6 落地，子包测试全绿
- 前置：`docs/technical-debt-report.md` 待决事项 #1（子包 5 个 >1000 行文件零测试）；方法论先例 `docs/god-function-refactor-plan.md`
- 目标：对 5 个大文件先补行为基线测试（characterization），再按职责聚类拆分；子包测试从 0 起步覆盖核心路径

> **验收状态（2026-09-18 补，issue #148 处置）**：本专项**没有勾选清单**（进度以批次 ✅ 标注），故此处按 `docs/issue-management.md` §6.1 的口径记一次状态复核。
>
> - **§4 批次 0–6 全部落地属实**：5 个大文件已拆解、22 个新模块、子包测试 222 例全绿（PR #88）；`llm-extraction` 3745 → 1669 行。
> - **但 §5 的验收标准未达标，这层差异此前没有记录**：§5 写「5 个大文件拆后：单文件 ≤ ~600 行」，而拆后实测 `sqlite` 1728 / `llm-extraction` 1669 / `file-memory` 1161 / `dream-review` 1072 / `heartbeat` 690 —— **五个全部 > 600**。§4 末行把剩余两个 500 行级编排方法标注为「与 G8 同档风险/收益权衡…**延期接受**」，但 §4 开头仍写「全部完成 ✅」；两句并存会让读者误以为专项已达 DoD。
> - **截至 2026-09-18 的残留**（`metrics.md`「vendored 子包」节）：≥300 行函数 **3** 个 —— `DreamRewriteRunner.run` 524（`src/core/review/dream-review.ts`）、`ReasoningRetriever.retrieve` 484（`src/core/retrieval/reasoning-loop.ts`）、`HeartbeatIndexer.runHeartbeat` 477（`src/core/pipeline/heartbeat.ts`）。注意 §4 的「剩余深化候选」只列了前两个，**`retrieve` 未在名单内**。
> - **本仓对它的排期口径已变**：2026-09-16（#341）把该子包**整体移出**规模 / Top 大文件 / God function 三处文件级指标（理由：外部搬入、不随本仓演进），改在 `metrics.md` 单列；`docs/god-function-refactor-plan.md` §范围边界亦声明「**不含** `edgeclaw-memory-core` 子包内的大文件…单独排期」。⇒ 它的现状**不再进入债务排期表**。
> - **因此 issue #148 按「不再适用」关闭（2026-09-18）**：它引用的 1710 / 1623 / 1138 正是**拆分后**的尺寸（与今天实测逐字一致），正文却读起来像从未拆过；而其触发条件「随下个记忆相关里程碑（M1/M2 增强时）一并拆分」在仓库里**不存在对应里程碑**，属不可证伪的阻塞。**若本仓今后开始实质修改该内核，重启条件**：按上面 3 个 ≥300 行函数立项，验收判据为「`metrics.md` 的 vendored 节 ≥300 行函数 **3 → 0**」。

## 1. 背景与范围

edgeclaw-memory-core 是 Sati 记忆核心的独立 workspace 子包（17 个 TS 文件、约 14.5k 行，8 个 src 消费点经包名 `edgeclaw-memory-core` import）。债务：

- **5 个 >1000 行文件占 62% 行数**：llm-extraction 3745 / sqlite 2024 / file-memory 1632 / dream-review 1532 / heartbeat 1019
- **子包内零测试**（root tests/ 有 8 个经公共 API 的集成级间接覆盖：heartbeat-extract / dream-rollback / reasoning-route / memory-provider 等，均真实 sqlite + stub LLM）

### 硬约束
- **公共 API 导出面不可变**（`src/index.ts` → `core/index.ts` 的 `export *` 面，8 个消费点依赖）
- 子包独立构建链（`pnpm --filter edgeclaw-memory-core build` → lib/，gitignored）；root prebuild 已含子包编译
- 子包 tsconfig include 仅 `src/**/*.ts`——测试文件放 `tests/`（不污染 lib 产物）
- root eslint ignore 子包；biome 仅 format

### 测试基建（已落地）
- `package.json` 新增 `"test": "node --import tsx --test \"tests/**/*.spec.ts\""`（tsx 经 pnpm 提升可从子包解析，冒烟验证通过）

## 2. 调研结果（5 路并行测绘）

> 以下为各文件测绘报告的汇总（完整报告由子代理产出）。

### 2.1 heartbeat.ts（1019 行）✅ 已测绘

- **runHeartbeat 巨型主方法 477 行**（542–1018）+ 20 个纯 helper（59–410）+ routeGeneralCandidate 77 行（437–513）+ 3 接口
- 聚类：消息增量合并 / token 化与打分 / 预览渲染 / trace 构造 / 类型常量 / 主流程
- 发现 2 个死 import（listDetail、decodeEscapedUnicodeValue）可一并清理
- 基线建议：fake repository + fake extractor 锁定 runHeartbeat 增量 checkpoint 语义与 routeGeneralCandidate 三分支路由

### 2.2 dream-review.ts（1532 行）✅ 已测绘

- **DreamRewriteRunner 类 1008 行**（525–1532），4 个方法全超 80 行：run 524 / runCategoryDream 238 / runProjectMetaReview 119 / mergeGeneralProjectMetas 112
- G1–G6 约 370 行（类型/常量、路径守卫、trace 基建、文本渲染、LLM 映射、审查校验器）可平移为独立模块
- validateExclusiveClusters 111 行含两大正则表（12+8 英文、20+15 中文）
- 基线建议：validateExclusiveClusters 丢弃规则 / No-op 早退 / trace 步骤顺序 / 用户笔记保护 / selectUserNoteWindow 预算 / mergeGroup keeper / shouldUpdate 判定 / 排序截断 / outcome 计数 / detail decode:false 契约

### 2.3 llm-extraction.ts（3745 行）✅ 已测绘

- **LlmMemoryExtractor 类 1503 行**（2242–3745）+ **104 个内部函数** + 23 导出类型 + 14 项死代码（~130 行，含与实现漂移的 `EXTRACTION_SYSTEM_PROMPT`）
- 最大单体 5 个（占 25%）：extractFileMemoryCandidates 439 / callStructuredJson 190 / selectIndexProject 116 / selectRecallProject 108 / createMemoryNote 99
- 8 组聚类：G1 HTTP 重试层 / G2 提示词常量 / G3 Prompt 构造 / G4 JSON 宽松解析 / G5 类型 / G6 归一化 / G7 项目 hint 信号 / G8 编排门面（17 公开方法）
- **依赖面极干净**：运行时仅依赖 `../utils/text.js` 的 truncate——全部函数可平移，无循环依赖风险
- 基线建议 10 条（JSON 状态机边界 / 宽松解析正则 / 重试判定退避 / note_absorption 删除安全 / Dream 白名单 / 项目兜底排序 / 分类归一 / provider 形态差异 / hint 正则链 / 提示词快照）

### 2.4 sqlite.ts（2024 行）✅ 已测绘

- **MemoryRepository 类 1540 行 / ~90 方法**（485–2024）+ 约 30 个模块级 helper；无超 80 行单体（最大 listReadableProjectCatalog 93 行）——拆解对象是类整体而非巨方法
- **驱动为 node:sqlite DatabaseSync**（动态 import，非 better-sqlite3）+ Bun 条件回退；SQL 层可用 `:memory:` 直测
- 死代码：sameDreamRuntimeState（全仓无引用）
- 消费面窄（barrel + dream-review/reasoning-loop/heartbeat），保持类名即可零改动拆解
- 基线建议 12 条（DDL/索引契约 / upsert 幂等 / 复合序平局 / 迁移幂等 / bundle 校验 / 路径穿越防护 / 回滚版本门禁等）

### 2.5 file-memory.ts（1632 行）✅ 已测绘

- **FileMemoryStore 类 1047 行**（586–1632，53 成员）+ 36 个模块级小函数；**无超 80 行单体**——广度型大文件，按 8 簇职责切片
- 自然模块边界：H4 project meta 域 / H7 维护导出 / C+D+E markdown 解析构建
- 基线建议 10 条（CRLF frontmatter 解析缺陷 / slugify 误合并 / 路径穿越守卫等对抗性边界）

## 3. 方法论（沿用 god-function 专项）

1. 行为不变：复制+删除+import，不改函数体
2. 先纯函数后状态：无状态纯件先抽（可独立测试）
3. 行为基线测试先行（characterization）：拆前锁定语义
4. 每批一个 PR、独立可验收
5. 门禁：子包 `pnpm --filter edgeclaw-memory-core typecheck` + `pnpm --filter edgeclaw-memory-core test` + root typecheck/lint/format/test（root test 用 lib/ 编译产物，须先 build）

## 4. 批次规划

- **批次 0**：测试基建（package.json test 脚本 + tsx 验证）——✅ 已完成
- **批次 1**：死代码清理（llm-extraction 11 项 ~130 行 + sqlite sameDreamRuntimeState + heartbeat 2 死 import）+ 首批拆解（llm-json.ts / request-retry.ts）+ 42 基线测试——✅ 已完成
- **批次 2**：heartbeat 纯 helper 下沉 heartbeat-helpers.ts（1019→690 行）+ 23 基线测试——✅ 已完成
- **批次 3**：dream-review 拆出 6 个子模块（dream-types/paths/detail/trace/mappers/validators，1532→1072 行）+ 25 基线测试——✅ 已完成
- **批次 4**：sqlite 模块级 helper 下沉 sqlite-helpers.ts（2024→1728 行）+ 23 测试；file-memory 拆出 4 子模块（constants/text/markdown/manifest，1632→1161 行）+ 25 测试——✅ 已完成
- **批次 5**：llm-extraction 模块级下沉（G1/G4 llm-json+request-retry、G6 llm-normalizers、G7 llm-hints、G2/G3 llm-prompts、抽取 llm-extraction-item、HTTP llm-http）——✅ 已完成
- **批次 5c（G8）**：类方法级拆分——extractFileMemoryCandidates 438→154（信号/归一/过滤/提示词/userPrompt 全纯函数化）、callStructuredJson 190→116（请求体/重试执行下沉 llm-http）、selectRecallProject 108→49、selectIndexProject 116→56（prompt 构造 + 判定下沉）——✅ 已完成；剩余编排骨架（extract 154/callStructuredJson 116/createMemoryNote 100）按 god-function 先例口径接受
- **批次 6**：收尾——方案文档、全量验证、PR #88（主体）+ G8 分支 PR——✅ 已完成
- **剩余深化候选（2026-08-17 code-review 标注，非本次范围）**：dream-review.run() 523 行（13 pushStep + 5 extractor 调用）、heartbeat.runHeartbeat() 476 行——两个巨型编排方法，与 G8 同档风险/收益权衡，作为下一轮拆解自然候选；无行为缺陷、测试全绿，延期接受

> 状态：子包测试 **222 例**全绿；root memory 55 用例绿。5 个大文件全部拆解 + 22 个新模块；llm-extraction 3745→1669 行（类方法全部 ≤116 行，业务逻辑全下沉）。

## 5. 验收标准

- 5 个大文件拆后：单文件 ≤ ~600 行（巨型主方法拆出后），纯函数/数据类 ≤ ~200 行
- 子包测试覆盖：行为基线 + 拆解新增盲区用例，`pnpm --filter edgeclaw-memory-core test` 全绿
- 公共 API 导出面零变化；root typecheck/lint/format/test 全绿
