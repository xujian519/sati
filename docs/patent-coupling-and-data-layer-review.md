# patent 域耦合度与数据映射层复核（#151 / #153）

- 复核日期：2026-09-11
- 关联 issue：[#151](https://github.com/xujian519/sati/issues/151)（patent 域变更蔓延的耦合度）、[#153](https://github.com/xujian519/sati/issues/153)（数据映射层领域逻辑位置）
- 方法：对 `src/patent/**`（163 个 TS 文件）做静态 import 图解析（区分 `import type`），Tarjan 求文件级 / 目录级 SCC；数据层逐文件逐个可疑点核对，并以 `vendor/nuo-patent/dist` 实际文案交叉验证
- 关联台账：`docs/technical-debt/backlog.md` 的 patent 段落、`docs/technical-debt/next-batches-schedule.md` §3 机会型

## 一、#151 结论：不存在需要拆分的结构性耦合（正常业务密度）

| 指标 | 实测 |
|---|---|
| 相对 import 边 | 438 原始 / **404** 去重（file→file） |
| 同子模块内 | 279 / 404 = **69%** |
| 跨子模块 | **125 = 31%**（值导入 107 / type-only 18） |
| 双向边（A↔B） | **0 对** |
| 文件级 SCC（循环） | **0** |
| 目录级 SCC（循环） | **0** |
| 跨边落点 | 根级共享叶子件 66、子目录 barrel 33、目录内文件 19、无 barrel 目录 7 |

**判断依据（反证式）**：

1. 70% 的耦合在模块内部闭合，跨模块仅 31%——依赖是"向上要契约/工具"，不是横向缠绕。
2. 52%（65/125）的跨边流入 6 个**零扇出**的叶子工具件（`prompt-hygiene.ts` 14、`atoms/index.ts` 13、`persist-utils.ts` 10、`paths.ts` 9、`llm-json.ts` 6、`worker-contract.ts` 5）——这正是一个健康模块应有的形状。
3. 单对耦合量极小（最大 8，中位数 1）；扇出 top 是 `src/patent/index.ts`（28，barrel 属正常）。

**⚠️ issue 前提需要修正**：issue 称 `src/patent`（147 文件）是"近 120 提交最高频变更面（88 次）"。以 180 天窗口实测：

| 口径 | patent | 排名 |
|---|---|---|
| 触及 patent 的 commit 数 | 118 | 第 6（tool 278 / agent 214 / cli 213 / model 174 / gateway 152 / context 152） |
| 去重 (commit, file) 触及数 | 467 | 第 6（tool 808 / agent 552 / context 519 / model 518 / adapters 514） |
| 归一化（触及数 ÷ 文件数） | 2.87 | **最低区间**（cli 18.1 / gateway 11.1 / agent 7.7 / model 7.5 / tool 7.0） |

即：patent 的**绝对**改动量靠前，但按文件数归一化后是**最低**的一档——它文件多，不是"每个文件都被频繁改"。因此"耦合导致回归风险"的前提不成立。

**该域确实存在的 4 处结构项（均非"拆子模块"，量级 S）**：

| 编号 | 症状 | 证据 | 处置建议 |
|---|---|---|---|
| S1 | 进程级**可变全局注册表**（`globalStageHandlerRegistry`）被 workflow / graph / evaluate 共享，隐式初始化顺序（未先 `registerBuiltinAtoms` 的图运行会静默降级） | 定义 `atoms/handler.ts:130`；注册 `atoms/index.ts:110-114`；消费 `graph/adapter.ts:16`、`graph/domains/{novelty:16,inventiveness:21,enablement:15}.ts`、`evaluate/runner.ts:13` | 由 graph/evaluate 显式接收 `StageHandlerRegistry`（`graph/adapter.ts:15-16` 参数面已可注入），把隐式顺序变成显式契约 |
| S2 | barrel 绕过 19 条（目标目录已有 barrel 且已 re-export 同一符号） | `atoms/…/mapper.ts:20-22` ← `claim-coverage/index.ts:14-15` 已导出；`provenance/collector.ts:13,14`；`graph/domains/shared.ts:15`；`guard/evidenceComplianceGuards.ts:18`；`atoms/…/draft.ts:14`；`evaluate/runner.ts:11`；`flexible-plan.ts:29` | 改为经 barrel 导入（机械、无行为变更）；并补 barrel 缺口（`claim-chart/index.ts` 增 `validatePinCiteFormat`、`workflow/index.ts` 增 `signalMatches`） |
| S3 | 适配层反向依赖上层类型：`data/nuo/searchProvider.ts:18` → `atoms/index.ts` 的 `StageProvider` | 同文件 `:19` → `literature/index.ts` | 契约类型下沉（见 #153 处置） |
| S4 | 跨顶层域深引 29 条 | `evidence/rule-loader.ts:13`→`rule/runtime`；`quality-gate.ts:20`；`output-gate.ts:1-3`；`provenance/provenance-store.ts:17,18`→`knowledge/shared`；`graph/domains/inventiveness.ts:23`→`knowledge/patent/ipc-classifier`；`guard/evidenceComplianceGuards.ts:12,17`→`permission`+`tool/builtin` | 中优先：`ipc-classifier` 与 `knowledge/shared` 属跨域直取内部实现，宜走契约 |

> 注：`graph/domains/index.ts:58-62` 有条注释声称"domains 各文件与 graph barrel 存在循环 import（既有结构 → getter 延迟求值）"，但静态图中 `graph/domains/*.ts` **无一处** import `../index.js`。该注释疑为历史残留（列「未闭合」项，删除前需一次模块加载实验确认）。

## 二、#153 结论：适配层不贫血，但替换为「3 项轻度失真 + 1 项已证伪的疑似缺陷」

`src/patent/data/nuo/` 四个文件的职责与判定：

| 文件 | 行数 | 职责 | 判定 |
|---|---|---|---|
| `mapper.ts` | 114 | `PatentData`（JSON 字符串字段）→ `StructuredPatentData` | 映射必需；但引证 family 维度被 flatten（见下） |
| `patentCache.ts` | 246 | LRU + TTL + in-flight 合并 + 成功态判定 | 有意的策略层（分层 TTL / 失败不缓存 / 并发合并），**不贫血**；但含领域词表（见下） |
| `searchProvider.ts` | 150 | `searchPatents` → `StageProvider.search`；多源并行 + 去重 | 映射必需；契约/装配位置偏上（S3） |
| `egoSession.ts` | 263 | ego-browser 进程封装（heredoc/PATH/截断/探针） | **位置错放**（不含任何 nuo 数据源逻辑） |

### 2.1 疑似缺陷（P0）已证伪——**这是本次复核最重要的一条更正**

调研初稿依据 `vendor/nuo-patent/dist/index.js:1056` 声称存在"请求已被取消"告警文案，并据此判定 `patentCache.ts:117-120` 的缓存判据**漏判取消路径**（被取消的检索会被当作"零命中"缓存 1 分钟）。

**逐项复核后该结论不成立**：

- `grep` vendor 产物**不存在** `请求已被取消` 这一文案；检索路径的告警只有两类（`vendor/nuo-patent/dist/index.js` 内）：

  ```
  const warning = err instanceof TimeoutError ? `检索超时 (${timeout}ms)` : `检索失败: ${err.message}`;
  ```

- 取消（`AbortError`）不属 `TimeoutError` → 落入 `检索失败: <message>` 分支 → 被 `isSearchResultCacheable` 的既有正则 `^(查询条件为空|检索超时|检索失败)` **命中** → 判为**不可缓存** ✅。

**结论**：`patentCache.ts:117-120` 的缓存判据对取消路径**已正确处理**，无需修补。本次复核未改动该文件。

> 教训（与本轮 #152/#149 的调研一致）：委派调研的"缺陷"结论必须回到源头产物逐条核实；本次若不核实，会以"修 bug"的名义引入一次无谓的行为变更。

### 2.2 三项轻度失真（登记，本轮不改）

| 编号 | 位置 | 内容 | 为什么登记而非当场改 |
|---|---|---|---|
| D1 | `mapper.ts:44-45, 83-90` | 前后向引证把 `*_no_family` 与 `*_yes_family` **合并为一个数组**，丢弃同族维度；类型面只剩 `backwardCites: Citation[]` | 属**跨模块契约变更**（`StructuredPatentData` 形状），且被 `tests/patent/data/nuo/mapper.spec.ts:150-160` 锁为契约；同族/非同族在 A22.2/A22.3 与 FTO 语境含义不同，形状怎么改需要产品侧决定 |
| D2 | `egoSession.ts:257-263` | 自建 `normalizePatentNumber`（剥 `-` `:` 后大写）与 vendor 同名导出**已发散**（vendor 不剥 `-`/`:`）：`US-11739244-B2` → Sati `US11739244B2` / vendor `US-11739244-B2`；且 `patentPdfDownload.ts:653`（去重键）与 `patentCache.ts:133`（缓存键用原始串）**口径不同** | 两条修法各有行为影响：(a) 改用 vendor 实现会改变 PDF 下载/去重行为；(b) 保留严格版但改名并让缓存键也归一化会改变缓存命中率。须先确认线上是否已发生重复打源（需日志），不宜凭静态推断改 |
| D3 | `patentCache.ts:137-138` | 缓存 TTL 分层内嵌**专利法律状态词表**（`LEGAL_STATUS_QUERY_RE` 含 `无效`），而 `无效` 同时命中"无效宣告"（程序，非状态）→ 语义过宽，检索期被无谓缩短 | 词表意图（是否刻意覆盖"无效宣告"检索）只有业务方可定 |

### 2.3 位置收敛建议（登记，P2）

- `egoSession.ts` 移出 `data/nuo/`（它是通用浏览器执行封装，消费方是 `src/tool/*` 与 `src/browser/backend/egoBackend.ts:1`）→ 建议落 `src/browser/` 或 `src/tool/builtin/ego/`；注意 7 个深引调用点需同步改路径（机械改动；无事件面变更，不需重跑事件矩阵）。
- `searchProvider.ts:18-19` 的契约类型与多源装配上移（契约归 `workflow/` 或独立 protocol；装配归 `src/tool/registry/createBuiltinRegistry.ts`，该处已是装配点）。

## 三、未闭合项（需人工/后续确认）

1. `graph/domains/index.ts:58-62` 的循环注释是否为历史残留（静态图无环，但 `export *` 求值顺序的运行时现象静态不可见）。
2. D1（引证同族维度）的下游影响面：静态可达消费方只有 `patentTool/builtin/patentMetadata.ts:52`，但上层 prompt 文本与角色 SKILL 是否隐含依赖"单数组"形状无法从代码确定。
3. D2 是否已在生产中造成重复打源（需日志验证）。
4. D3 的 `无效` 词表意图（需业务确认）。

## 四、复现方式

```bash
# 耦合度量（file→file，含 type-only 区分；脚本产物仅落 /tmp）
node -e '/* 见 docs/notes/implemented/2026-09-11-adapters-skill-split.md 记录的口径 */'
# 数据层可疑点抽查
grep -n "LEGAL_STATUS_QUERY_RE\|isSearchResultCacheable" src/patent/data/nuo/patentCache.ts
grep -n "normalizePatentNumber" src/patent/data/nuo/egoSession.ts src/tool/builtin/patentPdfDownload.ts vendor/nuo-patent/dist/index.d.ts
grep -n "检索失败\|检索超时" vendor/nuo-patent/dist/index.js
```
