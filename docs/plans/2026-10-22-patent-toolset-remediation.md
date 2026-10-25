# 专利工具集审计整改方案（2026-10-22）

> 日期：2026-10-22
> 状态：已完成（2026-10-25；决策记录见 `docs/notes/implemented/2026-10-25-*`）
> 来源：专利工具集深度审计（30 个 patent 域工具 / nuo-patent v2.3.1 / 真实环境探针）
> 跟踪：母议题 #707；每个工作流一个子议题（见 §9）
> 范围：`src/tool/builtin/*`（patent 面）、`src/patent/data/nuo/*`、`src/knowledge/patent/*`、`assets/degradation/registry.yaml`、`scripts/check-patent-sop-references.mjs`
> 非目标：UI 改动、gateway 协议改动、新数据源接入（见 §8）

## 1. 整改目标与验收口径

### 1.1 三个必须达成的结果

| 编号 | 结果 | 判定方式 |
|---|---|---|
| R1 | 检索主链路恢复：真实环境对固定查询集能返回命中 | 5 条固定查询（3 关键词 + 2 公开号）各 ≥1 命中，且与 fixture 对拍一致 |
| R2 | 降级可见：任何字段缺失都带结构化信号，且登记降级 registry | 不存在 `success:true` + 必需字段全空的返回；`pnpm check:degradation` 绿 |
| R3 | 契约收紧：空 `outputSchema` 归零，`isReadOnly` 与副作用一致 | 运行时断言 0 个空 properties；`patent_workflow` 传 `caseId` 时不再被自动放行 |

### 1.2 量化指标

| 指标 | 现状（2026-10-22 实测） | 目标 | 测量方式 |
|---|---|---|---|
| 真实检索命中 | 0（任意查询） | ≥1 / 每查询 | 探针脚本 + fixture |
| 静默部分降级 | 2 类（metadata / legal_status） | 0 | 代码审查 + 负向演练 |
| 空 `outputSchema` | 10 / 30 | 0 | 注册表运行时扫描 |
| 幽灵工具引用 | 5 处（cap09 ×4 + skill ×1） | 0 | 扩展后的 `check:patent-sop` |
| 契约字符数 | 56,005（schema 40,369 + desc 15,636） | ≤ 40,000 | 注册表统计脚本 |
| 真实结构 fixture 测试 | 0 | ≥ 8 条 | 测试清单 |

## 2. 约束与原则

1. **vendor 不可手改**：`vendor/nuo-patent/dist/**` 是 checksum 审计的预构建产物（`docs/notes/implemented/2026-09-20-vendor-nuopatent-checksum-windows.md`：*"该目录本就是不可手改、checksum 审计的预构建产物"*）。任何修复先落 Sati 适配层，结构性修复推上游后重新 vendor。
2. **降级不静默**（AGENTS.md 铁律 11）：跳过 / 降级 / 未量测必须回答"谁因此漏了什么"。
3. **一个 PR 一个工作流**：独立可回滚，不夹带重构。
4. **契约变更同步成本**：改 `inputSchema`（含描述）→ 重录 llm-replay；改 `AgentEvent` → `pnpm gen:event-matrix`；本方案不触碰后两者。
5. **新增 `*.test.ts` 必须 `git add -f`**（`.gitignore` 忽略该后缀）。
6. **非平凡变更同 PR 带 `docs/notes/` 决策记录**（含 `## Alternatives considered`）。

## 3. 工作分解总表

