# 起草质量 rubric 评测（#830 M5）

> 代码：`src/patent/evaluate/cases/disclosure-drafting.ts` · 语料：`tests/patent/fixtures/drafting-golden/cases.jsonl` · 脚本：`scripts/patent-drafting-eval.ts`

## 1. 评测对象

对「交底书 → 权利要求 + 说明书」这一起草产物做五维 100 分制评分。评分只读落盘产物，
不读中间推理，因此同一份产物无论由哪条管线（graph / workflow / 人工）产出，分数一致。

| 维度 | 分值 | 证据 |
| --- | --- | --- |
| A26.3 充分公开 | 30 | 章节、实施例计数、数值范围端点、效果定量性 |
| A26.4 支持与清楚 | 25 | 权项特征在说明书中的锚点命中率 + `claim_lint` errors |
| 结构完整性 | 15 | 六部分章节命中、权项编号连续、标题行 |
| 反套话 | 15 | `slop-engine` 43 分制线性归一（只评说明书） |
| 权要布局 | 15 | 独权数量、金标必要特征覆盖率、从权引用层级 |

权重合计 100，由 `DRAFTING_RUBRIC_TOTAL` 与单测双重保证。

### 信号来源（降级可见）

A26.3 / A26.4 优先使用子图结论（`enablement` / `claim_breadth`），此时
`signalSource = "graph"`。未注入子图结论时退到确定性代理，标记
`signalSource = "deterministic"`，并在 BatchReport 的 `unverifiedDimensions`
中列出。**确定性代理不等于子图已核验**——两者在报告里必须可区分。

`collectDraftingSignals()` 可在有真实 provider 时取子图结论：

```ts
const run = await runDraftingPipeline(disclosure, { provider });
const signals = await collectDraftingSignals({ claims: run.claims, spec: run.spec }, { provider });
const score = scoreDraftingArtifacts({ ...run, requiredFeatures: goldFeatures }, signals);
```

## 2. 金标语料

`tests/patent/fixtures/drafting-golden/cases.jsonl`，20 件：

- 10 件 clean：机械 / 电子 / 软件 / 化学 / 医疗 / 包装 / 农业 / 机器人 / 光学 / 能源；
- 10 件 defect：缺章节、无实施例、效果无定量、套话堆砌、编号断档、不确定用语、
  特征无说明书依据、独权过窄、无从权、多项独权。

每条记录包含 `disclosure`、`claims`、`spec`、`requiredFeatures`；defect 用例另有
`expectedFailures`（期望失分维度）。`expectedFailures` 是判定 defect 是否被检出的依据，
**不是**要求总分低于通过线——rubric 是诊断量表，单一缺陷允许总分仍高于 80。

## 3. 运行

```bash
pnpm eval:patent-drafting                       # 默认语料，表格输出
pnpm eval:patent-drafting --json                # BatchReport JSON
pnpm eval:patent-drafting --corpus <path>       # 自定义语料
pnpm eval:patent-drafting --pass-line 85        # 调整 clean 通过线
pnpm eval:patent-drafting --live                # 真实模型：信号轮全量 + 管线轮 4 件
pnpm eval:patent-drafting --live --pipeline-cases 0   # 只跑信号轮
pnpm eval:patent-drafting --live --provider deepseek --model deepseek-flash
```

（本仓 pnpm 版本不会吞掉 `--`，追加参数直接写在脚本名后；写成 `-- --json` 会被当成未知参数。）

退出码：clean 必须全部过线，且 defect 必须在声明的期望维度上失分；`--live` 轮任一用例失败同样返回 1，避免「没跑成」被当成通过。

逐案状态列：clean 显示 `pass` / `fail`（对总分过线），defect 显示 `detected` / `missed`
（对期望维度失分），两者判定口径不同，不要混读。

## 4. 基线（2026-11-07）

### 4.1 确定性基线（已录产物）

确定性口径，`passLine = 80`：

| 指标 | 结果 |
| --- | --- |
| clean 通过率 | 10/10（100%） |
| clean 均分 | 94.90 |
| defect 检出率 | 10/10（100%） |
| defect 均分 | 78.08 |

分维度均分：

| 维度 | clean | defect |
| --- | --- | --- |
| A26.3 充分公开 | 26.30 | 15.60 |
| A26.4 支持与清楚 | 25.00 | 22.79 |
| 结构完整性 | 15.00 | 14.07 |
| 反套话 | 13.60 | 13.32 |
| 权要布局 | 15.00 | 12.30 |

### 成本与 token

本次基线**零模型调用、零 token**：语料是已记录的起草产物，评分全部为确定性正则/计数逻辑。
因此它可离线复现，也适合进 CI。

本表回答的是「给定产物，五维规则是否稳定、缺陷是否被规则识别」；A26.3 / A26.4 两维
在此口径下是确定性代理，不是子图核验结果。需要子图结论的 live 口径见 §4.2。

### 4.2 live 基线（真实模型，2026-11-07）

```bash
pnpm eval:patent-drafting --live --provider moonshot --model kimi-k2.7-code-highspeed
```

