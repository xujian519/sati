# Agent Note: 知识库遗留项 A3/A6/A7/A8 —— 把「能力可用性」判据钉到施效侧事实上报

Status: implemented

## Problem

`docs/knowledge-system-report.md` §2.5 的 A1–A8 清单经 #366 复核后剩余的 A3/A6/A7/A8（issue #376）。
四项表面各异，共病相同：**诊断与文档给出的结论，代码并不担保**。

逐条核码后的真相（其中 A8 与 issue 的机制判断相反，A6 比 issue 描述多一层）：

- **A3（文档承诺未实现）**：`design/import-xiaonuo-knowledge.md` §4.4 声称自检失败时「语义召回自动降级
  跳过（复用熔断路径）」，而代码只有 `warn` + 写 `embeddingConsistency`，全仓无消费者据此门控。
- **A6（有索引无消费者仍报 ready）**：`semantic-vectors` 在 `paths.vectorsDb` 存在即 `ready`。但
  `VectorDbSearch` 的唯一消费者是 `LegalMemoryProvider`，且只取 `corpus="law"`——只含 `"kg"` 语料的库
  （KG 语义召回早已迁 knowledge.db embeddings）无人读，诊断却报就绪。
- **A7（同一场景两种口径，无统一文档）**：自动注入只接主库 `knowledge.db`，工具侧走 `SATI_CASE_DB`，
  `personal_note` 语义路在两者分离时被工具侧关闭并告警——三处口径不同，没有任何一处文档并列写出。
- **A8（机制判断与代码相反）**：issue 称「`unicode61` 时提示执行 migrate 脚本，会对 unified 用户产生
  误导」。核码后 **`ftsMode()` 对 unified 分支硬编码返回 `"trigram"`**，从不校验表实际 tokenizer，
  因此该提示在 unified 下根本不会出现——issue 的机制不成立。真实缺陷在**反方向**：
  unified 库里 `kg_nodes_fts` 若非 trigram（旧导入器产物、`--no-fts` 裁剪后重建、外来库），会被报成
  `trigram`（**假 ready**，与母议题 `#366` 同型）；此外 `ftsMode()==="none"` 的两种成因
  （库中无 FTS 表 / 运行时无 FTS5）共用一句「如桌面端捆绑 Node 未编译 FTS5」，会把「该重建索引」
  误诊成「该换 Node 版本」。

## Decision

**运行期事实一律由施效侧上报，诊断只做判定**（第二生产点，不得从入参/路径旁推——#360 的教训）：

- `KgFtsProbe{schema, tablePresent}`：由 kg-store 的表结构探测结果上报（与 `kgFtsMode` 同一探测点）。
- `VectorDbProbe{opened:true, corpora} | {opened:false, reason}`：`assemble` 打开 `vectors.db` 成功后
  上报 `vector_meta` 的**实际语料**；打开/版本检查失败时上报原因。
- 两者随既有 `KnowledgeRuntimeStats.snapshot()` 出口（gateway `knowledge.capabilities` / 启动日志），
  字段可选、纯 additive。

具体判定：

- `KgStore.ftsMode()` 的 tokenizer 改由**建表 SQL** 判定（`sqlite_master.sql` 含 `tokenize='trigram'`；
  未写 tokenize 即 FTS5 默认 unicode61），不再按 schema 推断；`ftsProbe()` 同时给出 schema 与表存在性。
- 诊断 `kg-fts-tokenizer` 的提示按 schema 与表存在性分流：unified 非 trigram → 重建入口
  （`trim-knowledge-db.ts --rebuild-kg-fts`）；legacy → `migrate-kg-fts-trigram.mjs`；表缺失 → 归因表
  缺失（unified 的表由导入管道生成，Sati 无建表脚本）；表在但 prepare 失败 → 保留「运行时无 FTS5」口径。
  未上报探测明细（旧的快照构造点）时退回改造前的 legacy 文案。
- 诊断 `semantic-vectors` 的 vectors.db 分支判据 = 「实际语料 ∩ 被消费语料 ≠ ∅」**且**「法规消费者在位」
  （判据与 `legal-fts` 行同源，抽成同一常量）。被消费语料由消费者自己声明：`LEGAL_VECTOR_CORPUS`
  从 `legal-memory-provider.ts` 导出，诊断引用同一常量。无运行时快照时退回路径型粗粒度判定，
  `detail` 如实标注「本次未探测语料」。