| ID | 工作流 | 优先级 | 依赖 | 主要落点 | 预计 |
|---|---|---|---|---|---|
| R-01 | Google Patents 检索链路恢复（含缓存副作用） | P0 | — | `src/patent/data/nuo/searchProvider.ts`、`patentCache.ts` | 1.5d |
| R-02 | 著录项/法律状态静默降级治理（含 registry 登记） | P0 | — | `patentMetadata.ts`、`patentLegalStatus.ts`、`mapper.ts`、`assets/degradation/registry.yaml` | 1.5d |
| R-03 | 说明书章节识别容错 | P1 | — | `validateSpecification.ts` + 测试 | 0.5d |
| R-04 | 权利要求/说明书名称与前序归一化 | P1 | — | `draftClaims.ts`、`draftSpecification.ts` + 测试 | 1d |
| R-05 | 工具输出契约与只读声明收紧 | P1 | — | `ToolRegistry.ts`、10 个 patent 工具、`patentWorkflowTool.ts` | 1.5d |
| R-06 | 编排工具面收敛 + manifest 描述动态生成 | P2 | R-05 | 5 个编排工具、`manifests.ts`、`gen-patent-workflow-docs.ts` | 2d |
| R-07 | 工具引用一致性门禁 | P2 | — | `scripts/check-patent-sop-references.mjs`、cap09、skill | 0.5d |
| R-08 | 知识检索质量（类型/分数/精排/去重） | P2 | — | `src/knowledge/patent/*`、`patentKgQuery`、`patentWikiSearch` | 2d |

**实施波次**：

```
Wave 1（恢复可信度）  R-01 ──→ R-02
Wave 2（修正确性）    R-03   R-04   R-05
Wave 3（降成本/提质量）R-06（依赖 R-05）  R-07   R-08
```

> R-01 与 R-02 都涉及 nuo 适配层，但一个是检索、一个是详情解析，文件不重叠；仍建议分两个 PR，便于单独回滚。

---

## 4. 逐项方案

### R-01｜Google Patents 检索链路恢复

**根因链**（已实证）：

1. `searchPatents` 首选 XHR：`https://patents.google.com/xhr/query?...`。
2. `fetchHtml` 在 `isEgoBrowserAvailable()` 为真时**无条件走 ego**，并忽略 `fetchImpl`；`fetchHtmlWithEgoBrowser` 取的是 `document.documentElement.outerHTML`。
3. Chrome 把 JSON 包成 `<html><body><pre>{...}</pre></body></html>` → `fetchJson` 的 `JSON.parse` 必然失败。
4. 回退 HTML 解析依赖旧版 `<search-result>` 结果卡片；当前页面只有 1 个根节点 → 0 命中。
5. `patentSearch.ts:191` 只把 `查询条件为空|检索超时|检索失败` 判为失败，`搜索结果页未解析到任何结果（页面结构可能变化）` 被当作正常空结果返回。
6. `patentCache.ts:117` 用同一正则判定可缓存 → **坏掉的空结果被缓存**。

**决策**：

- **阶段 1（本 PR，P0）**：在 `src/patent/data/nuo/searchProvider.ts` 增加 `searchViaEgoJson()` 桥接：
  1. 复用 XHR URL 构造；
  2. 调 vendor 导出的 `fetchHtmlWithEgoBrowser()`；
  3. 用 cheerio 取 `<pre>` 文本（或 `body` 文本）→ `JSON.parse`；
  4. 调 vendor 导出的 `parseSearchResultsJson()`；
  5. 失败则回退现有 `searchPatents()`；
  6. 结果带 `dataSource: "ego-json" | "html" | "native"` 与结构化 warning。
- **阶段 2（推上游，P1）**：nuo-patent 增加 `fetchTextWithEgoBrowser()`（返回 `document.body.innerText`，或在检测到 JSON 时解包 `<pre>`），`fetchJson` 改走它；升版后重新 vendor + 更新 `checksums.sha256` / `SOURCE_COMMIT`。
- **缓存**：结构异常型 0 命中一律不缓存；`metadata` 透出 `cacheHit` / `cacheAge`。

**改动点**：

- `src/patent/data/nuo/searchProvider.ts`（新增桥接与 `dataSource`）
- `src/patent/data/nuo/patentCache.ts`（可缓存性判定）
- `src/tool/builtin/patentSearch.ts`（warning 分类：新增 `PARSE_ERROR` 前缀）
- `src/patent/data/nuo/searchProvider.spec.ts` / `patentCache.spec.ts`
- `assets/degradation/registry.yaml`（新增 ego-json 解析失败条目）

