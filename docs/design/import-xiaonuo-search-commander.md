# 引入 XiaoNuo Search Commander — 检索策略编排设计

- 状态：草案（待评审）
- 日期：2026-08-06
- 范围：检索策略多轮编排（Search Commander），作为 `search` 原子的动态执行器接入；不含检索质量评分体系重写
- 移植源：`/Users/xujian/projects/XiaoNuo Agent/packages/patent-domain/src/search-commander/`（9 模块，2061 行，仅移植编排内核，不移植 `@nuo/data`/`@nuo/logger` 依赖）

---

## 1. 背景与目标

Sati 当前检索能力分散在三处，互不驱动：

| 资产 | 现状 | 缺口 |
|------|------|------|
| `assets/workflows/patent/*.yaml`（search-plan→search-exec→search-qual） | 编排设计完整，但 `src/workflow/` DAG 引擎**已移植未接线**，YAML 无加载器 | 模板化检索无法运行 |
| `skills/patent-prior-art-search/SKILL.md`（三轮检索方法论） | **已接线生产**，但依赖 agent 自主执行，轮次/策略不可编程控制 | 无确定性停止判定、无反射反馈闭环 |
| `src/patent/data/nuo/searchProvider.ts`（nuo-patent 检索 provider） | 已接线为 workflow `search` 原子（`StageProvider.search`） | 单次检索，无多轮编排 |

XiaoNuo Search Commander 补的是"**动态多轮检索编排**"这一层：8 种策略元模型 + 场景模板 + 每轮反射 + 收益递减停止判定，且用**回调注入**（`planQueries/executeQuery/reflectOnRound`）与具体检索工具解耦。

**核心决策**：不引入为"第三套顶层检索编排"，而是作为 **`search` 原子的内部动态执行器**——模板化检索（workflow YAML）不够用时，由 Search Commander 接管多轮编排。职责分层：

```
workflow YAML（模板化，确定性）  →  search 原子入口
  └── 模板不足时 → Search Commander（动态多轮，LLM 生成查询 + 反射）
        └── executeQuery 回调 → nuo-patent searchProvider / 本地专利库 / 其他通道
```

---

## 2. 现状核对（代码级）

### 2.1 Sati 侧可复用资产（零成本）

- `src/patent/data/nuo/searchProvider.ts`：`createNuoSearchProvider(options)` 返回 `StageProvider`，`search` 函数可注入（测试用）——**直接作为 `executeQuery` 回调底座**。
- `src/patent/workflow.ts`：`WorkflowStage` 可声明 `atom: "search"`，阶段执行按 atom 分发到 `StageHandler`——**Search Commander 挂在 search handler 内，不改变 stage 语义**。
- `src/patent/atoms/handlers/builtin/`：内置原子 handler 注册表（`registerBuiltinAtoms` 幂等注册）——新增 handler 的注册位。
- `assets/patent-rules/orchestrations/{invalidation,infringement}.yaml`：`caseType` 与场景模板对齐的既有资产（search-commander 场景按 caseType 选模板）。
- 测试模板：`tests/patent/workflow.spec.ts`、`tests/patent/plantask.spec.ts`。

### 2.2 XiaoNuo 移植源关键接口（已读源码）

- `executeSearch({ goal, scenario, context, maxRounds, planQueries, executeQuery, reflectOnRound, onProgress })` → `SearchCommanderResult`（`api.ts:149`）。
- 类型：`SearchQuery`（query/fields/boost/operator）、`SearchStrategyType`（8 值）、`SearchRound`（strategy/queries/results）、`SearchResultItem`（source/relevanceScore/discoveredInRound/matchingQuery）、`SearchReflection`（whatWorked/whatDidntWork/newTermsFound/shouldStop）（`types.ts`）。
- 场景模板（`templates.ts`，5 个 `defaultRounds`）：OA 答复、无效、侵权、FTO、技术调查各配默认策略序列（如无效 = broad-semantic → citation-network → exhaustive → read-back）。
- 停止判定（`stop.ts`）：收益递减（连续 N 轮新增结果 < 阈值）→ 提前终止。
- 检索记忆（`memory.ts`）：每轮快照（策略/查询/结果数/反思）持久化，供跨会话复用——**依赖 `@nuo/data`，需适配 Sati 存储层**。

