# 巨无霸函数拆解专项实施方案

- 创建日期：2026-08-16
- 状态：**实施中——A1（reasoning-rules 拆 4 组）✅ + A2（workflow 类型/manifest 纯搬移）进行中**
- 前置：`docs/technical-debt-report.md` Sprint Backlog #6 / #7 残留 / #12；方法论先例 `docs/agentloop-refactor-plan.md`
- 调研方法：7 个目标文件逐行结构测绘（5 路并行只读调研 + 跨切面协调核查），全部行号证据以 2026-08-16 工作区实测为准

---

## 1. 背景与范围

技术债报告（2026-08-12 二次审计）把"巨无霸函数/上帝文件"列为 P1/P2 债务：

- **Sprint Backlog #6**：Top 5 巨无霸函数（`McpClient.ts` / `reasoning-rules.ts` / `legal-search.ts` / `kg-store.ts` / `workflow.ts`）各拆成 ≥3 个职责清晰的函数或独立文件。DoD：**拆后平均行/函数 ≤ 100，对应 spec 全绿**。
- **Sprint Backlog #7 残留**：AgentLoop 拆解已于 2026-08-14 完成（4685 → 8 模块，见 `docs/agentloop-refactor-plan.md`）；**`InProcessGateway.ts`（2344 行）为剩余工作**，且是"零直接单测的高风险文件"。
- **Sprint Backlog #12**：`ui/server/index.js`（3845 行）机械分片。DoD：**拆后单文件 ≤ 500 行，`index.js` ≤ 400 行（作 entry 只做组装），`pnpm --filter sati-ui test` 全绿**。

本次调研对以上 7 个文件做了逐行测绘（结构/职责/接缝/依赖/测试覆盖/风险），产出本方案。核心结论：**除 InProcessGateway 外，其余 6 个文件都有低风险、可独立验收的"纯搬移/纯数据"第一轮**；InProcessGateway 需先补行为基线测试（含治理 1 个源码扫描伪测试）再动结构。

### 范围边界

- **不含** `edgeclaw-memory-core` 子包内的大文件（`llm-extraction.ts` 3737 行等 5 个 >1000 行文件）：子包独立 workspace、root eslint 明确 ignore、构建链独立，单独排期（见 §9 待决事项）。
- **不含** 2117 行的 `AgentLoop.ts` 本体：run() 已骨架化（~80 行）+ 9 个阶段方法，属"阶段方法可继续细分"的持续工程，不在本专项。
- **不含** 裸 console / any 收敛（#10/#11 持续工程项），仅当拆解轮次路过时顺带清理。

---

## 2. 现状快照（2026-08-16 实测）

| 文件 | 行数 | 形态 | 直接测试 | 间接测试 | 事件矩阵耦合 | 拆解风险 |
|---|---|---|---|---|---|---|
| `src/patent/checker/reasoning-rules.ts` | 438 | **1 个纯数据函数**（24 条规则字面量） | checker.spec.ts 6 用例 | problem-rules / 工具集成 | 无 | **极低** |
| `src/patent/workflow.ts` | 751 | 2 函数 + 17 类型 + 7 个 manifest 数据 | workflow.spec 11 + retry 8 + store 3 + atoms 4 | graph 等价性 3 用例（关键护栏） | 无 | 低→中（图等价性） |
| `src/knowledge/shared/kg-store.ts` | 406 | 1 class + 1 纯函数 | 3 spec 共 25 用例 | patent-kg-adapter | 无 | 低→中（双 schema 回归面） |
| `src/knowledge/legal/legal-search.ts` | 391 | 1 class + 1 纯函数 | 2 spec 共 13 用例 | memory-providers（集成，缺库 skip） | 无 | 低→中（跨域共享函数） |
| `src/mcp/client/McpClient.ts` | 425 | 1 class（五类职责混杂） | McpClient.spec 9 用例 | McpRuntime.spec 12 用例 | 无 | 中（连接并发不变式） |
| `src/gateway/client/InProcessGateway.ts` | 2344 | 1 class（62 成员）+ 38 模块级自由函数 | **无直接单测**（9 个 spec 间接） | 9 个 gateway spec | **重度**（5 类事件生产点 + submitTurn 流 ×27 消费点） | **高** |
| `ui/server/index.js` | 3845 | 手写 JS（无类型） | 无直接测试（顶层执行 startServer 不可导入） | utils/routes/services 19 个 test | 无 | 中（纯机械分片，JS 无类型兜底） |

已确认的关键环境事实（跨切面核查）：