**任务清单**：

- [x] T1.1 新增 `searchViaEgoJson(query, opts)`：XHR URL + `fetchHtmlWithEgoBrowser` + `<pre>` 解包 + `parseSearchResultsJson`
- [x] T1.2 `searchProvider` 编排：ego-json → vendor `searchPatents` → 结果归一化，暴露 `dataSource`
- [x] T1.3 `patentSearch.execute`：把 `PARSE_ERROR` 与"真 0 命中"分开；空结果且 body 非空 → 抛 `tool_execution_failed`
- [x] T1.4 `patentCache`：`PARSE_ERROR` / `页面结构` 类结果不缓存；命中信息透出 `cacheHit`/`cacheAge`
- [x] T1.5 录制 5 条 fixture（3 关键词 + 2 公开号）并加契约测试（JSON 正常、JSON 空、HTML 兜底三路）
- [x] T1.6 新增降级条目 `patent-search-parse-error`（failDirection / degradedImpact / observability / negativeDrill）
- [x] T1.7 上游 issue：nuo-patent 增加 JSON 感知抓取（附本仓证据与复现）

**验收清单**：

- [x] 真实环境 5 条固定查询各 ≥1 命中
- [x] `git diff --stat vendor/` 为空（未手改 vendor）
- [x] 用"人工破坏的 JSON 页面"fixture 触发 `PARSE_ERROR`，且**不**返回 `0 result(s)` 的 success
- [x] `pnpm check:degradation` 绿
- [x] `pnpm check` 绿

**风险**：XHR URL 结构由 Google 控制；桥接层复制了 URL 构造逻辑，需在 fixture 里锁住。缓解：URL 构造集中在单一函数并加注释"与 vendor 同步"。

---

### R-02｜著录项 / 法律状态静默降级治理

**根因**（已实证）：

- vendor `parsePatentHtml` 只在 `catch` 里 push warning；选择器命中 0 个元素不抛异常 → 字段写成 `"[]"` / `""`，`parseWarnings` 为空。
- Google 详情页已移除 `dd[itemprop="inventor"]`、`dd[itemprop="legalStatusIfi"]`、`itemprop="events"`、`itemprop="abstract"`，仅 `meta[name="DC.title"]` 存活。
- `patent_metadata` 渲染 `N/A` 但 `success:true`；`patent_legal_status` 仅 title，其余全空。

**决策**：

- **阶段 1（本 PR，P0）**：让缺失可见：
  - `mapper.ts` 输出 `missingFields: string[]`；
  - 必需字段（title + inventors + assignees + filingDate）全空 → `NOT_FOUND` / `PARSE_ERROR`，不返回 `success:true`；
  - `patent_metadata` / `patent_legal_status` 的 `data` 增加 `degraded: boolean`、`degradedReason`、`dataSource: "html-microdata"`；
  - `patentLegalStatus` 对空字段输出 `status: "UNKNOWN"` + `degradedReason`。
- **阶段 2（推上游，P1）**：vendor 解析器升级到当前页面结构（JSON-LD / 内嵌数据），升版后 re-vendor。
- **降级登记**：新增 `patent-metadata-page-structure`、`patent-legal-status-page-structure`，`degradedImpact` 必须写明"用户会看到 N/A，可能误判为无发明人/无法律状态"。

**改动点**：

- `src/patent/data/nuo/mapper.ts`
- `src/tool/builtin/patentMetadata.ts`（outputSchema 必填字段 + 渲染）
- `src/tool/builtin/patentLegalStatus.ts`
- `assets/degradation/registry.yaml`
- 新增 `tests/patent/data/nuo/mapper-degradation.spec.ts`
- `tests/patent/fixtures/patent-page-modern.html`（当前页面结构快照）

**任务清单**：

