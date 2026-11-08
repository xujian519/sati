# 专利撰写 pairwise 校准（#830 M7）

## 目的

用代理师的两两偏好检验模型 rubric 分数是否与人类判断同向，避免「分数看起来合理、排序却是反的」。

## 数据格式

JSONL，每行一对：

```json
{"id":"pw-001","score_a":4.2,"score_b":3.1,"preference":"a"}
```

- `score_a` / `score_b`：模型 rubric 分数（有限数）。
- `preference`：`a` | `b` | `equal`，代理师的人工偏好。

首批 10 对样例在 `tests/patent/fixtures/pairwise/sample.jsonl`，用于打通流程与回归脚本，不代表真实分布。

## 指标

Kendall τ-b（含 tie 修正）：

```
τ = (C - D) / sqrt((n0 - n1)(n0 - n2))
```

- `C` / `D`：同序 / 反序对数
- `n0`：总对数
- `n1` / `n2`：模型分数 / 人工偏好各自并列的对数

## 运行

```bash
pnpm tsx scripts/patent-pairwise-eval.ts --input tests/patent/fixtures/pairwise/sample.jsonl
```

输出对齐对数、并列数、τ、近似 95% 置信区间与不一致项。按计划 **τ < 0.4 不 fail**，只提示人工抽检；数据量不足时 τ 方差大，强制红门禁会制造噪声。

与撰写评测并列输出（M7 T7.4）：

```bash
pnpm tsx scripts/patent-drafting-eval.ts --pairwise
```

同一份报告里同时给出 rubric 撰写分与 pairwise τ，便于对照解读（τ 达标与否不影响退出码）。

### 置信区间说明

报告中的 95% 区间为**正态近似**（`SE ≈ sqrt((1 - τ²) / n₀)`，忽略 tie 修正）：

- 样本量小时区间很宽，**只作参考，不作达标依据**（达标仍看 τ 阈值 0.4）；
- τ = ±1 时方差为 0，区间退化为 `[τ, τ]`（不是"缺区间"）；
- 区间为近似值，不用于统计推断结论。

## 当前基线

样例数据（10 对，2 对并列）τ = 1.0000，95% 近似区间 [1.0000, 1.0000]。这只证明脚本与数据管线可用，不代表真实撰写质量；接入真实代理师标注后需重新记录基线。