1. **事件矩阵按 `file:line` 硬编码生产/消费点**（`scripts/gen-event-matrix.ts:107` → `docs/event-producer-consumer.md`），`pnpm check:event-matrix` 挂在 `pnpm lint` 末尾（`package.json:31`）。**任何代码跨文件移动后必须 `pnpm gen:event-matrix` 重新生成**，否则 lint 门禁必红。InProcessGateway 是矩阵中的高频生产者（`assistant_text_delta:322`、`error:362`、`assistant_attachment:1693`、`agent_status:351`）与 submitTurn 流消费点（`:490`）。
2. **伪测试耦合**：`tests/gateway/weixin-settings-runtime-flow.spec.ts:64-77` 用 `readFileSync` 读 `src/gateway/client/InProcessGateway.ts` 源码字符串断言 `prepareWeixinLogin` 存在——拆该文件必碎此测试，须先行改造（见 §5.6）。
3. **barrel 稳定性约束**：`src/patent/index.ts`、`src/knowledge/index.ts`、`src/mcp/index.ts` 的导出面被 16+ 处消费（工具层/内部模块/9 个 spec）。拆解一律"保留原文件路径作门面 re-export"或"新目录 + index.ts barrel 保持原导出签名不变"，禁止改名/改签名。
4. **既有手术痕迹**（`docs/performance-review.md` 已登记的语义，必须作为回归护栏）：kg-store trigram 探测与动态 prepare、legal-search 语句合并与 `hasFts` 双条件探测、workflow 并行窗口（同 atom 无 retry 才并行——审批门不得并行）、McpClient 的 M5 会话过期重试与 M5b 超时回收。
5. **git 治理**：main 受保护（required checks + enforce_admins），实施走 PR + squash；Conventional Commits，本轮类型统一 `refactor(<scope>)`。
6. **验证门禁顺序**：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`；迭代期可用快路径 `node --import tsx --test tests/<module>/*.spec.ts`；ui/server 分片轮次用 `node --check` + `pnpm --filter sati-ui test`。

---

## 3. 方法论（沿用 AgentLoop 拆解先例 + 本轮补强）

1. **行为不变**：每步抽取后 typecheck + lint + 相关测试 + 全量测试；"复制 + 删除 + import"迁移，不改函数体。
2. **先纯函数后状态**：无状态纯件先抽（可独立测试），有状态/并发不变式的核心最后。
3. **行为基线测试先行（characterization）**：动工前先补基线用例**锁定原语义而非改写**（AgentLoop 先例：基线测试发现并锁定 `stripTrailingErrorPair`/`mergeUserRules` 两处非显然语义）。
4. **每轮一个 PR、独立可验收**：轮次 = 1 次 squash merge；每轮附 DoD。
5. **本轮新增约束**：
   - 涉及跨文件移动的轮次必须同步 `pnpm gen:event-matrix`；
   - 涉及 InProcessGateway 的轮次必须先改造源码扫描伪测试；
   - 数据型文件（reasoning-rules/manifest）不适用"行/函数 ≤100"硬指标，改为**"每函数单一职责数据组 + 单组 ≤ ~110 行"**（对齐 `core-rules.ts` 11 组函数范式），逻辑型文件仍守 ≤100；
   - 拆解顺带处理被 performance-review 点名的热路径问题（如 `likeSearchTerms` 动态 prepare）需单独标注，不混入纯搬移轮次。

---

## 4. 全局协调项（每轮通用清单）

- [ ] 动工前：确认行为基线测试存在（否则先补），记录本轮基线用例清单
- [ ] 实施：`复制 + 删除 + import`，不改函数体；门面文件 re-export 保持对外签名
- [ ] 门禁：`pnpm typecheck` → `pnpm lint`（含 event-matrix --check）→ `pnpm format:check` → `pnpm test`（或快路径定向测试）
- [ ] 跨文件移动时：`pnpm gen:event-matrix` 并复核 diff 无事件边丢失
- [ ] 提交：`refactor(<scope>): <subject>`，每轮一 PR（squash merge）
- [ ] 收尾：更新本文档轮次状态；命中 backlog DoD 时同步更新 `docs/technical-debt-report.md` 对应条目

---

## 5. 分文件拆解方案

### 5.1 `src/patent/checker/reasoning-rules.ts`（438 行 → 聚合层 + 4 组文件）★ 第一优先

**本质**：纯数据函数 `reasoningPatternRules(): CheckRule[]`（L58-438），返回 24 条规则字面量（创造性 7 / 新颖性 6 / 权利要求+说明书 5 / 其他 6），零副作用、零 LLM、零事件。同伴 `core-rules.ts` 早已按域拆成 11 个函数，本文件是"补齐欠账"。

**目标布局**（平铺，对齐 core-rules.ts 风格，diff 最小）：

```
src/patent/checker/
  reasoning-rules.ts        # 聚合层：import 4 组 + return [...四组]（<20 行）
  reasoning-creativity.ts   # REASON-CREATIVITY-* 7 条（原 L60-168）
  reasoning-novelty.ts      # REASON-NOVELTY-* 6 条（原 L170-257）
  reasoning-claims.ts       # REASON-CLAIMS-* 5 条（原 L259-341）
  reasoning-other.ts        # REASON-OTHER-* 6 条（原 L343-436）
```

**轮次**（可一轮完成，风险近零）：

1. 按 4 个注释段抽 4 个函数/文件，`reasoningPatternRules()` 改为展开合并——**对外签名与 24 条顺序逐条不变**。`rules.ts:22/55`、`index.ts:83` 的双重 re-export 零改动。
2. 补盲区测试：4 组条数断言（7/6/5/6）+ 24 条 id 唯一性校验 + 抽样 `pathElements` 层级断言。

**基线测试**（拆前跑、拆后全绿）：
- `checker.spec.ts`：`reasoningPatternRules: 24 条且并入 defaultPatentRules`（L247）、4 个推理模式行为用例（公知常识/四相同 × 通过/阻断）、`defaultPatentRules: 总条数 = 71`（L397）
- `problem-rules.spec.ts:125` 经 defaultPatentRules 的间接评估

**风险**：规则顺序/总数护栏（24/71 两条断言会红）；`pathElements` 嵌套层级复制粘贴错乱由 strict 类型兜底；4 文件各自只 import 用到的 `TERM_*` 常量子集（遗漏由 typecheck 暴露）。

**DoD**：`reasoning-rules.ts` ≤ 20 行（聚合），4 个新文件各 ≤ ~110 行；checker 相关 spec 全绿。

> ✅ **A1 已完成（2026-08-16）**：拆为 `reasoning-creativity.ts`(7 条)/`reasoning-novelty.ts`(6 条)/`reasoning-claims.ts`(5 条)/`reasoning-other.ts`(6 条)，`reasoning-rules.ts` 438→24 行聚合层；新增 2 个盲区测试（组条数 7/6/5/6 + id 唯一性、pathElements string[][] 层级）。typecheck/lint（event-matrix fresh）/format/全量测试绿。`rules.ts`/`index.ts` 零改动。

---

### 5.2 `src/patent/workflow.ts`（751 行 → 目录化，executor 参数化）

**本质**：751 行中 ~430 行是零逻辑资产（17 个类型 + 7 个 manifest 数据），真逻辑只有 `validateWorkflowManifest`（49 行）与 `runWorkflow`（247 行，闭包共享 state/results/rewindCounts/signalCache）。文件自身零事件/telemetry/i18n 耦合；但 `graph/adapter.ts` 以"与 runWorkflow 输出等价"为契约（3 个等价性测试是**最强回归护栏**）。

**目标布局**（`src/patent/workflow/` 目录 + 原路径门面）：

```
src/patent/
  workflow.ts              # 门面 re-export（保持 "workflow.js" 解析路径不变，NodeNext 兼容）
  workflow/
    types.ts               # L31-146 全部类型/接口 + WorkflowError（原 L148-153）
    validate.ts            # validateWorkflowManifest（原 L159-207）
    signal.ts              # signalMatches + signalFor（原 L244-271，纯函数）
    executor.ts            # runStageOnce 参数化（原 L273-337）
    run.ts                 # runWorkflow 骨架 + pushResult + 主循环 + 回退（原 L215-461 其余）
    manifests.ts           # 7 个 manifest + BuiltinPatentManifest + builtinPatentManifests（原 L463-751）
    index.ts               # barrel re-export
```

**轮次**：

1. **纯搬移**（零逻辑）：类型 → `types.ts`、manifest 数据 → `manifests.ts`。效果：`workflow.ts` 751 → ~250 行，"2 函数平均 321 行"债直接消掉；同时 `workflow-store.ts`/`workflow-dag.ts`/`graph/adapter.ts`/`flexible-plan.ts` 的 type import 改指 `types.ts`，**解除 4 个模块对执行器文件的类型耦合**。
2. **纯函数**：`signalMatches` → `signal.ts`（模块级 `signalMatches(text, regex)`），配套新增 `tests/patent/workflow/signal.spec.ts`（否定词窗口/句界排除/g-flag `lastIndex` 重置/空匹配自增）。
3. **核心参数化**：`runStageOnce` → `executor.ts`，7 个闭包变量（state/handlers/atoms/provider/executor/maxRetries/approvalGrants/ctx）全部显式参数化；`run.ts` 保留主循环 + 回退 + 汇总。
4. （可选深化）主循环的并行窗口计算与 retry 回退分支抽为独立辅助函数，`runWorkflow` 只留编排。

**基线测试**：
- `workflow.spec.ts` 全 11 例（重点：审批门 interrupted / approvalGrants 命中放行）
- `workflow-retry.spec.ts` 全 8 例（重点：一致性信号回退 / 否定式不触发 / 回退后状态回滚）
- `workflow-store.spec.ts` 3 例（persist 语义：saveRun throw 仅告警）
- `atoms.spec.ts` 4 例（atom 分发合并 / 未注册 atom fail-fast / executor 可选兼容）
- **`graph/adapter.spec.ts` 3 个等价性用例（L105/L126/L192）——最高权重护栏**
- `claim-chart/manifests.spec.ts` 目录注册断言

**风险**：轮次 3 不得改变 `runStageOnce` 副作用顺序（`Object.assign(state, segment)` 时机、输出键解析、degraded 前缀 `[WORKFLOW_DEGRADED]`）；`approvalGrants` 经 `APPROVAL_GRANTED_KEY` 注入 execState 的逻辑不可漏参；manifest 数据搬移一字不改（结构被 2 个 spec 断言）；g-flag 正则跨调用状态污染。

**DoD**：`runWorkflow` ≤ 100 行（编排骨架），`runStageOnce` ≤ 80 行；`workflow/` 目录化后原 `workflow.js` 导入路径全部可用；等价性测试 + 全量 patent spec 绿。

> ✅ **A2 轮次 1 已完成（2026-08-16）**：类型契约 + WorkflowError → `workflow/types.ts`，7 个内置 manifest + 目录 → `workflow/manifests.ts`，`workflow/index.ts` barrel；`workflow.ts` 751→314 行门面（保留 validateWorkflowManifest/runWorkflow 本体 + 全部 re-export）。**消费方 import "./workflow.js" 零改动**（门面 re-export，未改 workflow-store/dag/adapter/flexible-plan 的 import 路径——最小 diff 优于方案原述的"改指 types.ts"，解耦收益由门面薄文件同样达成）。typecheck/lint（event-matrix fresh）/format/全量测试绿（唯一失败为本机环境性 PDF 用例）。剩余轮次（signal/runStageOnce 参数化）为 A7/A10。

---

### 5.3 `src/knowledge/shared/kg-store.ts`（406 行 → 门面 + kg/ 子模块）

**本质**：`KgStore` class 承担 DB 句柄管理 + 双 schema 探测 + FTS/LIKE 检索 + 图遍历四类职责；`nodeCache`（无上限 Map，performance-review B8 已点名）是唯一跨方法可变状态；全部 SQL 内联在构造器（L102-147）与 `likeSearchTerms`（L249 热路径动态 prepare，performance-review B7/L1 点名）。多域共用面实际收敛于 patent 域；ui/server 零深层 import。

**目标布局**（`src/knowledge/shared/kg/` 子目录）：

```
shared/
  kg-store.ts              # 门面：class KgStore 组合 3 个子模块 + 类型再导出（<80 行）
  kg/
    schema-introspector.ts # 表/列/FTS 探测 + prepared statements 组装（~120 行）
    row-mapper.ts          # toNode + parseLawRefsCount + NodeRow/FtsHit 类型（纯，~50 行）
    keyword-search.ts      # searchByKeyword/likeSearch/likeSearchTerms/likePattern/searchByKeywordOr（~150 行）
    graph-traversal.ts     # getNeighbors/bfsPath/listByType/expandNeighbors（~80 行）
```

**轮次**：

1. **纯函数**：`row-mapper.ts`（`toNode` + `parseLawRefsCount`，后者已是模块级纯函数）。
2. **探测层**：`schema-introspector.ts`（探测 + prepared 组装），构造器变薄；**保留"探测失败不崩"fail-closed 契约**（无 kg_nodes 抛错、FTS prepare 抛错降级）。
3. **图遍历**：`graph-traversal.ts`（bfsPath/expandNeighbors 图算法独立，易测）。
4. **检索核心**：`keyword-search.ts`（最大块，拆 `searchByKeywordOr` 内部 collect/窗口子词为具名纯函数）。
5. （顺带治理，独立小轮）`likeSearchTerms` 动态 prepare 缓存（performance-review L1）；`nodeCache` 加容量上限或 LRU（B8）——此轮涉及行为，单独 PR，不混入搬移轮。

**基线测试**：`kg-store.spec.ts` 11 例 + `kg-store-knowledge-db.spec.ts` 7 例 + `patent-kg-adapter.spec.ts`（间接）——**双线回归**：kg-store.spec（legacy `nodes_fts` unicode61）+ kg-store-knowledge-db.spec（unified）分别锁两套 schema 分支。
**建议新增盲区基线**：`bfsPath maxDepth 截断与环防护`、`ftsMode() unicode61 分支`、`likeSearchTerms 多词合并 + likePattern %/_ 转义`、`nodeCache 命中路径`。

**风险**：双 schema 分支散落构造器与 `likeSearchTerms` 多处，拆解易漏分支 → 双线 spec 是唯一护栏；`KgSearchOptions`/`KgSchema` 未从 barrel 导出（index.ts:20 仅导 3 个符号），若新消费方需要须同步补导出。

**DoD**：`kg-store.ts` ≤ 80 行（门面）；`searchByKeywordOr` ≤ 40 行（拆后）；knowledge 全量 spec 绿。

---

### 5.4 `src/knowledge/legal/legal-search.ts`（391 行 → 门面 + 4 个纯件）

**本质**：`LegalSearchEngine`（法规 laws-full.db 引擎，非判例）+ 跨域共享纯函数 `extractLawKeywords`（被 case-law-search / knowledge-law-search 两个 300+ 行引擎 import）。`searchFts`/`searchFtsKeywords` 的 SQL 完全相同（L116 注释明言共用语句）但 level/category 分支复制两遍；by-name 去重逻辑重复两遍（L287-295 与 L330-338）。

**目标布局**（`src/knowledge/legal/`）：

```
legal/
  legal-search.ts   # 门面：class LegalSearchEngine 组合子模块（<120 行）
  keywords.ts       # extractLawKeywords + SPLIT_WORDS（纯，~30 行）
  sql.ts            # 6 段 SELECT 常量 + level/category 动态 SQL 构建纯函数
  row-mapper.ts     # toRecord/toSearchResult（纯，~20 行）
  dedupe.ts         # dedupeByLawName（纯，~15 行，消除两处重复）
```

**轮次**：

1. **迁共享纯函数**：`extractLawKeywords`/`SPLIT_WORDS` → `keywords.ts`；**同步改 `case-law-search.ts:22` 与 `knowledge-law-search.ts:25` 两处 import**（关键：漏一处即编译失败；注意不引入 legal↔case-law 环——现有 case-law → legal 单向保持）。补 `extractLawKeywords` 直接单测（当前零直接测试）。
2. **纯件**：`row-mapper.ts` + `dedupe.ts`（消除两处 by-name 去重重复）。
3. **SQL 层**：`sql.ts`（6 段 SELECT + 3 段动态 SQL），确认 `stmtSearchFts` 仍被 searchFts/searchFtsKeywords 共用（仅参数不同），避免拆出两份 prepared。

**基线测试**：`legal-search-fts-degrade.spec.ts` 4 例（自包含，**无大库兜底的主力护栏**——`hasFts` 双条件探测、粘性降级 `ftsDegraded` 语义被 :75/:92 锁定）+ `legal-search.test.ts` 9 例（集成，缺本机大库整组 skip 属预期，不视为红）+ `memory-providers.test.ts` 法律段。
**建议新增**：`extractLawKeywords 切词/长度/上限`、`带 level+category 的 FTS 与 LIKE 动态 SQL`、`by-name 去重多版本保留最新`。

**风险**：`extractLawKeywords` 是跨域共享点（两处 import 必须同步改）；粘性降级 `ftsDegraded` 置位语义不可拆散；集成测试缺库假绿——重构期以自包含 spec 扩为行为基线。

**DoD**：`legal-search.ts` ≤ 120 行；`searchFts`/`searchFtsKeywords` 消除 SQL 复制（共用常量）；knowledge 全量 spec 绿。

---

### 5.5 `src/mcp/client/McpClient.ts`（425 行 → 薄门面 + 5 个单向依赖模块）

**本质**：`client/` 目录唯一文件，五类职责压进单一 class：传输工厂（stdio/streamable_http + fetch 超时/重试路由）、连接生命周期状态机、超时/重连策略（M5 会话过期重试、M5b 超时回收）、RPC 包装（listTools 缓存/callTool/listResources/readResource）、结果清洗（toToolSpec）。**连接单例的并发不变式是语义级风险**（reconnect/recycle 的"先同步置空引用、再 await close"防竞态）。SSE/JSON-RPC 帧解析完全委托 SDK，无事件/权限/telemetry 耦合，无 ui/server 深层 import——拆解不动任何契约。

**目标布局**（尊重 protocol/runtime/config 分层，新增到 `client/` 下）：

```
client/
  McpClient.ts    # 薄门面：组合 connection + operations，透传公开 API（~60 行）
  errors.ts       # McpClientError + isSessionExpired + withTimeout（~60 行）
  toolSpec.ts     # toToolSpec：清洗 + wireName + 描述截断（~30 行）
  transport.ts    # buildTransport → 返回 { transport, perSessionDir }（~70 行）
  connection.ts   # 连接状态机：8 个字段 + start/runConnect/requireClient/reconnect/recycle/close/cleanupSessionDir/peekInstructions（~180 行）
  operations.ts   # callWithReconnect + listTools/callTool/listResources/readResource（~130 行）
```

依赖方向单向：`errors ← toolSpec ← transport ← connection ← operations ← McpClient`（protocol/runtime 助手在最底层，无环）。`index.ts` 导出面（McpClient/McpClientError/McpClientOptions）逐字不变。

**轮次**：

1. **纯件**（零状态）：`errors.ts`、`toolSpec.ts`、`transport.ts`（`buildTransport` 改为返回 `{transport, perSessionDir}` 而非写 this）。配 5 个纯函数基线测试。
2. **连接状态机**：`connection.ts`（8 个字段整体搬入 ConnectionState 持有者，保留"同步置空引用再 await close"不变式）。
3. **RPC 包装**：`operations.ts`，依赖 connection 的 requireClient/reconnect/recycle。
4. **门面收口**：`McpClient` 瘦身组合；`PluginToToolBridge.ts:29` 的 type import 路径更新。

**每轮前先行补的基线测试**（关键盲区）：
- 第 1 轮前：`isSessionExpired treats statusCode 404 as expired`、`buildTransport returns stdio transport and allocates per-session dir`、`buildTransport rejects unknown transports with mcp_unsupported_transport`、`toToolSpec assigns wireName and truncates >2048 descriptions`
- 第 2 轮前：`close is idempotent and resets status`、`reconnect nulls client refs before awaiting old close`、`recycle drops refs synchronously then closes best-effort`、`start memoizes connect and resets connectPromise on failure`
- 第 3 轮前：`listTools caches within TTL / invalidates after reconnect`、`callTool maps -32001 to mcp_call_timeout and recycles`、`callTool maps generic errors to mcp_call_failed`、`callWithReconnect retries exactly once / single-flight guard`

**风险**：SDK `Transport` 接口与 `StreamableHTTPClientTransport._fetch` 私有字段的白盒断言（McpClient.spec:35）——transport.ts 不得改构造时序；`DEFAULT_CALL_TIMEOUT_MS` 模块加载期读 env 的求值顺序；`perSessionDir` 跨 3 方法生命周期（漏清即泄漏 `~/.tmp/sati-mcp-*`）；public API 面被 4 处上游消费（签名逐字一致）。

**DoD**：`McpClient.ts` ≤ 60 行（门面）；5 个新模块各 ≤ ~180 行、方法均 ≤ ~40 行；mcp 全量 spec 绿 + 新增盲区测试 ≥ 15 例。

---

### 5.6 `src/gateway/client/InProcessGateway.ts`（2344 行 → 类本体 + 6 个下沉模块）

**本质**：进程内网关实现（`Gateway` 接口的服务端形态，RemoteGateway 的镜像面）。实测 **62 个类成员 + 38 个模块级自由函数 ≈ 100 个函数**。类本体结构：8 个可变状态字段（`emitSinks`/`activeTurnReplays`/`turnCompletions`/`sessionPermissionGrants`/3 个 bus/`router`/`options`）+ `submitTurn` async-generator 核心（L319-617，~300 行）+ ~45 个 3-6 行薄委托方法 + 3 个 private 重放辅助。**38 个自由函数（L1063-2344，约 1280 行）全部不依赖类字段**（只依赖叶子类型/工具模块），是零循环依赖的天然提取面。事件矩阵中本文件是 5 类事件的生产者（`assistant_text_delta:322`/`agent_status:351`/`error:362`/`assistant_attachment:1693`/`structured_output:2048`）与 submitTurn 流消费点（`:490`）。**本文件不直接 import `protocol/version.ts`**（协议 1.3 耦合为间接——实现 1.1 discovery/1.2 approval/1.3 cron_update 方法即可，拆文件不触版本号）。

**模块级自由函数聚类**（行号已逐条核实）：

| 聚类 | 函数（行号） | 目标模块 | 预计行 |
|---|---|---|---|
| 工具结果清洗 | `limitGatewayToolResultPreview`(1898)/`sanitizeGatewayToolData`(1909)/`sanitizeGatewayToolDataValue`(1914)/`limitGatewayToolDataString`(1931)/`headTailString`(1945)/`isRecord`(1956)/`previewUnknown`(2054)/`safeGatewayPathPart`(2065)/`extensionForMime`(2331) + 2 常量(L110-111) | `toolResultSanitize.ts` | ~120 |
| provider 错误映射 | `providerErrorFromAgentError`(2278)/`providerErrorFromModelError`(2284)/`providerErrorFromRecord`(2297)/`stringifyProviderRaw`(2308)/`stringOrUndefined`(2315)/`numberOrUndefined`(2319)/`safeJsonStringify`(2323) + `GatewayEventProviderError` 类型(2295) | `providerError.ts` | ~60 |
| 输入归一化 | `normalizeGatewayModeForLegacyInput`(1124, export)/`normalizeGatewayRunMode`(1134, export)/`normalizePlanCommandInput`(2015)/`parsePlanCommand`(2033) + `PLAN_COMMAND_USAGE`(109) | `normalizers.ts` | ~70 |
| AgentEvent→GatewayEvent 映射 | `cloneGatewayEvent`(1063)/`getGatewayEventRunId`(1067)/`withGatewayRunId`(1071)/`mapAgentEvent`(1487, export)/`mapAgentEventForTurn`(1491, ~410 行最大单体)/`mapModelEvent`(1960)/`mapSubagentModelEvent`(1976)/`mapTurnCompleted`(2045) | `eventMapping.ts` | ~500 |
| 遥测 | `emitSessionTelemetry`(1144, ~330 行第二大单体，含拆分)/`inferToolErrorCategory`(1478)/`resolveSubmitTurnTelemetry`(1076)/`createGatewayFailureStatus`(1102) | `telemetry.ts` | ~180（拆分后） |
| 附件管线 | `buildAgentInputWithAttachments`(2095)/`buildAttachmentPathNote`(2124)/`attachmentDiagnosticsGuidance`(2159)/`isReadFileInspectableAttachment`(2171)/`safeAllowedAttachmentPath`(2185)/`collectRegisteredAttachmentReadFiles`(2191)/`attachmentsToContentBlocks`(2210) + 2 常量(L2074-2093) | `attachments.ts` | ~200 |

**目标布局**（`src/gateway/client/` 下平铺，类内 re-export 保持 3 个生产消费路径 + barrel 零改动）：

```
client/
  InProcessGateway.ts        # 类本体：字段 + submitTurn/abortTurn + ~45 薄委托 + 3 private（目标 ~900 行）
  toolResultSanitize.ts / providerError.ts / normalizers.ts / eventMapping.ts / telemetry.ts / attachments.ts
```

> 刻意**不拆** ~45 个薄委托方法（3-6 行 `this.router.x`/`this.options.x`）：性价比低、易引入 `this` 上下文错误；类本体压到 ~900 行即达标（backlog #7 的 DoD 是"拆出 ≥3 个职责模块"，6 个下沉模块已超额满足）。

**轮次**：

0. **前置轮（不拆，先治理）**：重写伪测试 `tests/gateway/weixin-settings-runtime-flow.spec.ts:64-77`——把读源码正则断言 `prepareWeixinLogin` 改为行为断言（实例化 InProcessGateway + 注入 `prepareWeixinLogin` 回调 + 断言透传），去掉对本文件源路径的扫描。全仓仅此 1 个伪测试涉及本文件（weixin-expiry-relogin 的 readFileSync 只读 fixture，已核实）。
1. **三个零依赖纯件**：`toolResultSanitize.ts` + `providerError.ts` + `normalizers.ts`（合计 ~250 行，纯函数；类内 re-export `normalizeGatewayModeForLegacyInput`/`normalizeGatewayRunMode` 两个 export 符号）。**本轮不触事件 emit 面，不触发事件矩阵门禁**。
2. **纯映射**：`eventMapping.ts`（含 `mapAgentEvent`——被 `src/gateway/index.ts:16` barrel 与 2 个测试直连 import，类内必须 `export { mapAgentEvent } from "./eventMapping.js"` 再导出）；同步补 `mapAgentEvent` 直接单测。**本轮起每轮 `pnpm gen:event-matrix`**（`assistant_attachment:1693`/`structured_output:2048` 归属变更）。
3. **IO 叶子**：`attachments.ts` + `telemetry.ts`（`mapAgentEventForTurn` 的 tool_result 落盘分支 L1515-1531 是映射函数中唯一 IO——迁移后 eventMapping 不再是纯函数文件，测试需 mock fs 或接受真实 tmp；`emitSessionTelemetry` 330 行单体内拆为具名 switch 分组）。
4. **类瘦身收尾**：删除已迁出函数、补齐 re-export，`pnpm gen:event-matrix` 最终再生成。

**每轮基线测试**（先行补齐，重点盲区）：
- 轮 1：`sanitizeGatewayToolData 递归截断超长字符串`、`headTailString 头尾对称保留`、`providerErrorFromRecord 全空返回 undefined`、`normalizeGatewayModeForLegacyInput 非法值回退 default`、`parsePlanCommand 空 /plan 与带参数`
- 轮 2：`mapAgentEvent turn_completed 顺序产出 structured_output 后 turn_completed`、`mapAgentEvent tool_result 大结果触发落盘 resultPath`、`mapAgentEvent 未映射事件返回空数组`
- 轮 3：`buildAttachmentPathNote 去重并注入 ATTACHMENT_PATH_NOTE_MARKER`、`collectRegisteredAttachmentReadFiles 非文件附件跳过`、`attachmentsToContentBlocks image/pdf/file 分派`、`emitSessionTelemetry model_event 触发 stage 打点`
- 轮 4：`submitTurn 重复提交返回 session_busy`、`submitTurn 超时合成 turn_timeout 并 close session`、`submitTurn 结束清理 emitSinks 并触发 afterTurnCompleted`、`abortTurn 等待 turnCompletions`、`recordActiveTurnEvent 超 500 条截断置 truncated`（ACTIVE_TURN_EVENT_LIMIT/BYTE_LIMIT L195-196）
- 全轮回归网：`tests/gateway/` 13 个文件中 9 个涉及本文件（new-session-key/knowledge-protocol/approval-protocol/discovery-protocol/attachment-guidance/map-agent-event-runid/tool-result-preview/weixin-settings-runtime-flow + background 侧）逐轮全绿

**风险**：
1. **伪测试拆即碎**（前置轮解决，全仓唯一）；
2. **事件矩阵门禁**：轮 2 起每轮 `pnpm gen:event-matrix` + diff 逐条核对（5 类生产者 + submitTurn 流 ×27 消费归属）；
3. **8 个可变状态字段必须留在类内**：`emitSinks`/`activeTurnReplays`/`turnCompletions` 强耦合于 submitTurn 生命周期，严禁下沉为模块级单例（否则跨实例串状态）；
4. **`sati.ts:211` 强转依赖**：`gateway as InProcessGateway` 调 `isSessionActive()`（不在 `Gateway` 接口）——该方法保留在类内，勿移走；
5. **协议方法名冻结**：1.1/1.2/1.3 方法与 RemoteGateway 一一对应，改名即破坏矩阵与协议面；
6. 已排除的伪风险：ui/server 无深层 import（仅注释提及；桥走 `createRemoteGateway`）；本文件不直接 import version.ts。

**DoD**：`InProcessGateway.ts` ≤ ~900 行（类本体）；6 个新模块各 ≤ ~500 行、单函数 ≤ ~100 行（`mapAgentEventForTurn`/`emitSessionTelemetry` 拆分后）；新增直接单测 ≥ 20 例（消除"零直接单测"标记）；事件矩阵再生成后 `--check` 绿。

---

### 5.7 `ui/server/index.js`（3845 行 → entry 组装骨架 + 12 个新模块）

**本质**：HTTP 服务器入口 + Express app 组装 + 浏览器侧 WS 服务器 + 静态服务 + 启动流程五合一。已实测**区段边界干净**：17 个路由已外置（L495-546 仅挂载）、内联部分按 files/preview/uploads/token-usage/websocket 自然聚类、无同名路由冲突（`routes/projects.js` 只注册 discovery-plans 等，与内联 `/api/projects/*` 靠 `next()` 回退共存）、全 ESM 单向依赖可避免循环。当前 19 个 `ui/server` 测试文件**没有一个 import index.js**（顶层立即执行 `startServer()` 使其不可导入——分片的直接收益是新模块可被 vitest 独立单测）。**内联路由目前零测试覆盖**。

**区段地图**（112 段全覆盖，行号证据见调研原始报告；关键聚类）：

| 聚类 | 区段 | 行数 |
|---|---|---|
| 共享状态中枢 | `connectedClients`(L166) + `sessionWatchRegistry`(L167) + 4 个 broadcast 函数 + `registerAlwaysOnNotificationForwarding`(L168) | ~90 |
| projects-watcher | `setupProjectsWatcher` + 常量（L154-356，chokidar 防抖） | ~130 |
| 聊天 WS | `wss` 创建 + verifyClient（L427-462）+ `WebSocketWriter` + `handleChatConnection`(L2481-2720) + `handlePluginWsProxy` | ~390 |
| 终端 PTY WS | `ptySessionsMap`(L361) + ANSI/URL 解析 4 函数 + `handleShellConnection`(L2722-3110) | ~455 |
| 文件系统服务 | `resolvePathInProject`/`streamFileWithRange`/`getFileTree`/`validatePathInProject`/`parseRangeHeader` 等 14 个纯函数 | ~390 |
| 上传服务 | `uploadFilesHandler`(L2199-2362) + `sanitizeAttachmentFilename`/`moveUploadedAttachment` 等 | ~215 |
| 限流器 | `createRouteRateLimiter` + 2 个实例（L1101-1127, L1255-1267） | ~40 |
| 系统路由 | `/health` + `/api/agents/runtime-config` + removed providers + ccr/* + always-on/* + /memory-dashboard（L483-844） | ~230 |
| 项目会话路由 | `/api/projects` 列表/会话/rename/delete/create + SSE 搜索（L867-1031） | ~160 |
| 项目文件路由 | browse/create-folder/read/content/save/list/create/rename/delete/download（L1302-2197） | ~500（可再拆二） |
| 项目预览路由 | office 预览/pdf/manifest/data/sheet/preview splat（L1533-1808） | ~300 |
| 上传路由 | files/upload + upload-attachments + upload-images（L2363, L3168-3348） | ~185 |
| token-usage 路由 | `GET .../token-usage`（L3350-3538） | ~190 |

**目标文件清单**（全部 ≤500 行；index.js 目标 ~250-320 行）：

```
ui/server/
  websocket/broadcast.js       # connectedClients/sessionWatchRegistry + 4 broadcast 函数（状态单一来源）
  websocket/chat.js            # wss 创建 + verifyClient + WebSocketWriter + handleChatConnection + handlePluginWsProxy
  websocket/shell.js           # ptySessionsMap + ANSI/URL 解析 + handleShellConnection
  services/filesystem.js       # 14 个文件系统纯函数 + 常量
  services/uploads.js          # uploadFilesHandler + 附件清洗/移动
  services/projects-watcher.js # setupProjectsWatcher + 常量（依赖 broadcast）
  services/rate-limit.js       # createRouteRateLimiter + 2 实例
  routes/system.js             # health/runtime-config/removed/ccr/always-on/memory-dashboard
  routes/project-sessions.js   # 项目/会话 CRUD + SSE 搜索
  routes/project-files.js      # 文件 CRUD/下载（超 500 再拆 project-tree + project-file-ops）
  routes/project-preview.js    # office/表格/预览
  routes/project-uploads.js    # 三处上传
  routes/token-usage.js        # token 用量
  index.js                     # entry：env/proxy 顶部副作用 + app/server 创建 + 中间件 + 17+6 路由挂载 + 静态 + SPA + startServer
```

**分批（每批一个 PR，独立可验证）**：

1. **纯函数服务层**（零状态零循环，风险最低）：`services/filesystem.js` + `services/uploads.js` + `services/rate-limit.js`。
2. **广播状态层**（后续所有批次的先决条件）：`websocket/broadcast.js`——`connectedClients`/`sessionWatchRegistry` 单一来源；严禁 broadcast 反向 import chat/watcher。
3. `services/projects-watcher.js`（依赖批 2 的 broadcast）。
4. **WS 连接层**：`websocket/chat.js` + `websocket/shell.js`，index 改为 `attachWebSocketServer(server)` 返回 wss。
5. **routes 层**（逐文件）：`system` → `project-sessions` → `project-files` → `project-preview` → `project-uploads` → `token-usage`。
6. **收尾**：index.js 瘦身到 entry 骨架，全量验证。

**每批验证**：`node --check <新文件>`（ESM 语法）→ `pnpm --filter sati-ui test`（vitest 收集 `ui/server/**/*.test.js`，19 个存量测试为回归网；新模块补纯函数单测）→ 手工冒烟点：`/health`、`/api/projects` 列表、文件读写/上传、`/api/projects/:p/preview/{*splat}`、`/api/ccr/dashboard`、`/api/always-on/events`、`/ws`（chat+shell）、SPA 回退、taskmaster 项目广播（依赖 `app.locals.wss`）。

**风险**：
1. **共享状态归属**：`connectedClients`/`sessionWatchRegistry` 是 chat 连接/广播/always-on 转发/watcher 四方中枢，必须先抽 broadcast 层，否则出现两份状态导致广播丢失/重复；`ptySessionsMap` 只属于 shell。
2. **import 顺序敏感**：顶层副作用 `installGlobalProxy()`(L6) 必须在任何网络 import 前、`assertRequiredSatiEnv()`(L38) 在路由 import 前——分片后 index.js 顶部 3 行顺序不变。
3. **`__dirname` 静态路径**：`../public`(L847)/`../dist`(L851/L3550) 必须留在 index.js（或显式传 `__dirname`），不随路由移目录。
4. **wss 挂接时序**：`wss = new WebSocketServer({server})` 先于 `server.listen`；`app.locals.wss = wss`(L465) 先于任何 taskmaster 请求处理（taskmaster.js 读 `req.app.locals.wss`）。
5. **env 读取时机**：`SERVER_PORT`/`HOST`/`VITE_PORT` 是 import 时快照；`process.env.SERVER_PORT` 回写(L3756) 留在 index listenFn——不能把 env 读取延迟到函数内。
6. **挂载顺序**：SPA wildcard `/{*splat}`(L3541) 是最终兜底；`/memory-dashboard` 硬 404(L842) 与 `express.static` 必须在 API 之后、wildcard 之前——顺序原样保留。
7. **函数 hoisting**：`getFileTree`(L3574)/`validatePathInProject`(L1945) 定义在文件后半被前半调用，拆出后显式 import，不能再依赖 hoisting。
8. **测试盲区**：内联路由零测试，纯机械搬运也可能因 import 缺失/顺序错位回归——靠 `node --check` + 冒烟补位，并鼓励新模块补单测。

**DoD**：index.js ≤ 400 行（entry 组装）；12 个新模块各 ≤ 500 行；`pnpm --filter sati-ui test` 全绿；冒烟点清单逐项通过。

---

## 6. 排期与批次

**轨道 A（后端 TS 拆解）** — 风险由低到高：

| 批次 | 内容 | 预估工作量 | 关键护栏 |
|---|---|---|---|
| A1 | reasoning-rules 按组拆 4 文件（§5.1） | 0.5 天 | 24/71 总数断言 |
| A2 | workflow.ts 类型 + manifest 纯搬移（§5.2 轮次 1） | 0.5 天 | graph 等价性 3 例 |
| A3 | kg-store row-mapper（§5.3 轮次 1）+ legal-search keywords（§5.4 轮次 1） | 0.5-1 天 | 双线 schema spec / 两处 import 同步改 |
| A4 | kg-store introspector + graph-traversal（§5.3 轮次 2-3） | 1 天 | fail-closed 契约 |
| A5 | legal-search row-mapper/dedupe/sql（§5.4 轮次 2-3） | 1 天 | 粘性降级语义 |
| A6 | McpClient 纯件 errors/toolSpec/transport（§5.5 轮次 1） | 1 天 | SDK Transport 白盒断言 |
| A7 | workflow.ts signal 抽取（§5.2 轮次 2） | 0.5 天 | g-flag 状态 |
| A8 | McpClient connection 状态机（§5.5 轮次 2） | 1-1.5 天 | 并发不变式 |
| A9 | McpClient operations + 门面收口（§5.5 轮次 3-4） | 1 天 | 缓存失效语义 |
| A10 | workflow.ts runStageOnce 参数化（§5.2 轮次 3） | 1-1.5 天 | 副作用时序 |
| A11 | InProcessGateway（§5.6：前置轮伪测试治理 + 轮 1-4 自由函数下沉；薄委托方法刻意保留在类内） | 2-3 天 | 事件矩阵再生成 + 协议 1.3 面冻结 |

**轨道 B（ui/server 机械分片）** — 与轨道 A 完全独立（JS 无 TS 耦合、独立测试套件），可并行：

| 批次 | 内容 | 预估工作量 | 关键护栏 |
|---|---|---|---|
| B1 | 纯函数服务层 filesystem/uploads/rate-limit（§5.7 批 1） | 0.5-1 天 | `node --check` + 存量 19 测试 |
| B2 | websocket/broadcast.js 状态中枢（§5.7 批 2，后续批次先决条件） | 0.5 天 | 单向依赖无环 |
| B3 | services/projects-watcher.js（§5.7 批 3） | 0.5 天 | 防抖语义 |
| B4 | websocket/chat.js + shell.js（§5.7 批 4） | 1 天 | wss 挂接时序 |
| B5 | routes 层逐文件 system→sessions→files→preview→uploads→token-usage（§5.7 批 5，6 个小 PR） | 2 天 | 挂载顺序 + 冒烟清单 |
| B6 | index.js 瘦身收尾（§5.7 批 6） | 0.5 天 | 全量冒烟 |

**依赖关系**：A1/A2 无前置；A3-A10 相互独立（不同模块，冲突面小）可按序或并行；A11 最后（最高风险，且轮 2 起触发事件矩阵再生成，宜在其余批次稳定后单独进行）。轨道 B 内部严格按批 1→6 顺序（broadcast 是 chat/watcher 的前置）。每批次独立 PR，绿一合一批。

---

## 7. 验收标准汇总（对照 backlog DoD）

- **#6 Top 5**：5 个文件拆后逻辑函数平均行数 ≤ 100（数据组按 §3 口径 ≤ ~110）；对应 spec 全绿。→ 由 A1/A2/A3/A4/A5/A6/A7/A8/A9/A10 覆盖。
- **#7 残留**：InProcessGateway 拆出 ≥ 3 个职责模块，补直接单测（消除"零直接单测"标记）。→ A11。
- **#12**：`ui/server/index.js` ≤ 400 行（entry 组装），拆出单文件 ≤ 500 行，`pnpm --filter sati-ui test` 全绿。→ 轨道 B。
- 全仓门禁：`pnpm typecheck` / `pnpm lint`（含 event-matrix --check）/ `pnpm format:check` / `pnpm test` 全绿。

---

## 8. 风险总表

| 风险 | 涉及文件 | 等级 | 缓解 |
|---|---|---|---|
| 图引擎 runWorkflow 行为等价性破坏 | workflow.ts | 高 | graph/adapter 3 个等价性测试为最高权重护栏；轮次 3 逐字搬迁副作用时序 |
| 连接并发不变式被当可重排代码 | McpClient.ts | 高 | 先补 4 个并发基线测试再动 connection；注释标注不变式 |
| 事件矩阵 file:line 硬编码 | InProcessGateway（及任何跨文件移动） | 高 | 每轮 `pnpm gen:event-matrix` + diff 复核 |
| 源码扫描伪测试碎裂 | InProcessGateway | 中 | 拆前把 weixin-settings-runtime-flow 的源码断言改为行为测试 |
| 双 schema 分支遗漏 | kg-store | 中 | legacy/unified 双线 spec 回归 |
| 跨域共享函数 import 漏改 | legal-search（extractLawKeywords） | 中 | 同步改 2 处 import，typecheck 兜底 |
| 集成测试缺本机大库假绿 | legal-search | 中 | 自包含 spec 扩为行为基线 |
| barrel 导出面漂移 | 全部 | 中 | 门面 re-export 逐字不变 + typecheck 全量兜底 |
| 热路径动态 prepare / nodeCache 无上限（既有性能债） | kg-store | 低（治理轮独立） | 单独 PR 治理，不混入搬移轮 |
| ui/server 无类型兜底 | index.js | 中 | 分批小步 + `node --check` + 冒烟；区段地图逐段核销 |

---

## 9. 待决事项

1. **edgeclaw-memory-core 子包 5 个 >1000 行文件**（llm-extraction 3737 / sqlite 2024 / file-memory 1632 / dream-review 1532 / heartbeat 1019）：root eslint ignore、独立 workspace，是否纳入本专项后续批次，需单独评估（涉及子包构建链与 `pnpm --filter` 测试门禁）。
2. **AgentLoop.ts 9 个阶段方法**（合计 ~2000 行）是否继续细分：run() 已骨架化，阶段方法可按"段内职责"再抽，但收益递减、风险上升，建议 0.1.x 观察期后再议。
3. **kg-store `KgSearchOptions`/`KgSchema` barrel 补导出**：拆解期若有新消费方需要则顺带补，无需求则保持现状（最小 diff）。