- [x] T2.1 `mapper.ts` 计算 `missingFields`（title/inventors/assignees/filingDate/grantDate/legalStatus）
- [x] T2.2 `patentMetadata`：必需字段全空 → 结构化错误；部分缺失 → `degraded + missingFields`
- [x] T2.3 `patentLegalStatus`：逐条结果带 `degraded`/`missingFields`，不再静默空串
- [x] T2.4 两条降级 registry 条目 + 负向演练（modern-page fixture）
- [x] T2.5 上游 issue：microdata → 现行页面结构解析升级

**验收清单**：

- [x] 对 `US11452699B2` 不再出现"`success:true` + 发明人/受让人/日期全空"
- [x] 缺字段时 `missingFields` 非空且渲染层显式提示"页面结构变化，字段不可用"
- [x] `pnpm check:degradation` 绿
- [x] 负向演练在人为移除 `DC.title` 时也失败（不能只修一半）

---

### R-03｜`validate_specification` 章节识别容错

**根因**：`REQUIRED_SECTIONS` 只认 `^#{1,3}\s*技术领域`（`validateSpecification.ts:71-76`）；`DRAWING_SECTION_RE` 同样只认 Markdown。标准提交格式的纯文本标题被判"5 个章节全缺"（实测 `passed:false, score:0.4`）。

**决策**：标题识别抽成 `matchSectionHeading()`，支持：

- Markdown `#`–`######`
- 纯文本行：`技术领域`
- 编号：`一、技术领域` / `1. 技术领域` / `（一）技术领域`
- 方括号：`【技术领域】`
- 前后全角/半角空格、行尾冒号

同时保留"只匹配行首、不匹配正文中出现的词"这一原约束。

**任务清单**：

- [x] T3.1 抽 `SECTION_HEADING_RE` 与 `matchSectionHeading()`
- [x] T3.2 `REQUIRED_SECTIONS` / `DRAWING_SECTION_RE` 改用统一识别
- [x] T3.3 测试矩阵：Markdown / 纯文本 / 编号 / 方括号 / 缺 1 节 / 正文误命中
- [x] T3.4 更新工具描述中的输入格式说明

**验收清单**：

- [x] 纯文本标准说明书 → `passed:true`
- [x] 只缺"附图说明" → 仅报 1 节缺失
- [x] 正文出现"技术领域"字样但无标题 → 不误判为存在

---

### R-04｜权利要求 / 说明书名称与前序归一化

**根因**：

- `draftClaims.ts:67` 无条件 `一种${name}` → `一种一种相变储热装置`；
- 从属权利要求 `根据权利要求1所述的${name}` 带上"一种"；
- `prior_art` 自由文本被塞进"包括："当特征；
- software 域 `一种${name}的实现方法` → `一种数据处理方法的实现方法`。

**决策**：

- 新增 `normalizeInventionName(raw)`：剥离前置 `一种/一件/一款/一项`，折叠重复前缀，保留原名其余部分。
- 从属权利要求使用 `bareName`（去掉"一种"）。
- `prior_art` 保持字符串兼容，但新增 `shared_features?: string[]`；两者都给时优先结构化。`prior_art` 字符串**不再**直接作为前序特征，而是转成"根据权利要求/现有技术，……"的引导句或拒绝并给出 warning（二选一，PR 内定）。
- software 域名已以"方法"结尾时不追加"的实现方法"。

**契约影响**：新增可选 `shared_features` → `inputSchema` 变更 → 需重录 llm-replay fixture。

**任务清单**：

- [x] T4.1 `normalizeInventionName()` + 单测（一种/一件/一款/重复前缀/空串）
- [x] T4.2 独立/从属权利要求统一使用 `bareName`
- [x] T4.3 `shared_features` 入参与前序构造；`prior_art` 降级为引导语
- [x] T4.4 software 域名后缀去重
- [x] T4.5 `draft_specification` 同步名称归一化与 `tech_domain` 识别修正
- [x] T4.6 测试改精确串断言，新增 4 条反例
- [x] T4.7 重录 llm-replay fixture

**验收清单**：

- [x] `一种一种…` / `…的实现方法` / `根据权利要求1所述的一种…` 三类病句全部消失
- [x] 同一输入二次运行输出稳定（无随机）
- [x] `pnpm check` 绿（含 replay）

