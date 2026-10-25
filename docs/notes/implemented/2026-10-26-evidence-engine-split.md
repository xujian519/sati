# evidence/engine.ts 按职责拆分（#722）

## Problem

`src/patent/evidence/engine.ts` 有 841 行，同时承载三性评分、类型特定判定、使用公开四要件、YAML 规则表解析与 `EvidenceEngine` 编排。`credibility.ts` / `date.ts` 已在早前拆出，剩余职责混在一个文件里，改动任一层都要在长文件里定位。

## Decision

- 按职责拆为四个模块，`engine.ts` 只保留 `EvidenceEngine` 类：
  - `judgment.ts`：三性单维评分、等级换算、默认权重、综合评分与判定叙述；
  - `type-inference.ts`：`inferEvidenceType`、类型特定判定、使用公开/互联网公开日期推定；
  - `four-elements.ts`：使用公开四要件与举证难度/证据链评估；
  - `rule-evaluation.ts`：YAML 规则表解析与条件求值。
- 与原计划的偏差（以职责归属与验收线为准）：
  - `containsAny` 落在 `four-elements.ts`：它只被四要件判定使用，放进 `type-inference.ts` 反而制造跨模块私有依赖；
  - `computeOverallScore` / `buildReasoning` 从 `engine.ts` 移入 `judgment.ts`（计划只列了单维评分）：否则 `engine.ts` 仍有 333 行，达不到「< 300 行」的验收线，且这两个函数同属「判定如何合成与表述」。
- `evidence/index.ts` 公开导出符号与语义不变，仅 `inferEvidenceType` / `evaluateFourElements` 的 re-export 来源改为新模块；`EvidenceEngine` 与两个证明标准常量仍从 `engine.ts` 导出。
- 新增 `tests/patent/evidence/module-split.spec.ts` 守住验收线：`engine.ts` < 300 行、不重复定义已迁出函数、四个子模块存在职责入口。

## Alternatives considered

1. **保持单文件，仅加分区注释**：行数不降，导航问题（本议题的动因）不解决。
2. **只拆 `rule-evaluation.ts`**：规则表解析约 170 行，engine 仍 ~670 行，达不到验收线。
3. **在 `evidence/` 下再建子目录**：当前只有 10 个文件，子目录会让 barrel 路径与既有 import 面同时变动，收益不足。
4. **让 `engine.ts` re-export 已迁出的函数以保留旧内部导入路径**：会制造第二导出源，读者无法判断权威定义；仓库内只有 barrel 消费这些符号，直接改 barrel 即可。
5. **把 `EvidenceEngine` 也拆成「规则装载器 + 判定器」两个类**：超出 #722 的纯重构范围，且会改动公开构造/方法面。

## Consequences

- 公开 API 零变更：`src/patent/index.ts`、`src/patent/evidence/index.ts` 的导出面不动，既有 31 个 evidence 测试全绿。
- `engine.ts` 271 行，四个子模块各 125–191 行，单一职责可导航。
- 源码行数基线随 `pnpm measure:update` 更新；新增 spec 为文本契约测试，行数上限随文件增长需要维护（若未来编排层合法增长，应重新评估拆分而非放宽阈值）。
- 行为零变更：纯移动 + 函数签名透传（`computeOverallScore` 由读 `this.weights` 改为显式权重参数，调用点传入同一 `this.weights`）。
