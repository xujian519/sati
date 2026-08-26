# Agent Note: 自进化闭环（评测数据面 + 单次评测链路 + 多 run/diff + 严格接受）

Status: implemented

## Problem

Sati 只有**单次评测**的引擎（`src/patent/evaluate/` 的 Evaluator/CaseRunner/consensus、`tests/patent/benchmark/fixtures/*`、`scripts/patent-eval.mjs`），用 `expected` 参考答案文本 + keyword_recall/jaccard 做**文本相似度**打分——这正是 PenguinHarness 明令要避免的"高保底分/文本相似度≠行为达标"。缺跨版本迭代协议：没有 rubric（按可观察行为分项）、没有基准冻结、没有版本快照/回滚、没有 statement/rubric 隔离、没有严格接受规则。

## Decision

- 新增 benchmark 目录协议（`benchmark_config.yaml` + 每 case `statement.md`（公开）+ `rubric.yaml`（私有，对 Target 完全隔离）+ `scoreboard.yaml` 追加式），被进化对象首期选 `type: role` 角色 SKILL.md（可被 `agent` 工具按 `subagent_type` 调度，与 `run_subagent`/Agent State 一一对应）。
- **隔离**：`runBaseline` 把 `generate` 注入（只拿 statement）与 `judge` 注入（拿 output + rubric）分开，rubric 永不流入生成侧上下文；评分项强制 `behavior: observable`（拒"分析充分"等不可观察项），weight 和恒 1，未解析项保守取 false（避免高保底分）。
- M1 数据面：`rubric.ts`（解析+容错归一）、`scoreboard.ts`（追加式+写后自校验+shape 校验 fail-closed）、`benchmark.ts`（目录/配置/防路径注入）、`snapshot.ts`（角色版本快照，**排除 `.vault.toml`/`.env`/密钥文件**，版本不覆盖）+ `scripts/benchmark-pack-snapshot.mjs` + 样例 `tests/patent/benchmark/self-evolve/`。
- M2 单次评测链路：`evolve.ts` 的 `runBaseline`（遍历 case→statement→生成→judge per rubric→聚合 ScoreboardRecord→append scoreboard）+ `scripts/patent-evolve.mjs`（默认 `deepseek/deepseek-v4-flash`，版本号=scoreboard 最大版本+1）。
- M3：`runBaseline(runs>1)`（每 case 多 run 取均值）+ `diffScoreboards`（逐 case 对比，标出失分/提升，单边缺失记 null）。
- M4：`shouldAcceptCandidate`（严格更高才接受，相等拒绝）+ `evaluateCandidate`（接受/回滚理由）。
- **模型层 workaround**：DeepSeek 官方文档确认 v4 系列 `thinking` 默认 `enabled`、`reasoning_content` 是 final 之前的思考、`content` 才是最终答案且与思考共享 token——长分析任务下思考把 `content` 榨干为 0。`openai/request.ts` 在 default 思考模式并未显式传 `thinking:{type:"disabled"}` 给 DeepSeek，导致其默认开启思考。评测链路在 `patent-evolve.mjs` 的模型调用显式 `thinking:{mode:"off",enabled:false}`（走 `deepSeekPlan` off 分支→`{type:"disabled"}`）修复，仅作用评测链路，不动全局模型层默认行为。

## Alternatives considered

- **直接在 `patent-eval.mjs` 上叠评分** — 混两套评分口径（文本相似度 vs 可观察行为），弃；另起 `patent-evolve.mjs` 让 rubric 评分成独立面。
- **首期就让 LLM 自主改 prompt（完整 Optimizer 角色）** — 依赖严格防污染/校验协议，M1 过重且难调试；先做确定性脚本闭环，优化决策交给 LLM，弃。
- **用 patent workflow manifest 作为被进化对象** — 流程编排，模型自改语义风险高；角色 SKILL.md 更贴近 Agent State 且与 `run_subagent` 天然对应，弃。
- **评分完全交给 `expected` 文本指标（最省事）** — 正是 penguin 明令避免的高保底文本相似度，无法衡量行为达标，弃。
- **隔离工作区一步到位** — Sati 的 subagent 继承父 workspace，首期引入运行时隔离工作区成本高；先用上下文级隔离（rubric 只在父侧），二期再上工作区隔离，弃。
- **把 thinking:off 下沉到模型层（`openai/request.ts` 对 default 的 deepseek-v4 显式传 disabled）** — 全局影响所有 deepseek-v4 调用、面大，需单独评估；本轮仅评测链路 workaround，模型层改动另行评审。

## Consequences

换来：可测量→诊断→版本快照→严格接受/回滚的完整闭环基座；rubric 打分衡量行为达标而非措辞；statement/rubric 隔离保证评分可信度；密钥永不进快照。付出：新增 4 个 evaluate 子模块 + 2 个 CLI + 样例 + 单测；DeepSeek v4 长分析任务需显式关思考（评测链路已处理）；真实评测依赖可用 LLM key；打分的稳定性与 rubric 拆分合理性仍需在有 key 环境进一步用真实分值评估（本轮已用 flash 跑通样例：正文 5212 字、judge 70 分）。