| 项 | 值 |
| --- | --- |
| provider / model | `moonshot` / `kimi-k2.7-code-highspeed` |
| 信号轮覆盖 | 20 件（10 clean / 10 defect），全部完成、0 失败 |
| 管线轮覆盖 | 4 件（2 clean / 2 defect），全部完成、0 失败 |
| 模型调用合计 | 255 次 |
| token | **API 未返回**（流式响应不含 usage 事件），不按 0 计 |
| 未核验维度 | 结构完整性 / 反套话 / 权要布局（这三维无子图，始终确定性） |

信号轮（`collectDraftingSignals` 跑 enablement + claim_breadth，A26.3 / A26.4 变为
`signalSource = graph`）：

| 指标 | 确定性基线（§4.1） | live 信号基线 |
| --- | --- | --- |
| clean 通过率 | 10/10（100%） | **2/10（20%）** |
| clean 均分 | 94.90 | **73.40** |
| defect 检出率 | 10/10（100%） | **9/10（90%）** |
| defect 均分 | 78.08 | **72.79** |

| 用例 | 类别 | 总分 | 状态 |
| --- | --- | --- | --- |
| clean-mechanical-001 | clean | 98.60 | pass |
| clean-electronic-002 | clean | 98.60 | pass |
| clean-software-003 | clean | 68.60 | fail |
| clean-chemical-004 | clean | 56.60 | fail |
| clean-medical-005 | clean | 68.60 | fail |
| clean-packaging-006 | clean | 68.60 | fail |
| clean-agriculture-007 | clean | 68.60 | fail |
| clean-robotics-008 | clean | 68.60 | fail |
| clean-optics-009 | clean | 68.60 | fail |
| clean-energy-010 | clean | 68.60 | fail |
| defect-missing-sections-011 | defect | 73.88 | missed（enablement 未失分） |
| defect-no-embodiment-012 | defect | 56.60 | detected |
| defect-vague-effects-013 | defect | 68.60 | detected |
| defect-slop-heavy-014 | defect | 97.21 | detected |
| defect-numbering-gap-015 | defect | 52.60 | detected |
| defect-uncertain-terms-016 | defect | 81.60 | detected |
| defect-unsupported-feature-017 | defect | 85.60 | detected |
| defect-weak-independent-018 | defect | 68.60 | detected |
| defect-no-dependents-019 | defect | 93.60 | detected |
| defect-multi-independent-020 | defect | 49.60 | detected |

结论与解释：

- clean 从 10/10 掉到 2/10：8 件 clean 的交底书被 enablement 子图判为
  `sufficientlyDisclosed = false`（语料是简短合成文本，子图按 A26.3 三步审查从严），
  A26.3 由 30 分降为 0 分；其中 clean-chemical-004 的 claim_breadth 还判「权项不清楚」，
  A26.4 由 25 分降为 13 分（总分 56.6）。其余三维分数与确定性口径完全一致，
  分数差全部来自这两个子图维度。这是子图口径的真实结果，**未调 prompt 或阈值去迎合确定性基线**。
- defect 011 期望「缺章节 → structure + enablement」两维失分，live 只命中 structure；
  enablement 子图认为公开充分，故按整案口径记为未完全检出（9/10）。
- 反套话 / 结构 / 权要布局三维在两种口径下相同，因为它们只来自确定性规则。

管线轮（从交底书重写 claims/spec 后再取同一 rubric）：

| 用例 | 类别 | 总分 | claims 字数 | spec 字数 | 调用 | 降级阶段 |
| --- | --- | --- | --- | --- | --- | --- |
| clean-mechanical-001 | clean | 39.91 | 823 | 2408 | 28 | consistency |
| clean-electronic-002 | clean | 33.23 | 804 | 3493 | 26 | consistency |
| defect-missing-sections-011 | defect | 32.18 | 628 | 3867 | 21 | slop_clean |
| defect-no-embodiment-012 | defect | 33.23 | 778 | 3545 | 20 | — |

- 4/4 未过线（32.18–39.91）：单次生成产出的 claims（0.6–0.8k 字）与 spec（2.4–3.9k 字）
  明显短于金标语料，A26.3 子图判为公开不充分。该口径衡量的是「无检索增强的单次管线产出」，
  不能代表接入检索/多轮修订后的质量。
- 3/4 出现降级（`consistency` 2 件、`slop_clean` 1 件，均为重试/门控阶段无输出）。
  单独重跑 clean-mechanical-001 得到零降级，说明它是单次运行内的非确定性重试结果，
  不是固定缺陷；评测 seam 只暴露阶段 id，原因未结构化（后续可在 `DraftingPipelineRun`
  透出 `degradations`）。
- **未量测**：token 与费用（provider 流式响应不含 usage）；Temperature=0 之外的采样随机性
  未做多次重复；检索增强与多轮修订未接入。以上三项都不在本基线结论范围内。

**口径限制**：DeepSeek `deepseek-flash` 对结构化输出的 `response_format` 返回
`This response_format type is unavailable now`，图形/管线阶段会整段失败；live 基线因此
选用 Moonshot，`--provider/--model` 可换，但换模型后必须重跑并替换本表，不能沿用数字。

## 5. 扩充语料

新增用例只需追加一行 JSONL（字段见第 2 节），保证：

1. `id` 唯一；
2. clean 用例的权项特征在说明书中能被连续子串命中；
3. defect 用例至少声明一个 `expectedFailures`，且该维度确实拿不满分；
4. 新增后重跑 `pnpm eval:patent-drafting`，把新基线更新到本文件第 4 节。
