# 评测基准语料扩充至 25 例（#723）

## Problem

`benchmarks/patent-agent/` 只有 4 个用例（新颖性/创造性/充分公开/撰写各 1 例），既无法计算统计显著的基线，也没有覆盖电学、化学、机械、生物、软件五个技术领域，更缺少数值范围、参数限定、马库什选择、第二医药用途、生物材料保藏等边界场景。

## Decision

- 新增 21 个用例，连同既有 4 例共 25 例：电学 5、化学 5、机械 3、生物 3、软件 3、边界 2；法条覆盖 A22.2 / A22.3 / A26.3，既有撰写用例保留 A26.4。
- 每个用例四件套齐全：`statement.md`（公开题目）、`expected.md`（参考结论与推理）、`case.yaml`（元数据）、`rubric.yaml`（私有可观察评分项）。
- `case.yaml` 在 `domain` / `requiredCitations` 之外增加 `field`（技术领域）与 `article`（法条轴）。loader 不消费这两个字段；语料治理测试直接读 YAML，避免为无消费方的元数据扩张 `RegressionCase` 公开类型。
- 新增 `tests/patent/evaluate/benchmark-corpus.spec.ts`：断言用例数 ≥ 20、四件套齐全、五个技术领域齐全、三个法条齐全、`requiredCitations` 与 `expected.md` 引用一致、rubric 权重和为 1、`loadRegressionCases` 能装载全部用例并读入私有 rubric。
- 语料为自拟假想案例：对比文件只用 D1/D2/D3 指代，不写真实公开号、判例号，不编造法条。结论依据通行审查规则——单独对比、三步法、充分公开、数值范围共同端点、选择发明的预料不到技术效果、反向教导、生物材料保藏。
- 保留两个否定结论（电池热失控预警、LSM 索引组合）作为「不具备创造性」样本，避免语料全部为肯定结论而失去判别力。
- 既有 4 个 `case.yaml` 仅补 `field` / `article` 元数据；`statement.md` / `expected.md` / `rubric.yaml` 未改。
- `benchmark_config.yaml` 的 `description` 更新为 25 例与覆盖范围；`eval_runtime` 保持不变（分数跨版本可比的前提）。

## Deviations

- 边界两例（数值范围、参数限定）的 `field` 记为 `mechanical`：`field` 表示技术领域，两例分别涉及铝合金时效工艺与电池极片工艺，归入机械领域；边界属性由用例 id 前缀表达。
- `field` / `article` 未进入 loader：当前没有按领域/法条调度的消费方，语料治理测试直接读文件即可满足验收；若后续需要按维度筛选，再把字段提升进 `CaseMeta` / `RegressionCase`。

## Content review

- 21 例逐例复核：新颖性例给出逐特征对比，创造性例给出三步法与结合动机，充分公开例给出缺失手段与修改方向；每例 `expected.md` 引用与 `requiredCitations` 相同的条款号。
- 这是作者自审，不等同于外部专利代理师评审；如后续引入专家评审，应在首次正式 scoreboard 录制前补充，并在评测记录中注明评审范围。
- 未运行真实 LLM 评测：本 PR 只扩充语料并加装载/治理测试，不产生分数；真实评测需要 key 与模型运行时，不在本 PR 范围。

## Alternatives considered

1. **直接采用公开审查决定或考试题原文**：真实感更强，但有版权与「背题」偏差风险，且容易引入无法核验的公开号/决定号；本 PR 选择自拟假想案例并统一用 D1/D2/D3 指代。
2. **把 `field` / `article` 加进 loader 与 `RegressionCase`**：可被运行时消费，但当前没有按维度的调度或报表需求，会扩大公开类型面；治理测试直接读 YAML 已能锁定验收标准。
3. **用统一模板批量生成 21 例**：文件产出快，但推理链会同质化、rubric 失去区分度；本 PR 按不同法条与事实模式逐例撰写（选择发明、反向教导、结果性限定、保藏缺陷等）。
4. **只加语料文件、不加测试**：验收标准无法执行，后续删文件或漏 rubric 不会被发现；新增语料治理测试作为硬门槛。
5. **断言用例数恰好为 25**：会阻碍后续继续扩充；按 issue 验收口径断言 ≥ 20，并单独断言五领域与三法条齐全。
6. **只放肯定结论**：语料会偏向「都能过」，无法检验模型是否会误判显而易见/无新颖性；保留两例否定结论。

## Consequences

- 基准用例从 4 增至 25；实际跑评测时耗时与 token 消耗相应增加（本 PR 不跑真实评测）。
- `tests/patent/evaluate/benchmark-corpus.spec.ts` 新增 5 个子测试，`docs/technical-debt/metrics.md` 的 tests 文件数随之更新。
- 语料仍是种子集，不构成统计显著基线；后续可按 scoreboard 结果继续补充难例。
- 无 UI、无运行时行为变更；不涉及浏览器验证。
