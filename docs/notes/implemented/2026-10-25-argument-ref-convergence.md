# Agent Note: 论证结构收敛为三向指针（ArgumentRef）

Status: implemented

## Problem

Sati 有三套并存的「结论必须可追溯」结构：

- `claim-chart`：要素网格（`ClaimElement` / `Mapping` / `GapEntry`），引用对象是**要素编号**；
- `reasoning/syllogism`：大前提 + 小前提 → 结论，引用对象是**黑板事实 ID**与**法条 ID**；
- `evidence/claimBinding`：结论 ↔ 证据切片，标记**无证据结论**。

三者各自演化，缺口表无法合并，对抗审查（S-08）也没有统一的「脆弱点」指针。分析报告建议「升格 claim-chart 为平台 schema」——照做会造出第四套：claim-chart 的要素网格表达不了法条引用与证据切片，强行承载只会让另外两套变成它的特例适配器。

## Decision

**一套指针，三种映射，各自保留存储格式**

- `ArgumentRef = { elementId?, factRef?, articleRef? }`，不变量「至少一个字段非空」由 `assertArgumentRef` 校验（`src/patent/argument/refs.ts`）。类型保留三个可选项以兼容既有结构，空引用在构造/映射处 fail-loud。
- 三套结构各出映射，不做格式迁移：
  - claim-chart：`GapEntry.ref`（`detectGaps` 写入 `{ elementId }`；旧数据由 `claimChartGapRef` 回退）。
  - syllogism：`syllogismRef(s)` → `{ factRef, articleRef }`；`SyllogismError.ref` 在失败点带上可追溯指针。
  - claim-binding：`UnbackedClaim = { claimId, ref? }` + `unbackedClaimRefs()`；结论 id 在三向指针里映射为 `factRef`（三向中没有独立 claim 字段）。
- `ArgumentGap = { ref, kind, detail, source, sources? }`：`sources` 是去重后合并的来源列表，`source` 保留首条以兼容单值读取。
- `dedupeArgumentGaps(gaps)`：键 = 规范化 ref（字段固定顺序 `elementId/factRef/articleRef`）+ `kind`；同一缺口即使由两套结构报出也只计一次，保留首条 `detail` 并合并来源。
- 适配层 `src/patent/argument/adapters.ts` 把三套来源转成统一缺口；三套结构本身不新增 schema。

**消费方先接 ref，不改既有字段**

- `claim_chart_build` 的 gap list 随 `GapEntry.ref` 自动带上指针（JSON 落盘与工具 data 同步）。
- `syllogism` 校验失败的错误对象带 `ref`；既有 message 与抛出时机不变。
- `evaluate_evidence` 输出新增可选 `claimRefs: [{ claimId, ref }]`；输入 schema 未改，既有输出字段不变。
- `Syllogism` 增可选 `vulnerableAt` / `rebuttalHook`，供 S-08 对抗审查复用，不新造结构。

## Alternatives considered

- **升格 claim-chart 为平台 schema**（分析报告建议）— claim-chart 的引用对象只有要素编号；法条与证据切片要么塞进 `elementId`（语义错位），要么新增字段让 claim-chart 变成「什么都装」的第四套。三套结构的问题不是缺一个主 schema，而是缺一个共同的**指针**。
- **一次性迁移三套存储格式** — `claim-chart-*.json`、推理黑板、证据账本都有落盘/续跑依赖；迁移不可逆且与 S-08 的时间窗冲突。先加可选字段、各自映射，消费方可逐步切换。
- **把 `ArgumentRef` 做成 union（`{kind:"element", id}` / …）** — union 让「同时引用要素 + 法条」无法表达，也迫使所有既有构造点改写。三可选字段 + 不变量校验更贴合真实论证（一条结论常同时引用事实与法条）。
- **给 claim-binding 增加 `claimId` 到 `ArgumentRef`** — 计划锁定三字段；结论 id 在推理黑板上本就是事实引用，映射为 `factRef` 即可，不扩字段。
- **用 `JSON.stringify` 直接做去重键** — 对象键顺序不稳定，同一引用会算出不同键；改为固定字段顺序的规范化序列化。
- **去重时保留多条只做计数** — 缺口表是给人处理的清单；保留首条并合并 `sources` 既避免重复条目，又不丢「哪些结构同时报了它」。

## Consequences

- 任一缺口现在可追到「要素 / 事实 / 法条」之一；`dedupeArgumentGaps` 让三套来源的同一缺口只出现一次。
- 新增第四套论证结构的评审可以引用本 note 的判据书面否决：新结构必须能映射到 `ArgumentRef`，否则就是重复造轮子。
- 存储格式未变，迁移可逆；旧 claim-chart JSON 无 `ref` 时由 `claimChartGapRef` 回退。
- `evaluate_evidence` 输出多一个可选字段（向后兼容），输入 schema 未变，无需重录 llm-replay。
- `syllogism` 模块仍标注为「预留 API（尚无生产执行链）」；本次只补映射与错误指针，未改变其接线状态。
