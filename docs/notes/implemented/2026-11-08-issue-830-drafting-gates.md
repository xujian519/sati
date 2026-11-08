# Agent Note: #830 撰写增强收尾（claim-lint 接线 / claim_breadth 接线 / A26.3 锚点 / 金标信号）

Status: implemented

## Problem

`docs/plans/2026-11-02-patent-drafting-enhancement-import.md` 的 M1–M7 已落地核心产物，
但接线层留了四个实质缺口，导致 issue 的 R1–R4 验收无法真正成立：

1. **M4 只做了纯函数库，没接管线**：`src/patent/claim-lint/` 的 6 条规则齐备，但起草
   manifest 的 `draft_claims` 之后直接是 `claim_coverage`——**管线跑出的权要从不经过
   lint**。lint 唯一的消费方是 M5 的 rubric。
2. **M2 的子图没进 manifest**：`claim-breadth` 子图与工具枚举（`graph=claim_breadth`）
   都在，但 `patent_drafting_v1` 里没有对应阶段——A26.4 判定在真实起草链路中从不执行。
3. **R1 的硬性断点**：`normalizeGoldenCase` 构造返回体时**丢弃了 `signals` 字段**。
   金标里即使写了子图结论也会被静默丢掉，A26.4 在金标路径上恒为「确定性代理」
   （`signalSource=deterministic`，恒列入 `unverifiedDimensions`）——子图结论从未真正
   进入金标回归。
4. **R3 只做了一半**：A26.4 子图有 `anchor_evidence` 确定性节点，A26.3 enablement
   子图却没有——「A26.3/A26.4 结论均引用锚点证据」未成立。

## Decision

- **claim-lint 原子**（`src/patent/atoms/handlers/builtin/claimLint.ts`）：纯函数、零 LLM、
  零 I/O。输出为**严格 JSON**且含 `gaps[]` / `consistent` → 直接对接 workflow 的
  结构化回退判据（`retry.whenOutputGaps`），error 非空即 `consistent:false`，
  回退 `draft_claims` 重跑（有界 1 次）。修订提示走独立键
  `claim_lint_revision_hint`（**非 outputSchema 键** → 回退清理不触及，
  `clearStageOutputs` 只清 outputSchema 内的键），由 `draft-claims` 重跑时注入提示。
  提示只含「哪条权项 / 命中哪条规则 / 怎么改」，不含任何门限数字断言。
- **claim-breadth 原子**（`src/patent/atoms/handlers/builtin/claimBreadth.ts`）：包装
  `claim-breadth` 子图（与 `invalidity-analysis` 原子同范式：原子内跑图）。**两阶段接线**：
  - `claim_breadth_preview`（`claim_strategy` 之后）：读策略表的建议特征做交底阶段预评估，
    在成文前暴露「权要范围超出说明书公开」；
  - `claim_breadth_review`（`draft_claims` 之后）：对实际权要草稿做正式复核。
  阶段区分放在 `payload.phase` 与报告标题里，不靠换主键（**主输出键必须是
  `outputSchema[0]`**，见下方 Consequences 的坑）。
- **金标 signals 透传**：`normalizeGoldenCase` 现在透传 `signals`；新增
  `normalizeGoldenSignals` 校验布尔位，**坏信号直接报错而非静默丢弃**（避免「写了
  但没生效」的假核验）。20 件金标的子图结论由新脚本
  `scripts/patent-golden-signals.ts` 按**确定性规则**生成并入库：A26.3 复用项目既有的
  `checkSectionCompleteness` / `checkEffectQuantification`，A26.4 用锚点连续子串命中 +
  不确定用语词表——零 LLM、离线可复现。
- **A26.3 锚点证据层**：enablement 子图新增 `anchor_evidence` 确定性节点
  （`anchorSpecFeatures`，与 A26.4 同口径），锚点证据注入 `enablement` 节点提示。
  提示词显式声明「未命中只说明无完全相同的原文片段，不等于不能实现——等同公开
  同样构成充分公开」，避免 LLM 把锚点未命中直接当判否依据。
- **M6 补齐**：`embodiment_chunks` 现在**带 features** 生成（`splitEmbodiments(text,
  features)`），块带 `featureIds`；`buildSpecContext` 消费该键，超预算时带锚点特征的
  实施例块优先保留（证据块不被裁掉）。
- **M7 补齐 T7.3 / T7.4**：pairwise 报告新增近似 95% 置信区间（正态近似，样本量小时
  只作参考）；`patent-drafting-eval.ts --pairwise` 让**撰写分与 τ 并列输出**（复用
  独立脚本的同一份实现，避免两套算法漂移）。

## Alternatives considered

- **把 claim-lint 做成 LLM 原子**（上一轮已落选，本轮维持）：规则是确定性的，走 LLM 既慢
  又不可复现，且 lint 结果要驱动 retry 判据——LLM 输出的不确定性会让回退行为不可预期。
  维持「纯函数引擎 + 薄原子包装」。
