# Agent Note: claim-chart 缺口四档（unevaluated）与 pin-cite 降级登记

Status: implemented

## Problem

`claim-chart` 的 gap list 只有 `not-found` / `needs-evidence` / `partial` 三档，且 `detectGaps(rows)` 只遍历**已有行**。「要素 × 目标」中从未评估的组合不会产生缺口，读者无法区分「没跑过」与「跑过但未找到」；S-04 的结构化回退因此不知道该重跑哪一块。

同时 `target.sourcePath` 缺失时 pin-cite 只做格式校验（跳过段号与 quote 的源文核验），这一降级没有登记到 `assets/degradation/registry.yaml`，属于铁律 11 的台账盲区。

## Decision

- `Mapping` 增加 `unevaluated`（九值 → 十值），`RowState` 同步。模型可在「确无结论」时显式填写；该取值不绑定目标类型或场景，空 `quote` / `pinCite` 继续放行。
- `detectGaps(rows, elements, targets)`：先枚举「要素 × 目标」，没有映射行或显式 `unevaluated` 的组合产出 `unevaluated`；再处理已有行的三档缺口。同一对只计一次。优先级 `not-found < needs-evidence < partial < unevaluated`，未评估排在最后，避免淹没已知缺口。
- `GAP_MAPPINGS` / `PRIORITY` / `SUGGESTIONS` / `GAP_REASON_LABELS` 的键集合由 `GapMapping` 联合类型在编译期强制同步，漏扩任一表即 `tsc` 报错（替代原先的注释提醒）。
- `deriveNoveltyCoverage` 返回 `{ covered, missing, unevaluated }`：未评估要素单列，不计入 `missing`；`covered` 仅在两者都为空时为真。`deriveDistinguishingFeatures` 返回 `{ features, unevaluatedElements }`，区别特征仍只来自 `not-found` / `needs-evidence`。
- chart 原子：`MAPPINGS`、`CHART_SCHEMA` 与 prompt 同步 `unevaluated`；缺少 `sourcePath` 的目标行写 `note: "未做原文核验"`，`claim-chart.md` 顶部列出未核验目标，表格增加 Note 列。
- 降级 registry 新增 `claim-chart-pin-cite-source-missing`（`failDirection: open`），observability 指向行 note 与报告标注，negativeDrill 指向 `tests/patent/claim-chart/pin-cite-degradation.spec.ts`。

## Alternatives considered

- **只加 `unevaluated` 枚举、不枚举缺失组合** — 模型不主动填时仍然看不到「没跑过」，问题原样保留。
- **把缺失组合归入 `not-found`** — 会把「未评估」折叠成「查过没有」，回退与规划无法定位未覆盖的要素。
- **在行上加 `assessed: boolean`** — 与 `mapping` 形成两个事实源，既有状态机与 Report 消费者要同时判断两个字段；扩枚举只改一处判据。
- **要求 `sourcePath` 必填** — 破坏元素拆分与低摩擦场景；改为显式降级并让核验面在行与报告上可见。
- **用空字符串表示未评估** — 无类型约束且报告会出现空标签。

## Consequences

- gap list 会比以前长：每个未覆盖的「要素 × 目标」都成为一条 `unevaluated`，这是有意的可复现性收益。
- `GapEntry.mapping` 枚举扩容属于契约变化；`claim_chart_build` 的 `outputSchema` 中 `chart` 是开放对象，无需同步收紧。
- `claim-chart.md` 表格新增 Note 列，表头与分隔行由 6 列变 7 列。
- 缺源文的目标仍能产出 chart，但每行与报告顶部都会标注「未做原文核验」；有源文但不可读仍走打回重做/降级，不静默通过。
