# P0-1 自进化闭环（专利评测的可回滚迭代）设计方案

> 对标 PenguinHarness 的 `agent-optimization` / `agent-evaluation` / `benchmark-design` 技能
> （`packages/skills/skills/agent-optimization/SKILL.md` 等）。
> 本方案只做**设计**，不实施；评审通过后落为实施计划，落地时补 `docs/notes/implemented/` note。

---

## 1. 目标与范围

让 Sati 具备一条「测量 → 诊断 → 假设 → 候选 → 评估 → 严格接受/回滚」的**跨版本**迭代闭环，用于改进一个**可调度的 agent 角色**（`type: role` 的 `SKILL.md`，经 `roleFromSkill` 装配为 `SubagentDefinition`），而不是只做单次评测。

现状对比（全部核实过）：

| 维度 | Sati 现状 | PenguinHarness | 差距 |
|---|---|---|---|
| 评测基座 | `src/patent/evaluate/`（Evaluator + CaseRunner + BatchReport + consensus/metrics）、`scripts/patent-eval.mjs`、`tests/patent/benchmark/fixtures/*` | 同功能 | 已有 |
| 评分标准 | `PatentExamCase.expected` = 参考答案**文本**，用 keyword_recall / jaccard 做**文本相似度** | rubric = 按**可观察行为**分项、固定 0-100 | **核心差距** |
| 基准冻结 | 无 | Formal Baseline 冻结 | 缺 |
| 版本快照/回滚 | 无（always-on 的 snapshots 只快照文件系统，非 agent state） | `snapshots/v<N>.tar.gz`（Vault 除外） | 缺 |
| 题面/评分分离 | 无 | `statement/` 与 `rubric/` 物理隔离 | 缺 |
| 严格接受 | 无 | 分数严格更高才接受，否则回滚 | 缺 |
| 防污染 | 无 | 校验 runtime 一致、Optimizer 禁读私有评分 | 缺 |

**结论**：Sati 有「单次评测的引擎」，缺「跨版本迭代的协议」。本方案只补协议，复用现有评测引擎。

---

## 2. 被进化对象（Target）的选取

首期选一个 `type: role` 角色 SKILL.md，理由：

- 它就是 Sati 里最贴近 PenguinHarness `Agent State` 的东西：行为定义集中在**一个可编辑文件**（frontmatter `tools/domains/omitTools/readOnly` + body `systemPrompt` + `knowledge` 接线），对应 penguin 的 `system_prompt` + 工具集 + AGENTS.md。
- 它可直接被 `agent` 工具按 `subagent_type` 调度——与 penguin 的 `run_subagent` 一一对应，Evaluator 无需新调度面。
- 迭代它**不碰核心循环**，风险隔离，符合「取设计思想而非全量功能」。

**被明确排除（首期）**：
- `patent workflow manifest`（`assets/workflows/patent/*.yaml` + 内置 manifest）——流程编排更适合工程迭代，模型自改 manifest 风险高、收益难测，二期再议。
- `rules/` 规则包——确定性规则应由人审，不进自进化闭环。

---

## 3. Benchmark 目录结构（新增资产）

新增一个 benchmark 根目录（建议 `~/.sati/benchmarks/`，`SATI_BENCHMARK_DIR` 覆盖），按 id 组织：

```
benchmarks/<benchmark_id>/
├── benchmark_config.yaml          # name / description / target_role / eval_runtime / case 清单
├── <case-id>/
│   ├── statement.md               # 公开：给 Target 角色跑的任务描述
│   └── rubric.yaml                # 私有：分项评分标准，对 Target 完全隔离、不进 Target 上下文
└── scoreboard.yaml                # 评测记录（追加式；Eval 记录 pin 到 session_id）
```

`benchmark_config.yaml` 示例：

```yaml
name: patent-drafting-quality
description: 申请文件撰写角色质量基准（基于 business-drafting fixtures）
target_role: drafting-analyst          # 被进化角色的 subagent_type id
eval_runtime:                          # Evaluator 实际使用的运行时，Optimizer 不得修改
  provider: deepseek
  model_id: deepseek-v4-pro
  thinking_level: medium
# 以下为校验项，Equaltor 只在基准评审时使用
```

**statement 的来源**：把现有 `BusinessPatentExamCase` 的 `{input, clientRole, deliverable}` 组合成**场景化任务描述**（含委托方立场与交付物要求），即 `scripts/patent-benchmark-business.ts` 已归类好的业务用例。`statement.md` 不包含 `expected`。

### rubric.yaml（核心差距的落点）