---

## 3. 设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 落点 | 新建 `src/patent/search-commander/` 独立目录，不塞进 `workflow.ts` | 编排器与执行器分离：workflow 管"阶段生命周期"，Search Commander 管"检索策略" |
| 接入姿势 | **search 原子 handler 内部**调用；模板检索（单次 `StageProvider.search`）为默认，Search Commander 为可选增强 | 避免第三套顶层编排（Mady "5 条执行路径"教训）；默认行为不变，灰度可回退 |
| 回调注入 | `planQueries`（LLM 生成查询）/ `executeQuery`（nuo-patent）/ `reflectOnRound`（LLM 反思）三个回调，编排器纯函数化 | 与现有 `StageProvider` 注入模式一致；测试注入 mock，生产注入真实实现 |
| 查询生成降级 | `planQueries` 失败 → 确定性 fallback：场景模板关键词 + IPC 注入 + 布尔语法校验 | 检索是"证据采集"，不允许 LLM 漂移导致漏检；fail-visible |
| 反射降级 | `reflectOnRound` 失败 → 返回"继续下一策略"中性反射，不阻断流程 | 反思是增强不是门禁 |
| 质量评分 | **不移植** XiaoNuo `quality.ts`；复用 Sati 既有 search-qual 门（对比文件≥3/相关度标注/全文≥2/布尔+IPC） | 评分标准只有一套（Sati 侧），避免双质量观 |
| 持久化 | `SearchMemoryStore` 接口 + Sati `DatabaseProvider`（better-sqlite3）实现；**不引入** `@nuo/data` | 遵守单仓边界：新依赖必须是 workspace 成员或锁 tag git 依赖，禁止内嵌子包 |
| 场景模板 | 5 场景 defaultRounds 按 Sati `caseType` 对齐（orchestrations id：invalidation/infringement/drafting/oa_response） | 与既有资产同构 |
| 开关 | env `SATI_SEARCH_COMMANDER=1` 灰度；默认关闭，search 原子行为不变 | 双轨演进原则（`VITE_GATEWAY_DIRECT_CHAT` 模式） |

---

## 4. 数据模型（新类型，`src/patent/search-commander/types.ts`）

```ts
export type SearchStrategyType =
  | "broad-semantic" | "ipc-funnel" | "citation-network"
  | "read-back" | "family-extension" | "international"
  | "exhaustive" | "verification";

export type SearchScenarioType =
  | "oa-response" | "invalidation" | "infringement"
  | "fto" | "technical-survey";

export interface SearchQuery {
  text: string;
  fields?: ("title" | "abstract" | "claims" | "fulltext")[];
  ipc?: string[];
  applicant?: string;
  dateRange?: { from?: string; to?: string };
  boost?: number;
  operator?: "AND" | "OR";
}

export interface SearchRound {
  round: number;
  strategy: SearchStrategyType;
  queries: SearchQuery[];
  results: SearchResultItem[];
}

export interface SearchResultItem {
  source: string;              // nuo-patent / local / web
  patentId: string;
  title?: string;
  relevanceScore: number;      // 0-1，由检索通道或本地评分给出
  discoveredInRound: number;
  matchingQuery?: string;
}

export interface SearchReflection {
  whatWorked: string[];
  whatDidntWork: string[];
  newTermsFound: string[];
  newIpcFound: string[];
  shouldStop: boolean;         // 反射认为证据已足够
}

export interface SearchCommanderResult {
  rounds: SearchRound[];
  merged: SearchResultItem[];          // 按相关度 + 轮次去重合并
  stoppedReason: "max_rounds" | "diminishing_returns" | "reflection" | "completed";
  provenance: SearchCommanderProvenance[];  // 审计附录（见 §6）
}
```