---

### R-05｜工具输出契约与只读声明收紧

**根因**：

- `ToolRegistry.ts:41` 只拦 `outputSchema === undefined`，空 `{type:"object", properties:{}}` 可注册；
- `ToolRuntime.ts:433` 仅在 `data !== undefined` 时校验 → 空 schema 等于免检；
- 10/30 个 patent 工具是空 schema；
- `patentWorkflowTool.ts:249` 声明 `isReadOnly: () => true`，但传 `caseId` 会写 `<caseDir>/workflow-runs/*.json|.mmd`；`PermissionRuntime` 对只读工具在**所有模式**直接 allow。

**决策**：

- 注册期：非 MCP 工具且 `properties` 为空 → 抛错；确需豁免的必须带 `outputSchemaExemptReason: string`，并在 `docs/technical-debt/` 记账。
- 为 10 个工具补 schema（按现有 TS 返回类型生成），优先 `patent_workflow_run`、`render_patent_document`、`patent_docket`、`patent_metadata`。
- `patent_workflow` 改 `isReadOnly: input => !input?.caseId`。

**任务清单**：

- [x] T5.1 `ToolRegistry` 拒绝空 properties + `outputSchemaExemptReason` 通道
- [x] T5.2 补 `render_patent_document` / `patent_docket` / `patent_plan_task` schema
- [x] T5.3 补 `patent_workflow` / `patent_workflow_run` / `flexible_plan` schema
- [x] T5.4 补 `patent_metadata` / `patent_worker_validate` / `evaluate_evidence` / `recognize_chemical_structure` schema
- [x] T5.5 注册表负向测试：空 schema 必须拒绝、带 reason 的豁免必须登记
- [x] T5.6 `patent_workflow.isReadOnly` 按输入判定 + 权限测试（plan 模式传 `caseId` 必须 ask/deny）

**验收清单**：

- [x] 运行时扫描 `EMPTY_OUTPUT_SCHEMA = 0`
- [x] `pnpm check` 绿（schema 不影响 inputSchema，replay 不失效）
- [x] 权限用例：`{caseId}` → 不放行；无 `caseId` → 放行

---

### R-06｜编排工具面收敛 + manifest 描述动态生成

**根因**：5 个编排工具职责重叠；`patent_workflow` 描述首句是 "Run…" 但不执行；8 个 manifest 只在描述里列 3 个 / 2 个；`manifests.ts` 头注释仍写"7 个"。

**决策**：

- 保留三个入口：`patent_workflow_assemble`（装配+规则门）、`patent_workflow_run`（执行）、`patent_docket`（案卷生命周期）。
- `patent_workflow` 作为 alias 保留一个版本；`patent_plan_task` 合并进 `flexible_plan`（保留 alias）。
- manifest 列表**由代码生成**：在 `manifests.ts` 导出 `formatManifestCatalog()`，工具描述拼接该函数结果；`gen-patent-workflow-docs` 增加"每个 manifest 至少出现在一个工具描述"的检查。
- 描述瘦身：单工具 ≤ 1,200 字符；属性 description ≤ 200 字符；总契约 ≤ 40k 字符。

**契约影响**：工具名/描述变更 → replay fixture 需重录；alias 保证旧名可调用。

**任务清单**：

- [x] T6.1 设计三入口职责表（装配 / 执行 / 案卷）并写入工具描述
- [x] T6.2 `formatManifestCatalog()` + 描述动态拼接
- [x] T6.3 `patent_plan_task` 能力并入 `flexible_plan`，旧名设 alias + 弃用说明
- [x] T6.4 `patent_workflow` 更名 + alias；描述首句改为 "Assemble…"
- [x] T6.5 描述瘦身到预算内（脚本测量）
- [x] T6.6 一致性测试：8 个 manifest 全部可发现；alias 可调用
- [x] T6.7 重录 replay fixture

**验收清单**：

