# DSH 专利撰写增强回移实施计划（2026-11-02）

> 日期：2026-11-02
> 状态：proposed
> 跟踪：[#830](https://github.com/xujian519/sati/issues/830)
> 来源：DSH 专利撰写增强排期计划（[dsh-patent #689](https://github.com/xujian519/dsh-patent/issues/689)）的回移评估
> 范围：`src/patent/`（anchor / graph domains / atoms / evaluate / workflow）、`tests/patent/`、`docs/notes/`
> 非目标：A26.3 enablement 原子重做（Sati 子图已更成熟）、writing-patterns 语料搬运（Sati 自有语料更全）、UI 改动、gateway 协议改动

## 1. 目标与验收口径

### 1.1 必须达成的结果

| 编号 | 结果 | 判定方式 |
|---|---|---|
| R1 | A26.4 权利要求支持/清楚判定上线，与 A26.3 对称 | `claim-breadth` 子图在金标与种植缺陷集上回归通过；`legal-gaps` 聚合不再将 A26.4 标记为 `not-assessed` |
| R2 | 权要撰写从"单次 LLM"拆为"特征表→策略→成文→lint"四步 | `draft-claims` 输出结构化从权树；`claim_lint` 零 error 才放行；确定性排版不压低现有五维分数 |
| R3 | 交底→权要摘录有确定性锚点证据 | `anchor` 模块对权要特征在交底书/说明书中的命中给出归一化区间；A26.3/A26.4 结论均引用锚点证据 |
| R4 | 撰写质量有可校准评测 | `disclosure-drafting` 评测案入库；金标 ≥20 件；pairwise 校准框架可跑 Kendall τ |

### 1.2 量化指标

| 指标 | 现状（2026-11-02） | 目标 | 测量方式 |
|---|---|---|---|
| A26.4 判定管线 | 仅有推理模式元规则，无判定 | 子图 + 规则门闭环 | `tests/patent/claim-breadth.spec.ts` 绿 |
| 权要撰写步数 | 1 步（单次 LLM） | 4 步（strategy→draft→lint→coverage） | manifest 阶段数 |
| claim_lint 规则数 | 0 | ≥6（术语清楚/支持/功能限定/前序一致/引用基础/多项引用） | 规则注册表 |
| 锚点命中确定性 | 无 | 归一化+连续子串+命中区间，可逆不改写 | `tests/patent/anchor.spec.ts` 绿 |
| 金标用例（撰写域） | <10 | ≥20 | `patent-golden-*.json` 计数 |
| pairwise 校准 | 无 | 框架就绪（τ 未达标只出报告不 fail） | `scripts/patent-pairwise-eval.ts` 可运行 |

## 2. 约束与原则

1. **复用 Sati 架构，不照搬 dsh 结构**：Sati 同时有 atoms 与 graph nodes；A26.4 走 graph（与 enablement 对称），anchor/lint 走纯函数+atom。不引入 dsh 的 `legal-gaps` 字段名，改为 Sati 自有状态聚合（避免"同一约束两套口径"）。
2. **降级不静默**（AGENTS.md 铁律 11）：anchor 未命中、lint 降级、评测未量测必须回答"谁因此漏了什么"。
3. **一个 PR 一个里程碑**：独立可回滚，不夹带重构。
4. **契约变更同步成本**：改 `inputSchema`（含描述）→ 重录 llm-replay；改 `AgentEvent` → `pnpm gen:event-matrix`。本方案新增原子须重录 fixture。
5. **新增 `*.test.ts` 必须 `git add -f`**（`.gitignore` 忽略该后缀）。
6. **非平凡变更同 PR 带 `docs/notes/` 决策记录**（含 `## Alternatives considered`）。
7. **确定性优先**：anchor、claim_lint、spec 预检均为纯函数；LLM 只在策略/成文/综合结论环节出现。

## 3. 工作分解总表

| ID | 里程碑 | 优先级 | 依赖 | 主要落点 | 预计 |
|---|---|---|---|---|---|
| M1 | anchor 摘录匹配模块（地基） | P0 | — | `src/patent/anchor/` | 2d |
| M2 | A26.4 claim-breadth 子图 | P0 | M1 | `src/patent/graph/domains/claim-breadth.ts` | 3d |
| M3 | claim_strategy 原子 + 从权树 | P0 | — | `src/patent/atoms/handlers/builtin/draft.ts` | 2d |
| M4 | claim_lint 确定性校验门 | P0 | M3 | `src/patent/claim-lint/` | 2d |
| M5 | disclosure-drafting 评测案 + rubric | P1 | M2、M4 | `src/patent/evaluate/`、`tests/patent/` | 2d |
| M6 | 说明书实施例分块（增强） | P2 | M1 | `src/patent/graph/domains/enablement.ts`、`spec/checks.ts` | 2d |
| M7 | pairwise 校准评测纪律 | P1 | M5 | `scripts/patent-pairwise-eval.ts` | 1d |

**实施波次**：

```
Wave 1（地基 + 最大缺口）  M1(anchor) ──→ M2(A26.4)
                          M3(strategy) ──→ M4(claim_lint)
Wave 2（评测 + 增强）      M5(评测案)  M6(分块)  M7(pairwise)
```

> M1 与 M3 无依赖可并行；M2 依赖 M1 的锚点证据；M4 依赖 M3 的从权树结构。

---

## 4. 逐项方案

### M1｜anchor 摘录匹配模块

**问题**：Sati 的 A26.3/A26.4 判定全靠 LLM 主观判断"权要特征是否在说明书有依据"，无确定性证据层。DSH 的 `anchor/` 提供归一化+连续子串+命中区间，是两条判定主线的共同地基。

**决策**：

- 新建 `src/patent/anchor/`，纯函数零依赖（与 `spec/checks.ts` 同层）。
- 归一化**只做可逆处理**：全角/半角统一、空白折叠、标点标准化；**不做同义改写**（避免误报）。
- 匹配策略：连续子串优先；跨段匹配需显式声明（权要特征常跨说明书多段）。
- 输出：`Array<{ feature: string; hit: { start: number; end: number; section?: string }; normalized: string }>`，未命中返回空数组（不抛错）。

**改动点**：

- `src/patent/anchor/index.ts`（归一化、匹配、命中区间）
- `src/patent/anchor/types.ts`
- `tests/patent/anchor.spec.ts`

**任务清单**：

- [ ] T1.1 归一化函数：全角→半角、Unicode 空白折叠、中英文标点统一；可逆（记录原始偏移映射）
- [ ] T1.2 连续子串匹配：单特征在交底书全文中找最长命中，返回字节区间
- [ ] T1.3 跨段匹配：特征含分句标记时逐段匹配并合并区间
- [ ] T1.4 批量匹配入口：`matchFeatures(text, features[])` → 命中数组
- [ ] T1.5 与 `splitSpecSections` 集成：命中区间标注所属章节
- [ ] T1.6 录制 5 条夹具（含全角/跨段/未命中边界）

**验收清单**：

- [ ] 全角特征与半角正文可命中，区间正确
- [ ] 未命中返回空数组，不抛异常
- [ ] 归一化不做同义改写（"包括"≠"包含"）
- [ ] `pnpm run test -- anchor` 绿
- [ ] `docs/notes/` 决策记录（含"为什么不做同义改写"备选）

**风险**：归一化过度会引入误报。缓解：只做可逆处理，误报样本进夹具。

---

### M2｜A26.4 claim-breadth 子图

**问题**：Sati 有完整的 A26.3 enablement 子图，但 A26.4（权利要求清楚/以说明书为依据）只有 `checker/reasoning-claims.ts` 的推理模式元规则，没有真正的判定管线。这是撰写链路最大的法律缺口。

**决策**：

- 复用 A26.3 子图的图结构（`buildEnablementGraph` 范式），新建 `src/patent/graph/domains/claim-breadth.ts`。
- 节点链：`load`（权要+说明书切片）→ `anchor_evidence`（M1 确定性匹配）→ `clarity`（术语清楚）→ `support`（以说明书为依据）→ `functional_limit`（功能性限定不过宽）→ `conclude` → `approval` → `rule_gate`。
- `anchor_evidence` 是确定性节点，把每个权要特征的命中区间注入下游 LLM 节点作为证据。
- `rule_gate` 检查域复用 `patent_claims`。
- 不引入 dsh 的 `legal-gaps` 状态字段；在 `conclude` 节点输出结构化 `{ support_ok, clarity_ok, gaps[] }`，由 `extractClaimBreadthResult` 提取。

**改动点**：

- `src/patent/graph/domains/claim-breadth.ts`（新建）
- `src/patent/graph/domains/index.ts`（导出）
- `tests/patent/claim-breadth.spec.ts`
- `src/patent/workflow/manifests.ts`（起草管线 `disclosure` 后插入 `claim_breadth` 阶段）

**任务清单**：

- [ ] T2.1 定义 JSON Schema（clarity / support / functional_limit / conclude）
- [ ] T2.2 `load` 节点：读权要文本+说明书章节切片
- [ ] T2.3 `anchor_evidence` 节点：调 M1 `matchFeatures`，产出特征→命中区间映射
- [ ] T2.4 `clarity` LLM 节点：术语含义是否明确、是否有不确定表述
- [ ] T2.5 `support` LLM 节点：权要概括范围是否得到说明书支持（结合锚点证据）
- [ ] T2.6 `functional_limit` LLM 节点：功能性限定是否以说明书实施方式为限
- [ ] T2.7 `conclude` 节点：综合结论 + `extractClaimBreadthResult` 提取函数
- [ ] T2.8 边连接 + rule_gate + approval（与 enablement 子图对称）
- [ ] T2.9 起草 manifest 插入 `claim_breadth` 阶段（`disclosure_approval` 之后、`draft_claims` 之前，用于交底书阶段的权要预评估；或在 `draft_claims` 之后对草稿做 A26.4 复核）
- [ ] T2.10 录入声明表 `CLAIM_BREADTH_INPUT_DECLARATIONS`（溯源）

**验收清单**：

- [ ] 干净样本 `support_ok=true`，缺陷样本 `false`
- [ ] `anchor_evidence` 为确定性节点，不调 LLM
- [ ] `rule_gate` 检查域 `patent_claims` 生效
- [ ] `pnpm run test -- claim-breadth` 绿
- [ ] `pnpm check:event-matrix` 绿（新增节点可能影响事件矩阵）
- [ ] 起草 manifest 串联后 `drafting-sop-fullrun.spec.ts` 不破坏

**风险**：`draft_claims` 之前还是之后跑 A26.4？交底书阶段无权要文本，只能对"预期权要"做预评估；草稿阶段可对实际权要复核。**决策：两阶段都接**——交底阶段用 `disclosure` 产出的"建议权要特征"做预评估，草稿阶段对 `claims_draft` 做正式复核。在 manifest 里用两个不同 atom 调用。

---

### M3｜claim_strategy 原子 + 从权树

**问题**：Sati 的 `draft-claims` 是单次 LLM 调用，输出 `claims: string[]`，无策略层、无从权树结构、无可解释性。DSH 把它拆为"特征表→策略→成文"。

**决策**：

- 扩展 `DraftClaimsInput`，新增从权树结构：每个权项有 `claimNo`、`type: independent|dependent`、`dependsOn?: number[]`、`features: string[]`。
- 新增 `claim-strategy` 原子：输入 PFE 三元组 + 区别特征，输出**特征策略表**（哪些特征进独权、哪些进从权、从权的层级关系）。
- 改造 `draft-claims`：输入从策略表，按树结构渲染权要文本；线性行为保持（独权在前、从权按依赖顺序）。
- 保持现有 `claims_draft` 输出键不变（向后兼容），新增 `claims_tree` 结构化输出。

**改动点**：

- `src/patent/atoms/handlers/builtin/draft.ts`（`claim-strategy` 原子 + `draft-claims` 改造）
- `src/patent/atoms/handlers/builtin/index.ts`（注册）
- `tests/patent/draft-claims.spec.ts`（扩展）

**任务清单**：

- [ ] T3.1 定义 `ClaimStrategy` 与 `ClaimTreeNode` 类型
- [ ] T3.2 `claim-strategy` 原子：PFE+区别特征→策略表（独权特征集+从权层级）
- [ ] T3.3 `draft-claims` 改造：读策略表，按树渲染，输出 `claims_draft`+`claims_tree`
- [ ] T3.4 渲染器：独权"其特征在于"前序+特征；从权"根据权利要求X所述的..."
- [ ] T3.5 向后兼容：无策略表时走旧路径（单次 LLM）
- [ ] T3.6 前后对照：记录五维分数变化，若独权质量下降则只替换从权

**验收清单**：

- [ ] `claims_tree` 中从权的 `dependsOn` 指向前序权项
- [ ] 无策略表输入时旧路径仍可用
- [ ] 五维分数不下降（对照基准记录在 PR 描述）
- [ ] `pnpm run test -- draft-claims` 绿

**风险**：确定性排版可能压低独权质量。缓解：先只替换从权，独权保留策略约束下的自由措辞；前后对照写进 PR 描述。

---

### M4｜claim_lint 确定性校验门

**问题**：Sati 只有 `claim-coverage`（权项是否引用实施例），没有对权要文本本身的确定性 lint（术语清楚、引用基础正确、多项引用规则等）。

**决策**：

- 新建 `src/patent/claim-lint/`，纯函数规则集（与 `slop-engine`、`spec/checks.ts` 同范式）。
- 规则（≥6 条，全部确定性）：
  1. **术语清楚**：权要含"等""约""适当""可以"等不确定词 → error
  2. **引用基础**：从权"根据权利要求X所述的Y"中 X 必须存在且 < 当前权项号
  3. **多项引用**：从权不得引用多项从属权利要求（细则规定）
  4. **前序一致**：从权主题名称与被引用权项一致
  5. **功能限定**：纯功能性限定（无结构/步骤特征）标 warn（需说明书支撑）
  6. **编号连续**：权项编号 1..n 无断裂
- 输出 `{ errors: LintIssue[]; warnings: LintIssue[]; passed: boolean }`。
- 在起草 manifest 的 `draft_claims` 之后、`claim_coverage` 之前插入 `claim_lint` 阶段；error 级回退 `draft_claims` 重跑（有界 1 次），warn 级透传。

**改动点**：

- `src/patent/claim-lint/index.ts`（规则引擎）
- `src/patent/claim-lint/rules.ts`（规则实现）
- `src/patent/claim-lint/types.ts`
- `src/patent/atoms/handlers/builtin/`（`claim-lint` 原子包装）
- `tests/patent/claim-lint.spec.ts`
- `src/patent/workflow/manifests.ts`（插入阶段）

**任务清单**：

- [ ] T4.1 定义 `LintIssue` / `LintResult` 类型
- [ ] T4.2 规则 1：不确定词检测（词表驱动）
- [ ] T4.3 规则 2：引用基础编号校验
- [ ] T4.4 规则 3：多项引用检测
- [ ] T4.5 规则 4：前序主题名称一致
- [ ] T4.6 规则 5：纯功能性限定启发式（warn）
- [ ] T4.7 规则 6：编号连续性
- [ ] T4.8 `claim-lint` 原子包装 + manifest 接线（retry 回退 draft_claims）
- [ ] T4.9 10 条种植夹具（每条触发至少一条规则）

**验收清单**：

- [ ] 每条规则有正/反夹具
- [ ] error 级触发 retry 回退 `draft_claims`
- [ ] warn 级不阻断
- [ ] `pnpm run test -- claim-lint` 绿
- [ ] 起草 manifest 全链路 `drafting-sop-fullrun.spec.ts` 通过

---

### M5｜disclosure-drafting 评测案 + rubric

**问题**：Sati 的 `evaluate` 框架有 CaseRunner+metrics，但无撰写域专用 rubric；撰写质量只有 slop 五维分，缺法律维度（A26.3/A26.4）与结构维度（章节完整、权要布局）。

**决策**：

- 复用 `evaluator.ts` 的 CaseRunner 模式，新增 `disclosure-drafting` 评测案。
- rubric 维度（权重合计 100）：
  - A26.3 充分公开（30）：复用 enablement 子图结论
  - A26.4 支持/清楚（25）：复用 claim-breadth 子图结论
  - 结构完整性（15）：章节齐全 + 权项编号连续
  - 反套话（15）：slop 五维分
  - 权要布局（15）：独权必要特征完整 + 从权层级合理
- 金标用例：从现有 `tests/patent/` fixture 中抽取 ≥20 件交底→权要→说明书对。
- 评测脚本：`scripts/patent-drafting-eval.ts`（复用 `run-patent-agent-eval.ts` 范式）。

**改动点**：

- `src/patent/evaluate/cases/disclosure-drafting.ts`（新建）
- `tests/patent/fixtures/drafting-golden/`（≥20 件）
- `scripts/patent-drafting-eval.ts`
- `docs/patent-drafting-eval.md`（基线记录）

**任务清单**：

- [x] T5.1 定义 rubric 维度与权重（`problem-space.yaml` 四不变量：维度全覆盖/权重合计100/节点已声明/无环）
- [x] T5.2 CaseRunner：跑完整起草管线 → 聚合五维分数（`runDraftingPipeline`，评测场景自动放行 HITL 门）
- [x] T5.3 金标用例录制（≥20 件，含 clean/defect 两类；当前 20 件为已录制产物语料）
- [x] T5.4 评测脚本：批量跑 + 输出 BatchReport（`pnpm eval:patent-drafting`）
- [x] T5.5 基线入库：成本、token、五维分数写入评测 README（`docs/patent-drafting-eval.md`；确定性基线零 LLM 调用，2026-11-07 补 live 基线：20 件信号 + 4 件管线，Moonshot `kimi-k2.7-code-highspeed`；token 因 provider 流式响应不含 usage 未能量测，已显式标注）

**验收清单**：

- [x] rubric 权重合计 100，无遗漏维度
- [x] 20 件金标全跑通，产出 BatchReport
- [x] 基线记录含 clean/defect 分类分数（clean 均分 94.90 / defect 均分 78.08）
- [x] `pnpm run test -- evaluate` 绿（`tests/patent/drafting-eval.spec.ts` 6/6）

**风险**：金标录制成本高。缓解：优先用现有 fixture 扩充，真实交底逐步补充。

---

### M6｜说明书实施例分块（增强）

**问题**：Sati 的 `splitSpecSections` 只切五部分，长说明书的"具体实施方式"仍按预算截断；DSH 的 PGTree 按实施例分块，每块带特征 ID，让 A26.3/A26.4 证据定位到具体实施例。

**决策**：

- 在 `spec/checks.ts` 新增 `splitEmbodiments(text)`：按"实施例X""【实施例X】"等模式切分具体实施方式。
- 每块带 `embodimentId`、`featureIds`（从权要特征锚点命中推断）、`charBudget`。
- 在 `enablement` 子图的 `load` 节点产出 `embodiment_chunks`，`buildSpecContext` 优先按块拼接（而非整节截断）。
- 不引入 dsh 的 PGTree-lite 全量图结构，只引入"实施例级分块+特征 ID 绑定"。

**改动点**：

- `src/patent/spec/checks.ts`（`splitEmbodiments`）
- `src/patent/graph/domains/enablement.ts`（`load` 节点 + `buildSpecContext`）
- `tests/patent/spec-checks.spec.ts`（扩展）

**任务清单**：

- [ ] T6.1 实施例分块正则（兼容"实施例一""实施例1""【实施例1】"）
- [ ] T6.2 每块特征 ID 绑定（调 M1 anchor 匹配权要特征）
- [ ] T6.3 `buildSpecContext` 优先按块拼接，块级 `charBudget` 与 slop-gate 协同
- [ ] T6.4 旧 checkpoint 恢复兼容：无分块时回退全文截断

**验收清单**：

- [ ] 多个实施例的说明书正确分块，每块有 `embodimentId`
- [ ] 带特征 ID 的实施例不按套话篇幅砍
- [ ] 无实施例标记时回退旧行为
- [ ] `pnpm run test -- spec-checks` 绿
- [ ] enablement 子图回归不破坏

---

### M7｜pairwise 校准评测纪律

**问题**：Sati 的评测以规则门+关键词召回为主，缺"与代理师判断的一致性"度量。DSH 的 pairwise + Kendall τ 是专利 NLP 评测标准做法。

**决策**：

- 新建 `scripts/patent-pairwise-eval.ts`：输入 N 对（模型输出A，模型输出B，代理师偏好），计算 Kendall τ。
- τ 未达标（<0.4）时**只出报告不自动 fail**（与 DSH 一致），维持人工抽检。
- 校准数据存 `tests/patent/fixtures/pairwise/`，每对含 `id`、`output_a`、`output_b`、`preference`（a/b/equal）。
- 与 M5 的金标评测并列报告。

**改动点**：

- `scripts/patent-pairwise-eval.ts`（新建）
- `tests/patent/fixtures/pairwise/`（校准数据，逐步累积到 50 对）
- `docs/patent-pairwise-calibration.md`（方法说明）

**任务清单**：

- [ ] T7.1 Kendall τ 计算函数（含 tied 处理）
- [ ] T7.2 校准数据加载器（JSONL）
- [ ] T7.3 报告生成：τ 值、置信区间、未达标项列表
- [ ] T7.4 与 M5 评测脚本集成：撰写分与 τ 并列输出

**验收清单**：

- [ ] 脚本能对给定 pairwise 数据计算 τ
- [ ] τ<0.4 时退出码 0（不 fail CI），但报告明确标记
- [ ] 至少 10 对校准数据入库（其余逐步累积）
- [ ] `docs/patent-pairwise-calibration.md` 说明方法与当前 τ

---

## 5. 阶段收口检查清单（每个 PR 合并前）

- [ ] `pnpm run build:artifacts` 后 `pnpm run build:check`
- [ ] 相关 `pnpm run test -- <包名>`
- [ ] 模型可见输出变化时更新 keyless 快照 / 重录 llm-replay
- [ ] 包级行为变更补 `docs/upgrade-guide/` 条目
- [ ] `pnpm run doc-sync`
- [ ] 无新增 `as unknown`
- [ ] 标签：一个 `kind/*` + 全部相关 `area/*`
- [ ] 非平凡变更同 PR 带 `docs/notes/` 决策记录

## 6. 里程碑级额外检查

- [ ] M1：归一化只做可逆处理，误报样本进夹具
- [ ] M2：A26.4 子图有「报告存在、判定缺失」的负向测试
- [ ] M3：独权质量前后对照写进 PR 描述
- [ ] M4：每条 lint 规则有正/反夹具
- [x] M5：rubric 权重合计 100，无遗漏维度
- [ ] M6：分块不破坏旧 checkpoint 恢复
- [ ] M7：τ 未达标不自动 fail CI

## 7. 风险登记

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| anchor 归一化误报 | 中 | A26.3/A26.4 证据不可信 | 只做可逆处理；误报样本进夹具 |
| 确定性排版压低独权质量 | 中 | 五维分数下降 | 先换从权；独权保留策略约束下措辞；前后对照 |
| 金标录制成本高 | 高 | M5 延期 | 先用现有 fixture 扩充，真实交底逐步补充 |
| A26.4 两阶段接线冲突 | 中 | 起草管线混乱 | 交底阶段用建议特征预评估，草稿阶段用 claims_draft 复核，两阶段不同 atom |
| 新增 LLM 调用推高成本 | 中 | 评测与日常使用成本上升 | 成本写入 run record；按阶段裁剪提示 |

## 8. 明确不做

- 不重做 A26.3 enablement 原子（Sati 子图已更成熟）
- 不引入 dsh 的 `legal-gaps` 字段名（用 Sati 自有状态聚合）
- 不搬运 writing-patterns 语料（Sati 自有 `skills/patent-draft-*` 更全）
- 不引入 PGTree-lite 全量图结构（只取实施例分块+特征 ID）
- 不以 BLEU/ROUGE 作为优化目标
- 不在链中插入第二个审批门（现有 HITL 审批点已足够）