编排器签名（纯函数 + 回调注入，对齐 XiaoNuo `executeSearch`）：

```ts
export async function executeSearch(options: {
  goal: string;
  scenario: SearchScenarioType;
  context?: string;
  maxRounds?: number;              // 默认取模板轮数上限 + 1
  planQueries: (round: number, strategy: SearchStrategyType, label: string, context: string) => Promise<SearchQuery[]>;
  executeQuery: (query: SearchQuery, round: number) => Promise<SearchResultItem[]>;
  reflectOnRound: (round: number, queries: SearchQuery[], results: SearchResultItem[], merged: SearchResultItem[]) => Promise<SearchReflection>;
  onProgress?: (round: SearchRound) => void;
}): Promise<SearchCommanderResult>;
```

---

## 5. 文件级改动清单

> ⚠️ 本期仅记录方案，**未实施任何代码改动**。

### 5.1 新增

| 文件 | 内容 | 规模估算 |
|---|---|---|
| `src/patent/search-commander/types.ts` | §4 全部类型 | ~120 行 |
| `src/patent/search-commander/strategies.ts` | 8 策略元数据 + 5 场景模板（defaultRounds，对齐 orchestrations caseType） | ~180 行 |
| `src/patent/search-commander/engine.ts` | `executeSearch` 编排器：轮次循环 → 去重合并 → 停止判定（纯函数核心） | ~200 行 |
| `src/patent/search-commander/stop.ts` | 收益递减停止判定（连续 N 轮新增 < 阈值；阈值按场景配置） | ~80 行 |
| `src/patent/search-commander/query-fallback.ts` | `planQueries` 失败时的确定性查询生成（模板 + IPC 注入 + 布尔语法校验） | ~100 行 |
| `src/patent/search-commander/memory.ts` | `SearchMemoryStore` 接口 + better-sqlite3 实现（检索会话快照，库文件 `~/.sati/search-memory.db`） | ~120 行 |
| `src/patent/search-commander/index.ts` | barrel | ~15 行 |

### 5.2 修改

| 文件 | 改动 |
|---|---|
| `src/patent/atoms/handlers/builtin/search.ts`（或对应 search handler） | `SATI_SEARCH_COMMANDER=1` 时，单次 `StageProvider.search` 后接 Search Commander 多轮；默认行为不变 |
| `src/patent/data/nuo/searchProvider.ts` | 导出 `createExecuteQuery(provider)` 适配器：`StageProvider.search` → `executeQuery` 回调 |
| `src/patent/index.ts` | barrel 导出 search-commander 类型/引擎 |
| `src/tool/builtin/createBuiltinRegistry.ts` | 无改动（Search Commander 不新增工具，是原子内部能力）——如后续需 agent 直调，再注册 `patent_search_commander` 工具 |

### 5.3 不改动

- `src/patent/workflow.ts`（阶段生命周期不变，Search Commander 只是 search handler 内部实现）
- `src/patent/quality-gate.ts` / `slop-engine.ts`（质量评分留在 Sati 侧，不引入第二套）
- `assets/workflows/patent/*.yaml`（模板化检索资产保留，作为默认路径）
- `skills/patent-prior-art-search/SKILL.md`（agent 自主执行路径保留）

---

## 6. 审计附录（Search Commander 内置 provenance，与 #6 通用 DAG 的边界）

移植 XiaoNuo `search-commander/provenance.ts` 的**审计附录格式**（非通用 DAG）：

```ts
export interface SearchCommanderProvenance {
  database: string;                 // nuo-patent / local / web
  endpoint: string;
  parameters: Record<string, unknown>;
  identifierConversions: string[];  // 公开号→申请号、IPC 转换记录
  resultCount: number;
  totalAvailable: number;
  warnings: string[];
}
```

**边界**：检索 provenance 只作为报告末尾审计附录（fail-visible，计数对账），**不写入** #6 的证据关系 DAG（见 `import-xiaonuo-provenance.md` 交叉约束 C1）。

---

## 7. 测试计划（`tests/patent/` 镜像）

