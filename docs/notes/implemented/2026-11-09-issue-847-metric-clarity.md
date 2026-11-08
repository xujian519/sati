# Agent Note: #847 三项口径债的处置（pairwise 字段 / 流式 token 计量 / 金标 signals 来源标注）

Status: implemented

## Problem

#830（专利撰写增强）收口时如实登记了三条未完成项，但没有独立载体，后来人容易把它们当成既定事实：

1. **pairwise fixture 字段口径漂移**——计划文档 T7.2 要求每对含 `id`/`output_a`/`output_b`/`preference`（模型**输出文本**），实现却用 `score_a`/`score_b`（模型 **rubric 分数**）。二者度量的不是一回事：前者是「文本序 vs 人工偏好」，后者是「分数序 vs 人工偏好」。
2. **live 基线 token 未能量测**——OpenAI 协议下**流式响应默认不返回 usage**，除非显式请求 `stream_options.include_usage`。Sati 从不携带该字段，于是 provider 侧 token 计量恒为空，「撰写评测到底花多少钱」这个问题无解。
3. **金标 `signals` 是「录制」而非「当场输出」**——金标语料的 `signals` 由确定性规则生成（`scripts/patent-golden-signals.ts`），不是 claim-breadth / enablement 子图的当场真实输出。两套口径在语料里**长得一样**，没有机制阻止后续误用。

## Decision

**① pairwise：按实现更正文档，不改实现。**

取 rubric 分数是**有意选择**——代理师抽检本就按 rubric 打分，分数是抽检时真实产出的量。实现、语料、校准文档、决策记录自始一致，**只有计划文档一处未同步**。故修文档而非改实现（改实现需重录人工标注语料，成本高且无收益）。

口径锚点写入计划文档：pairwise 语料度量「分数序 vs 人工偏好」；若后续要度量「文本序 vs 人工偏好」，须**另立字段名另立语料**，不得复用本语料。

**② token 计量：请求侧开口 + 端点降级。**

- `src/model/providers/openai/request.ts`：流式请求下发 `stream_options: { include_usage: true }`（非流式不下发——非流式响应本就自带 usage 字段）。
- `src/model/streaming/streamUsageFallback.ts`（新增）：端点因不认该字段回 400 时，**降级重试**一次（去掉该字段重发）。判据收紧为「400 **且** 错误体明确点名 `stream_options`」——否则 400 是真实参数错误，重试只会掩盖问题，且第二次请求同样会失败。
- 降级重试走 `sendWithEndpointFallback` 的 `allowUsageFallback=false` 分支，**显式阻断递归**（不依赖「降级后 body 已无该字段」这一隐式前提）。

取舍：宁可不计量 token，也不让请求整体失败。`extraBody` 是用户显式配置，若它覆盖了 `stream_options` 则不降级（不该静默剥掉用户的配置）。

**③ 金标 signals：语料层加来源标记，评分层区分口径。**

`DraftingSignals` 新增 `source: "live" | "recorded"`：

| 层 | 改动 |
|---|---|
| 语料 | 每件金标的 `signals` 带 `source: "recorded"`；`normalizeGoldenSignals` 校验取值，非法即报错 |
| 评分 | `signalSource` 扩为 `"graph" \| "recorded" \| "deterministic"` |
| 报告 | 批次报告单列「结论来自金标语料录制信号的维度」；live 报告标注「子图结论来源：live 当场输出」 |

**关键语义**：`recorded`（录制）是**有效结论**——可用于回归、可离线复现、CI 可跑，因此**不**计入 `unverifiedDimensions`；它只新增 `recordedDimensions` 单列。`recorded` 与 `graph` 互不冒充，但都不算「未核验」。

两套口径并列不互相替换：当场输出口径走 `pnpm eval:patent-drafting --live`（`signalSource = "graph"`），金标回归口径走录制信号（`signalSource = "recorded"`）。

## Alternatives Rejected

- **改 pairwise 实现去适配文档**：需重录人工标注语料，成本高且会丢掉「代理师按 rubric 打分」的真实语义。
- **全量给所有 OpenAI 兼容 provider 无条件加 `stream_options`**：11 个走 openai 协议的 provider 中，部分端点会回 400，且无差别投递会掩盖真实错误。改为「默认带 + 端点降级」，把兼容性问题收敛在单点。
- **把金标 `signals` 标为 `deterministic`（未核验）**：会让 A26.3 / A26.4 重新跌出金标回归——那正是 #830 R1 要修的问题。录制结论是有效的，只是来源不同，应当单列而非降级。
- **只写注释不改数据结构**：债的本质是「录制的结论」与「子图真实结论」在语料里长得一样。注释挡不住后续误用，**数据层可辨识**才挡得住。

## Verification

- 新增 `tests/model/streaming/streamUsageAccounting.spec.ts`（4 例）：请求下发/非下发、usage 可解析、400 降级成功、无关 400 不降级。
- `tests/patent/drafting-eval.spec.ts` 增 3 例：语料标记齐备且不误列未核验、recorded 与 live 可区分、非法 `source` 报错。
- 回归：`pnpm eval:patent-drafting` clean 10/10、defect 10/10，均分未变（98.60 / 80.59）——**来源标注不改分数口径**。
- 全量后端测试 6470 pass / 4 fail（4 例为环境依赖：Chrome 缺失、HOME 目录权限、工作区隔离、版本哨兵；已在未改动的基线上复现同样失败）。
- 门禁全绿：typecheck / eslint（0 error）/ biome / event-matrix / doc-claims / debt-ledger / techdebt-metrics / architecture-boundaries / runtime-cycles 等。

## Consequences

- `src/model/streaming/streamModel.ts` 因本功能 +7 行（1085 → 1092），已按 `--update-baseline` 显式追认架构基线，账本 PS-15 同步记录。
- `docs/patent-drafting-eval.md` §4.2 的 255 次调用基线是**修复前**跑的，token 行仍标「API 未返回」；重跑 `--live` 后应替换该行并删除文档「未量测」中的 token 括注。
- `docs/code-facts.md` 的 `src/model/` 文件数 75 → 76（新增 `streamUsageFallback.ts`），已由 `gen:doc-claims` 回填。