penguin 的硬约束是「评分项必须**可观察**（行为是否发生），避免让格式/枚举/完整性分析形成高保底分；每 case 固定 100 分」。Sati 现在用 `expected` 文本相似度（keyword_recall/jaccard）正是它要避免的「文本相似度 ≠ 行为达标」。

设计 rubric 为分项断言，每项三字段：

```yaml
max_score: 100
items:
  - id: novelty_distinct_feature      # 断言：是否识别出区别技术特征
    weight: 0.3
    criterion: >-
      是否从对比文件与权利要求的对比中给出至少一个"区别技术特征"，
      并指明其对应的技术问题；仅复述结论而无特征对比不得分。
    behavior: observable               # 只能是 observable，禁止 "分析充分/全面/到位"
  - id: three_step_method
    weight: 0.3
    criterion: >-
      是否显式使用三步法（最接近现有技术 → 区别特征与实际解决的技术问题 → 技术启示/显而易见性判断），
      三步缺一不得分。
  - id: independent_claim_essential_features
    weight: 0.2
    criterion: >-
      独立权利要求是否写入必要技术特征；是否把"具体实施例特征"（如调节螺杆）上位概括为功能性特征。
  - id: legal_citation_correct
    weight: 0.2
    criterion: >-
      引用的法条（如专利法第22条第3款 / 实施细则第17条）是否正确；引用错误或缺失不得分。
```

打分由 **LLM judge 按 rubric 逐项判「行为是否发生」**，对齐 Sati 已有的 `src/patent/evaluate/consensus.ts`（多 judge 并行投票 + Verdict Envelope 三固定序审计），避免单 judge 摇摆。聚合：`case_score = Σ(weight × 该项得分) × 100`，每项布尔或 0/1。

**为什么不用现有 `expected` text 相似度作为评分**：keyword_recall/jaccard 对「格式/措辞/长度」敏感、对「行为是否发生」不敏感，且会自动给长答案高保底分——正是 penguin 明令要避免的。

---

## 4. 新增/改动的代码面

**新增（全部不碰核心循环）**：

1. `src/patent/evaluate/rubric.ts` —— 解析 `rubric.yaml`，构造面向 LLM judge 的评分 prompt，返回结构化分数。纯函数 + 容错（文件缺失/非法一律给出「不作数」信号，仿 penguin `readGoalStatus` 的归一化思路）。
2. `src/patent/evaluate/scoreboard.ts` —— `scoreboard.yaml` 读写；追加式；每个 Eval 记录 pin 到 `session_id`，含 case 分项/run/session。写后 parse 自校验（防少写）。
3. `scripts/patent-evolve.mjs` —— **CLI 驱动闭环**，对标 `patent-eval.mjs`。子命令：
   - `baseline <benchmark_id> --out <snapshot>`：跑首轮 → `scoreboard.yaml` 记为 Formal Baseline + 打 `snapshots/v1`。
   - `batch <benchmark_id> --runs N`：对冻结 case 集跑 N 次（含单次/重复贝叶斯），产出 Eval 记录。
   - `diff <benchmark_id> <vX> <vY>`：对比两版本分数，列出失分类（诊断用）。
   - 内置「严格接受」判定：`--score-must-exceed <ref>`，脚本只接受**严格更高**的结果，否则报回滚指令。
4. `scripts/benchmark-pack-snapshot.mjs`（或并入 `bump-version.mjs` 风格小脚本）：把目标角色 SKILL.md（及非入库依赖）打包到 `<target>/snapshots/v<N>/`，**排除 `.vault.toml` 与一切凭据/env 引用**（对齐 penguin「Vault 除外——密钥永不进快照」）。

**改动（最小）**：
- `src/patent/evaluate/`：`Evaluator` 已是纯 `CaseRunner` 组合，无需改；新增一个 `rubric`-aware 的 `CaseRunner` 封装（把 statement 喂给 Target 角色 → 拿输出 → 按 rubric 打分），不改现有接口。

**复用**：`runRuleGate`（`patentWorkflowTool.ts`）仍作为确定性规则门收口（与 LLM judge 互补）；`consensus` 做 judge 投票；`createNuoSearchProvider` 做检索依赖。

---

## 5. 闭环分阶段

### M1 — 数据面（无 LLM，可独立合入）
- benchmark 目录格式 + `benchmark_config.yaml` 解析。
- `rubric.ts`（解析 + 容错归一）。
- `scoreboard.ts`（读写 + 追加式 + 写后自校验）。
- 从一个 `business-drafting.json` 用例手工转一个 `statement.md + rubric.yaml` 样例。
- 单测：rubric 解析、scoreboard 追加/污染校验、snapshot 排除密钥。