- **把 claim-lint 做成工具（`tool/builtin/`）而非原子。** 落选。issue 的契约影响栏把
  「工具 inputSchema 变更 → 需重录 llm-replay fixture」列为已知成本，而 claim-lint 的
  消费方是**起草管线内部阶段**，不是用户直接调用的工具；做成工具会平白触发一次 fixture
  重录且没有对应的用户场景。原子（atom）是 workflow 阶段的正确粒度。
- **claim_lint 的 retry 判据用正则（`whenOutputMatches`）而非结构化 `whenOutputGaps`。**
  落选。正则会命中提示词里的「error 0 项 / warning 2 项」等字样，且无法区分「判定为不通过」
  与「输出里恰好出现了某个词」。结构化判据（`gaps[]` 非空 / `consistent:false`）语义精确，
  且项目已有 `needsRedo` 的结构化优先实现。
- **claim-breadth 阶段只接草稿复核，不接交底预评估。** 落选。计划 T2.9 与风险表都明确
  「两阶段都接」——交底阶段用建议特征预评估，才能在成文前暴露超范围缺陷；只接草稿复核
  等于把 A26.4 判定推迟到权要写完之后，纠错成本更高。
- **claim-breadth 原子用两个独立原子（preview/review）而不是一个原子两态。** 落选。
  两个原子的子图构建与结论提取完全重复；用 `claims_draft` 是否存在区分阶段，
  结论里带 `phase` 字段，报告标题也写明阶段，语义同样可辨。
- **在 claim-breadth 原子内启用子图的 approval 门。** 落选。起草管线已有 5 个 HITL 审批门，
  子图内再插一个会造成双重挂起（issue「明确不做」第 6 条）。原子内 `includeApproval:false`。
- **金标 signals 由子图当场跑出来再入库。** 落选。金标回归必须零 LLM、可离线复现、CI 可跑；
  当场跑子图会让金标回归依赖模型与凭据。用确定性规则生成「录制的子图结论」入库，
  子图当场的真实输出走 `--live` 路径（两套口径并列，互不替换）。
- **金标 signals 写坏时静默忽略（退回确定性代理）。** 落选。静默忽略会让「写了信号但没生效」
  表现为「未核验」——正是本次要修的假核验。改为直接报错。
- **enablement 锚点未命中即判 A26.3 不充分。** 落选。锚点是连续子串匹配，同义/等同公开
  必然未命中；把未命中当判否会造成大面积误报。锚点只作**线索**注入提示，判否仍由 LLM
  结合等同公开判断，且提示词显式声明该口径。
- **`buildSpecContext` 无条件按实施例分块拼接。** 落选。计划 M6 的取舍是「只在超预算时改变
  截断分配」——无条件分块会改变 prompt 语义并漂移既有评测基线。维持「不超预算走整节
  全文，超预算才按块均分」。

## Consequences

- **起草管线现在是六步撰写质量门**：`claim_strategy → claim_breadth_preview →
  draft_claims → claim_breadth_review → claim_lint → claim_coverage`（issue R2 的四步
  撰写在此基础上另加 A26.4 两阶段判定）。
- **踩坑记录：workflow 以 `outputSchema[0]` 取阶段主输出**（`src/patent/workflow/executor.ts`）。
  原子若只写非首位的键，阶段输出为空 → 被判降级。实现时踩过一次（claim-breadth 预览
  阶段原按 `preview_` 前缀分键），已改为「两阶段都写主键 + 预览额外写 preview 键」。
  已在 `claim-lint-atom.spec.ts` / `claim-breadth-atom.spec.ts` 加断言锁定该契约。
- **确定性基线变化**（口径变更，非评分漂移）：clean 94.90 → **98.60**、defect 78.08 →
  **80.59**（见 `docs/patent-drafting-eval.md` §4.1）。原因：缺陷件的 A26.3/A26.4 判定
  现在对准真实子图结论口径（缺章节 / 无实施例 / 效果无定量判不充分），而非笼统代理正则。
  A26.3 分维度 clean 26.30 → 30.00、defect 15.60 → 21.00。
- **A26.4 不再是「未核验」维度**：金标路径下 `unverifiedDimensions` 只剩结构完整性 /
  反套话 / 权要布局（这三维无子图，始终确定性）。
- **未完成且不静默**：
  - 金标的 `signals` 是**录制的子图结论**（确定性规则生成），不是子图当场输出；
    当场输出见 `--live` 路径，两者并列入库、不互相替换。
  - M7 的 pairwise fixture 字段名用 `score_a/score_b`（模型 rubric 分数）而非计划写的
    `output_a/output_b`（模型输出文本）——两者语义不同：前者度量「分数序与人工偏好是否一致」，
    后者度量「文本序与人工偏好是否一致」。当前实现取前者（分数序），因为代理师抽检时
    本就按 rubric 打分。计划文档口径待同步。
  - M5 live 基线仍只覆盖 20 件信号 + 4 件管线，token/费用未能量测（provider 流式响应
    无 usage 事件）。