- [x] 8/8 manifest 在至少一个工具描述中出现
- [x] 旧工具名仍可调用（alias 测试）
- [x] 契约字符 ≤ 40,000
- [x] 智能体路由测试：给定"装配已有阶段输出"不选 `patent_workflow_run`

---

### R-07｜工具引用一致性门禁

**根因**：`cap09-search-commander.md` 引用 `patent_kg_search` / `patent_kg_path` / `patent_rag` / `patent_law`（均不存在）；`skills/patent-prior-art-search/SKILL.md:11` 引用 `patent_kg_search`；`check-patent-sop-references.mjs` 只扫 `cap01-orchestrator.md` + `assets/workflows/patent/*.yaml`。

**决策**：

- 扫描范围扩到 `assets/prompts/patent/**/*.md`、`skills/**/SKILL.md`、`rules/**/*.md`。
- 识别规则：反引号内、匹配 `^[a-z][a-z0-9]*(_[a-z0-9]+)+$` 的 token，对注册表做存在性校验；非工具 token 走 allowlist（`personal_note`、`knowledge.db` 等）。
- 负向测试：故意引用不存在的 `patent_foo` 必须失败。

**任务清单**：

- [x] T7.1 抽取 `collectToolIdentifiers(markdown)` + allowlist
- [x] T7.2 扩扫描范围与错误输出（文件:行 + 疑似替代项）
- [x] T7.3 修 cap09 4 处、skill 1 处
- [x] T7.4 负向测试（幽灵工具名 / allowlist / 非工具 token）
- [x] T7.5 把 `check:patent-sop` 的覆盖范围写进脚本头注释

**验收清单**：

- [x] 修复前脚本对 5 处报红；修复后绿
- [x] 新增一个幽灵引用能被立刻拦下
- [x] `pnpm check` 绿

---

### R-08｜知识检索质量

**根因**：`PatentKgAdapter.searchRelevant` 只做 `searchByKeyword` + SIMILAR/CITE 扩展，无类型过滤、无分数阈值；中文 FTS 对三字词召回噪声大；wiki 结果同标题重复。

**决策**：

- `patent_kg_query` 入参新增 `nodeTypes?: string[]`、`minScore?: number`；输出每条带 `score` 与 `nodeType`。
- 复用已有 `patent_candidate_rerank` 做二阶段精排（可选开关 `rerank: boolean`）。
- `patent_wiki_search` 按 title 去重，保留最高分。
- 建 5 条 golden query（"创造性" / "新颖性" / "侵权" / "权利要求清楚性" / "无效证据"），断言 top-3 的 `nodeType` 在期望集合内。

**契约影响**：`inputSchema` 新增字段 → 重录 replay fixture。

**任务清单**：

- [x] T8.1 `PatentKgAdapter.searchRelevant` 支持 `nodeTypes` / `minScore`，返回 `score`
- [x] T8.2 `patent_kg_query` 透传参数 + 输出排序
- [x] T8.3 `patent_wiki_search` 标题去重
- [x] T8.4 可选 rerank 接线（缺模型 → 原序 + `degraded`）
- [x] T8.5 golden query 测试（5 条）
- [x] T8.6 重录 replay fixture

**验收清单**：

- [x] "创造性" top-3 不再出现"侵权-原理"类节点
- [x] 每条结果有 `score` 与 `nodeType`
- [x] wiki 无重复标题
- [x] 缺模型时 rerank 降级有 `degraded` 标记

---

## 5. PR 切分

| PR | 内容 | 依赖 | 回滚方式 |
|---|---|---|---|
| PR-1 | R-01 检索桥接 + 缓存 | — | revert 单 PR，恢复旧行为（仍 0 命中但不再缓存坏结果） |
| PR-2 | R-02 降级可见 + registry | — | revert 单 PR |
| PR-3 | R-03 章节识别 | — | revert 单 PR |
| PR-4 | R-04 撰写归一化 + fixture | — | revert 单 PR |
| PR-5 | R-05 契约/只读 | — | revert 单 PR |
| PR-6 | R-06 编排收敛 + fixture | PR-5 | revert + alias 兜底 |
| PR-7 | R-07 门禁扩面 | — | revert 单 PR |
| PR-8 | R-08 检索质量 + fixture | — | revert 单 PR |

