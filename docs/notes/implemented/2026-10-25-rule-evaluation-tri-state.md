# Agent Note: 规则评估三态（assessed / skipped / not_assessed）

Status: implemented

## Problem

`RuleEvaluation` 只有 `violations`。空数组同时表示「所有规则跑过且没有违规」和「一条规则都没跑」，两者在输出门禁、`rule_check` 报告与评测判级里无法区分。专利 checker 的 `aggregate` 也把空失败列表直接判为 `pass`，规则域配错或全部被域过滤时会静默产出「通过」。

## Decision

宪法规则引擎（`src/rule`）的 `RuleEvaluation` 增加必填 `assessed: string[]` 与 `skipped: RuleSkip[]`：

- `domain-filtered`：规则域与评估域不匹配。
- `empty-text`：空文本下无法给出有意义结论的**内容匹配类**检查（`keyword_blocklist` / `pattern_analysis` / `citation_analysis`）。`structural_analysis` / `synonym_match` 继续评估——空文本下「缺失要素」本身是有效结论。
- `no-rules`：规则集为空，`ruleId` 省略（不再用 `"*"` 哨兵）。

`RuleOutputGateResult` 透传两字段并增加 `notAssessed`；`needsApproval` 语义保持不变（空规则集仍在加载失败时放行），但调用方与报告必须展示「未评估」。

专利 checker（`src/patent/checker`）增加同形状的 `RuleEvaluationDetail` 与 `evaluateDetailed`；`Verdict` 增加 `not_assessed`，`aggregate(results, { assessed })` 在 `assessed === 0` 时返回 `not_assessed`（阻断级失败仍优先）。`ruleGateNode` 写入 `rule_gate_assessed` / `rule_gate_skipped`，`runRuleGate` 与 `rule_check` 报告输出「已评估 / 跳过」覆盖行。

兼容：`aggregate(results)` 不传 `assessed` 时保持旧行为；`RuleEngine.evaluate` 保留为 `evaluateDetailed(...).results` 的包装。

## Alternatives considered

- **空文本全部跳过** — 会改变 `structural_analysis` 在空文本上的违规语义（原本报缺失要素），进而改变输出门禁的 block/review 行为；只跳过内容匹配类检查可以保留既有判据。
- **`no-rules` 用 `ruleId: "*"` 哨兵** — 让 `skipped` 保持非可选字段，但消费者容易把 `*` 当真实规则 id；改为 `ruleId?: string` 更诚实。
- **`not_assessed` 只加在 checker、不改 `Verdict`** — 无法让 `aggregate` 与报告消费方在类型层暴露新判级；加值后 `tsc` 一次性找出全部 label/分支。
- **把「零评估」映射为 `pass` 并只在日志提示** — 违反铁律 11；报告与评测都会把未评估当通过。

## Consequences

- 规则域配错、规则集为空、空文本内容检查现在可被审计；`rule_check` 不再对「零评估」输出「无违规」。
- `not_assessed` 在 `compositeOverall` 中保守映射为 `needs_revision`；机械层零评估不会静默成为 `pass`。
- `evaluate/metrics.ts` 的 `ruleGatePass(verdict, assessedCount?)` 在评估数为 0 时返回 0；`EvalOutcome` 增加可选的 `ruleGateAssessed` / `ruleGateSkipped`，`BatchReport` 汇总两者（信息性计数，不参与综合分）。
- 既有 `aggregate([])` 直接调用仍返回 `pass`；只有提供了 `assessed` 的调用方获得新语义。这是有意的兼容边界，新增调用方应传评估数。