### M2 — 单次链路
- `scripts/patent-evolve.mjs baseline`：statement → Target 角色（subagent）→ 输出 → LLM judge per rubric → 落 scoreboard。
- **隔离**：首期把 `statement` 以 directive 文本注入 Target 角色上下文，**不把 rubric 路径/内容放进 Target 上下文**；Evaluator 侧（父进程）持有 rubric 并评分。Target 无任何访问 rubric 的路径。
- 校验：记录并核对实际 `provider/model_id/thinking_level` 与 `benchmark_config.eval_runtime` 一致，不一致则作废（对齐 penguin）。
- e2e 用例跑通 + 人为抽查分数合理性。

### M3 — 版本化
- snapshot 打包/回滚。
- `batch`（runs 重复）+ `diff`（诊断失分类，输出「可证伪假设」素材）。

### M4 — 半自动优化（略过 LLM 自主改 prompt）
- 先由 `diff` 输出诊断，人工改角色 SKILL.md 后打新版本 → `batch` → 用严格接受规则校验，脚本报告「接受/需回滚」。
- **首期刻意不做**「让 LLM 自主改 prompt 的 Optimizer 角色」：那需要较重的防污染/校验，且改 prompt 风险高。等 M1-M3 跑稳、分数可信后，再按 penguin `agent-optimization` 的技能协议补「Optimizer 角色 + 有界 Candidate + 防污染中止」。

---

## 6. 测试策略

- `src/patent/evaluate/rubric.spec.ts`：rubric 边界（缺文件 / 非法 YAML / weight 相加非 1 / `behavior` 非 observable 项被拒）。
- `src/patent/evaluate/scoreboard.spec.ts`：追加不覆盖、写后 parse 自校验、分数 pin 到 session_id。
- `tests/patent/evolve/pack-snapshot.spec.ts`：快照排除 `.vault.toml` / 凭据 env；版本号只增不减；同版本不覆盖。
- `tests/patent/evolve/accept-rule.spec.ts`：**严格接受规则** —— 注入 mock Evaluator 分数，验证「分数严格更高才接受、否则恢复 Reference、相等视为拒绝」。
- 复用既有 `pnpm check:patent-sop` / 事件矩阵门禁不受影响（本方案不触碰 `AgentEvent`/gateway frames）。
- LLM judge 打分走重放 seam（`src/test-support/llm-replay/`），无 key 跑通，避免把 API key 录进产物。

---

## 7. 风险

| 风险 | 缓解 |
|---|---|
| LLM judge 打分不稳/有偏差 | 复用 `consensus` 多 judge + Verdict Envelope；每 case 约束用**可观察断言**（不允许"分析充分"类措辞），rubric 校验器拒绝不可观察项 |
| Target 角色有机会读到 rubric | 首期隔离靠「rubric 不进 Target 上下文」；校验 Target 的 observable 上下文无 rubric 关键词；二期强化为隔离工作区（只复制 statement） |
| 迭代"改进 prompt"可能只是把分数刷高而非真变好 | 严格接受 + 快照回滚保证可逆；`diff` 要求给出可证伪假设；分数变化需关联具体 case 行为而非总分 |
| 改动影响范围 | 全部为新增资产 + 一个脚本，不碰核心循环/事件面；`pnpm check` 门禁保持 green |

---

## 8. Alternatives considered

- **方案 A：直接给现有 `patent-eval.mjs` 加"打分"** —— 落选：它已有 `expected` 文本相似度打分，但那不是"可观察行为"评分；在它上面叠 rubric 会混两套评分口径。另起 `patent-evolve.mjs` 让 rubric 评分成为独立、可替换的面。
- **方案 B：首期就让 LLM 自主改 prompt（仿 penguin Optimizer）** —— 落选：penguin 的 Optimizer 依赖一套严格的防污染/校验协议（Evaluator 纯协议 YAML、runtime 一致校验、污染即中止），直接搬会使 M1 过重且调试难。先做确定性脚本闭环（可测、可回滚），优化决策再交给 LLM。
- **方案 C：用 `workflow manifest` 作为被进化对象** —— 落选：manifest 是流程编排，模型自改语义风险高、收益难测；角色 SKILL.md 更贴近 penguin 的 `Agent State`，且与 `run_subagent` 天然对应。
- **方案 D：把评分完全交给 `expected` 文本指标（最省事）** —— 落选：正是 penguin 明令避免的"文本相似度高保底"，无法衡量行为达标，会误导优化方向。
- **方案 E：隔离工作区一步到位** —— 落选：Sati 的 subagent 继承父 workspace，首期引入"运行时隔离工作区"成本高、收益低（ribric 本就只在父侧）；先用上下文级隔离跑通，二期再上工作区隔离。
