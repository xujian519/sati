# Agent Note: 专利域断线审阅修复——分发资产、反馈回流写侧、modelHints 装配

Status: implemented

## Problem

专利域整体审阅（四链路静态审阅 + 全量测试验证）发现四处"闭环缺半边/特定形态失效"：

1. `rules/` 宪法规则资产不进 desktop bundle（`release.sh` PDM_ITEMS 无该项），解包形态下 `candidateRuleDirs()` 三个候选全落空 → 规则驱动 block/review 门禁静默退化为仅 4 个默认审批词的关键词门禁。
2. 创造性 HITL 反馈回流（P2-4）读侧已接（`patent_workflow_run` graph=inventiveness 重跑注入 conclude 提示）、写侧无生产调用——`docs/patent-inventiveness-optimization-plan.md` 明确记载卡点："gateway 审批上下文无 caseId，生产接线待宿主侧落地"。
3. `judgeModels` 多模型共识在图模式代码闭合，但全仓无任何调用点向 `createPatentWorkflowRunTool` 注入 `modelHints` → 多 judge 落同一会话模型，共识退化为同模型采样。
4. 若干防御缺口：checkpoint 恢复不校验 manifestId、law-search legacy 库损坏抛非语义化错误、`export_html` 的 dist 候选路径永不存在。

## Decision

- **rules/ 随包分发**：`apps/desktop/scripts/release.sh` PDM_ITEMS 加入 `rules/`（打包在 bundle 根，`asset-location` 的 `<packageRoot>/rules/patent` 候选在解包形态命中）。仓库内 dev/server 形态本就命中仓库根候选，行为不变。
- **反馈回流写侧桥接（session→case 绑定）**：`patent_workflow_run` graph=inventiveness 且带 caseId 时，运行落盘 `<caseDir>/workflow-runs/session-binding.json`（sessionId→case，last-write-wins，写失败 fail-open）；`createLocalGateway` 的 `PatentOutputGate.onDecisionFeedback`（既定宿主接线点）在 modified/rejected 时按 sessionId 反查 caseId，把反馈追加进 `<caseDir>/inventiveness-feedback.jsonl`。
- **modelHints 装配**：pilot config `patents.modelHints`（hint 名 → provider/model，`parsePatentsConfig` 校验）经 `createBuiltinRegistry({ patentModelHints })` 注入 `patent_workflow_run` 与 `flexible_plan` 的 `WorkflowProviderDeps`；缺省不传，行为与此前完全一致。
- **防御补齐**：`runWorkflow` 恢复检查点前校验 manifestId 一致（fail-loud）；law-search legacy `LegalSearchEngine` 构造包 try-catch 降级 null（与 knowledge.db 分支对称，走既有 setup_required 语义）；build 拷贝 `scripts/export-html.mjs` 到 `dist/scripts/` 使工具的 dist 候选可达；孤儿/预留 API（`verifyVerdictEnvelope`、`src/patent/reasoning/`、compare 原子）显式注释定位，消除"已生效"误读；删除 clarity 层零消费的 `signalFor`（与 `workflow/signal.ts` 同名混淆源）。

## Alternatives considered

- **反馈写侧：审批卡片带 caseId 入参** — 需改 `patent_workflow_run` inputSchema（加反馈参数），请求键 toolSchemaDigest 变化使 llm-replay 真实 fixture 失配且无 key 重录；且把 HITL 反馈强绑到工具调用形态，聊天侧驳回（现状主流路径）反而覆盖不到。落选。
- **反馈写侧：全局 session 注册表（~/.sati/ 级）** — 宿主反查不再依赖 cwd，但引入跨项目状态文件与清理责任，价值不抵复杂度。落选，绑定文件随 case 目录生灭（`cleanupOrphanToolResults` 同款生命周期语义可复用）。
- **modelHints：SATI_PATENT_MODEL_HINTS 环境变量** — 与项目"env 管开关、YAML 管模型配置"的分工不符，且 JSON-in-env 易错。落选，归 `patents.*` 既有段。
- **modelHints：pilot config 顶层新段** — 破坏 config schema 稳定性，收益仅命名更短。落选。
- **reasoning/ 孤儿模块直接删除** — 移植自 Mady 的结构化推理原语与 claim-chart/draft 链路有明确规划中的接线目标（graph/README 已声明宿主 API），删除损毁后续工作。落选，显式标注预留。

## Consequences

- desktop 形态规则门禁恢复 block/review 能力；打包体积增加 rules/ 资产（纯 YAML，~数百 KB）。
- 反馈回流端到端闭环成立：驳回 → 落盘 → 同 case 重跑 conclude 提示可见。约束：反馈归属 case 以"该 session 最近一次 graph=inventiveness 运行"为准（同 session 换 case 的近似），审批发生在绑定之前的旧 run 上时反查落空（fail-open）。
- 多 judge 共识需用户在 `sati.yaml` 显式配置 `patents.modelHints` 后生效；未配置时行为与改动前一致。
- 工具 inputSchema 零变化（llm-replay fixture 不受影响）；`patent` 域行为变化均有测试锚定（workflow-resume / feedback / patentWorkflowRun / parsePatentsConfig 四 spec 扩展）。