- A3：改文档——如实写「仅 `warn` + 写 stats」，并注明门控为已知缺口及其前置条件。
- A7：新增 `docs/knowledge-system-report.md` §2.7「分离配置下的能力矩阵」，设计文档交叉链接。

## Alternatives considered

- **A8 按 issue 口径只加 `kgSchemaKind`、把 migrate 提示限定为 legacy** — 落选：核码后该提示本就只在
  legacy 出现（unified 恒返回 trigram），改完是**零行为变化**，等于新增一个没有生产者的字段，正是本次
  在修的病灶。要让判据有牙齿，必须先让 `ftsMode()` 说真话（本决定采用的路径）。
- **A6 在 `assemble` 侧按「有无被消费语料」决定是否构造 `VectorDbSearch`** — 落选：判据会在写侧
  （决定构造）与读侧（诊断判定）各写一遍，两处漂移即失据；而 `VectorDbSearch` 的语料是惰性加载
  （打开只读 `vector_meta`），不构造省下的只是一个只读句柄。本 issue 的病灶面是可观测性，故在诊断侧收口。
- **A6 由诊断自己探测 `vectors.db` 的 `vector_meta`** — 落选：违反「判据不得旁路反推实际施效结果」
  （#360）。诊断重开一次库既可能与真实句柄不同代（文件被替换/版本检查语义要重写），还要自建缓存；
  改由打开它的那一侧上报，事实与消费者天然同源。
- **A6 连带按 corpus 判定 knowledge.db embeddings 分支** — 落选：该分支有三条消费者（法条语义、判例语义、
  项目笔记），与「法规消费者是否在位」无关，套同一规则会误报。本 issue 只针对 legacy `vectors.db`。
- **A3 补上门控（消费自检结果关闭语义路）** — 落选：门控需检索构造器接受 quality/阈值参数
  （`createKnowledgeEmbeddingSearch` 与 `VectorDbSearch` 均无），改动面与风险超出「低优先级遗留项」；
  且「模型不匹配但可调用」返回结果本身不是故障，现有两条降级路径（未配置 / 连败熔断）已覆盖「不可用」。
  如实记录缺口比塞一个绕过构造函数签名的开关更稳。
- **A6 让「只有 kg 语料」报 `disabled` 而非 `missing`** — 落选：`disabled` 在本模块的既有语义是
  「未启用/未配置」，而此处是「已配置、也有数据，但缺消费者所需的那部分语料」；`missing` 同时会触发
  启动期 warn（非全 ready 即 warn），与「把静默降级暴露出来」的诉求一致。

## Consequences

- 关闭三条会说谎的诊断路径：unified 非 trigram 表被报成 trigram（假 ready）、`vectors.db` 无被消费语料
  或打不开仍报 ready、`none` 归因于 Node 构建而实际是表缺失。A3 的文档承诺与代码对齐，A7 有了事实源。
- **行为变化（刻意）**：`semantic-vectors` 在「路径存在但无被消费语料 / 打开失败 / 无法规消费者」时由
  `ready` 变 `missing`；`kg-fts-tokenizer` 在 unified 非 trigram 场景由 `ready(trigram)` 变
  `ready(unicode61)` 并给出重建提示。二者都在 `KnowledgeCapability` 既有字段内，不新增契约面；
  `KnowledgeRuntimeStatsSnapshot` 的两个新字段为可选，gateway 消费方向后兼容。
- 判据全部经**负控制**证伪后复绿：删掉任一条判据，对应用例即转红（A6 三条：语料交集 / 打开失败 /
  消费者在位；A8 三条：schema 分流 / 表存在性分流 / tokenizer 探测），其余用例保持绿。
- 未做（留在 §2.6 表内）：A3 的门控、A6 的句柄回收（无人消费时仍保留只读句柄）、A5 的独立库行数探测。

## 交叉引用

- issue [#376](https://github.com/xujian519/Sati/issues/376)（本变更）、[#366](https://github.com/xujian519/Sati/issues/366)（母议题）
- `docs/knowledge-system-report.md` §2.5 / §2.6 / §2.7（A1–A8 事实源）
- `docs/design/import-xiaonuo-knowledge.md` §4.4 / §4.5
- `src/knowledge/diagnostics.ts`、`src/knowledge/shared/knowledge-stats.ts`、
  `src/knowledge/shared/kg/schema-introspector.ts`、`src/knowledge/shared/kg-store.ts`、
  `src/knowledge/assemble.ts`、`src/knowledge/legal/legal-memory-provider.ts`