每个 PR 必须：分支 + PR、Conventional Commits、`Closes #<子议题>`、`docs/notes/` 决策记录、`pnpm check` 绿。

## 6. 全局检查清单

**代码与测试**

- [x] `pnpm check` 全绿（biome → eslint → typecheck → test → 各门禁）
- [ ] 新增 `*.test.ts` 已 `git add -f`
- [ ] 真实结构 fixture 入库（JSON / HTML / modern page）
- [x] 无 `any` / `@ts-ignore` 新增
- [x] 单测不触网（外部依赖 mock 或 fixture）

**契约**

- [x] 改 `inputSchema` 的 PR 已 `pnpm record:replay`
- [x] 未改 `AgentEvent` / gateway frames（本方案不涉及）
- [x] 工具 `outputSchema` 运行时扫描 0 空壳

**降级**

- [x] 每条新降级路径都有 `degraded` / `missingFields` / `dataSource`
- [x] `assets/degradation/registry.yaml` 已登记，`negativeDrill` 可执行
- [x] `pnpm check:degradation` 绿

**文档**

- [x] `docs/notes/` 决策记录（含 `## Alternatives considered`）
- [x] 计划文档勾选回填（本文件）
- [x] 工具描述与实际能力一致
- [x] `docs/code-facts.md` 若工具数变化 → `pnpm gen:doc-claims`

**Git / 交付**

- [ ] 分支 + PR，标题符合 Conventional Commits
- [ ] PR 正文 `Closes #<issue>`
- [ ] CI `pr-traceability` 绿
- [x] 若行数变化影响基线 → `pnpm measure:update` 并同 PR 提交

## 7. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Google 再次改页面结构 | 高 | 检索/详情再次失效 | fixture + `PARSE_ERROR` 显式化；把"结构变化"变成可见错误而非 0 结果 |
| 上游 nuo-patent 不接收修复 | 中 | 阶段 2 无法落地 | 阶段 1 桥接可长期独立运行；桥接层加"与 vendor 同步"注释 |
| alias 迁移导致提示词/技能失效 | 中 | 旧引用调不通 | R-07 门禁 + alias 保留一个版本 + 弃用 warning |
| schema 补齐引入输出校验误杀 | 中 | 工具报 `OUTPUT_SCHEMA_MISMATCH` | 先按真实返回样本录 fixture，再开校验；灰度一个 PR |
| 契约瘦身删掉必要说明 | 中 | 模型选错工具 | 路由测试 + 保留"何时用/何时不用"两句 |

## 8. 非目标与后续立项

**本次不做**：

- **中国官方数据源接入**：vendor 已导出 `CNIPAClient`，但未在 `src/` 接线，且依赖外部 `cnipa_epub_client.py`（YunXi）与登录态。建议单独立项做 spike，先确认脚本可获得性与合规边界。
- **OA 通知书 / 对比文件 PDF 解析**：`patent_oa_response_v1` 目前依赖手工输入，需新增文档解析工具，属能力扩展而非整改。
- **UI 改动**：降级信号先落工具输出；UI 呈现另立项。
- **检索质量评测集扩容**：R-08 只建 5 条 golden query，系统评测归 `benchmarks/patent-agent/`。

## 9. 议题索引

> 母议题与子议题在创建后回填本节。子议题标题前缀、标签、依赖见 §3。

| ID | Issue | 状态 |
|---|---|---|
| EPIC | #707 | 已完成 |
| R-01 | #710 | 已完成 |
| R-02 | #709 | 已完成 |
| R-03 | #711 | 已完成 |
| R-04 | #708 | 已完成 |
| R-05 | #713 | 已完成 |
| R-06 | #715（依赖 #713） | 已完成 |
| R-07 | #714 | 已完成 |
| R-08 | #712 | 已完成 |