| 测试文件 | 覆盖 |
|---|---|
| `search-commander/engine.spec.ts` | 轮次循环；去重合并（同 patentId 多轮去重）；maxRounds 上限；回调注入（mock planQueries/executeQuery/reflectOnRound）；`planQueries` 失败 → fallback 查询生成 |
| `search-commander/stop.spec.ts` | 收益递减触发提前终止；连续新增 0 条 → `diminishing_returns`；反射 `shouldStop=true` → 终止 |
| `search-commander/strategies.spec.ts` | 5 场景模板默认轮次；caseType ↔ scenario 映射；未知 scenario fail-closed |
| `search-commander/query-fallback.spec.ts` | 模板关键词 + IPC 注入；布尔语法校验（非法布尔式拒绝）；空模板 fail-closed |
| `search-commander/memory.spec.ts` | 会话快照 save/load；最近一轮反射读取；库文件路径与清理 |
| `search-commander/nuo-integration.spec.ts` | mock nuo-patent 的 executeQuery；真实轮次执行；结果合并排序 |

验收命令：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`。

---

## 8. 分阶段实施计划

| Phase | 内容 | 交付 | 验证 |
|---|---|---|---|
| **P1** | `types.ts` + `strategies.ts` + `engine.ts`（纯函数内核，无 LLM 无存储） | 编排器核心 | engine/stop/strategies 三个 spec 全绿 |
| **P2** | `stop.ts` + `query-fallback.ts` | 停止判定 + 确定性降级 | 两个 spec 全绿 |
| **P3** | `memory.ts`（SearchMemoryStore + better-sqlite3） | 检索会话记忆 | memory spec 全绿 |
| **P4** | search handler 接线 + `createExecuteQuery` 适配器 + env 开关 | 原子内多轮检索（默认关闭） | nuo-integration spec + 既有 workflow 测试回归 |
| **P5** | 全量验证 + 文档收尾 | `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` 全绿 | 提交（conventional commits） |

依赖关系：P4 依赖 P1-P3；P1-P3 相互独立可并行。

---

## 9. 风险与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| **检索编排"第三套路径"冲突**（workflow YAML / skill 三轮方法论 / Search Commander 并存） | 高 | 职责分层：YAML=模板化默认、skill=agent 自主、Search Commander=search 原子内部动态增强；env 开关默认关闭，行为不变 |
| 持久化层不兼容（`@nuo/data` dbProvider） | 高 | 定义 `SearchMemoryStore` 接口，用 Sati `DatabaseProvider`（better-sqlite3）实现；禁止第三个 SQLite 抽象 |
| LLM 查询生成漂移（漏 IPC/错布尔逻辑） | 中 | `query-fallback` 确定性降级 + 查询式语法校验 + IPC 注入；fail-visible |
| 反射 LLM 不确定性 | 中 | 反射失败 → 中性反射继续流程；反射不阻断检索 |
| 质量门双套（XiaoNuo quality.ts vs Sati search-qual） | 中 | 不移植 XiaoNuo 质量评分；Sati 侧 search-qual 唯一 |
| 停止判定参数按场景校准 | 中 | 5 场景各配阈值；先在离线 eval 集校准 |
| 检索 provenance 与 #6 通用 DAG 语义重叠 | 中 | 边界切割：检索 provenance 是审计附录格式，不进证据关系图 |

---

## 10. 不做（本期明确排除）

- 不移植 `@nuo/data` / `@nuo/logger` 依赖（持久化用 Sati 既有层）
- 不移植 XiaoNuo `quality.ts` 检索质量评分（Sati search-qual 唯一）
- 不新增顶层检索编排工具（Search Commander 是 search 原子内部能力；agent 直调工具二期再议）
- 不替换 `assets/workflows/patent/*.yaml` 与 `patent-prior-art-search` skill（三路径并存，职责分层）
- 不接入 `src/workflow/` DAG 引擎的接线工作（那是独立议题，见 `docs/design/import-xiaonuo-flexible-plan.md` 相关段落）
