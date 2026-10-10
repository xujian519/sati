# Agent Note: 降级 registry——fail 方向立规、静默修复与漂移扫描

Status: implemented

## Problem

外部/软依赖（网络、外部二进制、WS、MCP、外部文件、模型端点）的失败行为散落在代码与注释里：失败方向（fail-open 继续降级 / fail-closed 报错）没有成文清单，没有机器核查；静默吞错只能靠人肉排查，且 `grep 'catch {}'` 这类手段实测是空转（三类真实静默形态都匹配不到）；新增依赖没有任何 CI 感知路径。参考 TianGong 项目的 fail-open/fail-closed 分级语义与 doctor 负向演练后，把适合 Sati 的部分落成仓库既有的「声明式资产 + check + lint 挂接」范式。

## Decision

**载体与硬门禁**：`assets/degradation/registry.yaml` 为唯一事实源，每条 = 一个依赖行为单元（五要素 + observability + negativeDrill）。`scripts/check-degradation-registry.mjs` 挂 `pnpm lint`：路径存在**且被 git 跟踪**、枚举合法、豁免理由必填、**冗余豁免即红**。豁免两类语义分离：`drill_missing`（暂无负向演练）与 `intentional_silence`（有意无痕）。

**三条归类决策（T0，用户拍板）**：

- D1 派生库 schema 版本低于程序：维持 fail-open 重建（重建期该源不可用已有 warn），仅登记不改码；
- D2 spill 落盘失败：维持现状语义——fail-open 回退（原文不丢、turn 不失败）+ 诊断 `tool_result_persistence_failed` 补 warn 可观测，**不**改真 fail-closed；
- D3 router 吐内容后遇错：立规 mixed——吐内容前 open、吐内容后 closed（截断而非 fallback）。

**静默修复（T3）**：3 处已知静默点修复——TaskResumeScanner catch 补日志 + `failed` 字段；TokenStatsCollector `writePayload` 错误传播（err→reject）+ 同文件其余注释型 catch 逐项处置（补日志或降级 debug）；DefaultContextRuntime spill catch 补 warn。临时静默豁免同步解除。T5 深挖又发现 3 处新静默点（gateway 断连 abort 吞错 / edgeclaw 生产未注入 logger / searchChatHistory 目录不可读），已登记豁免，候选后续专项修复。

**负向演练（T4/T5）**：ProviderHealthTracker 单元 + router 侧 spec、webFetch spec、checkpoint fail-closed spec；深挖补登记后 registry 共 61 条（open 37 / closed 21 / mixed 3），带豁免 14 条。

**漂移扫描（T6）**：`scripts/gen-degradation-candidates.mjs` 模式扫描外部触点（networkFetch / child_process / WebSocket / MCP SDK），与 registry + `assets/degradation/candidates-baseline.yaml`（已确认项：`known-unregistered` / `waived`）做差；CI 独立 informational job（`continue-on-error`、不进 required）产出报告 artifact。首次对扫描差集 72 项 100% 分类（28 waived / 44 known-unregistered 队列）。退出判据 = 连续 4 次 CI 零新增（约 2 周）后转 `--check` 硬门禁（转换时刻记录于 PR）。静默审计工具维持不设棘轮（决策理由见 runbook §4）。

**规范之家（T7）**：义务条款落 `docs/development-standards.md` §6（新增依赖必须登记）+ 门禁表 + 附录 A；AGENTS.md 铁律 11 链接；运行手册 `docs/degradation-runbook.md`。

## Alternatives considered

- **纯 Markdown 表格（TianGong GOTCHAS 模式）** —— 成本最低，但无机器核查、必然腐烂；选「声明式资产 + check」。
- **只在代码注释立规** —— 无强制、无核查（worker-gate 注释 vs 测试锁是正反对照）；弃。
- **一步到位把漂移扫描做硬门禁** —— 误报未量化前红灯疲劳；选 informational 起步 + 量化退出判据（连续 4 次零新增）。
- **每条强制 negativeDrill** —— 存量存在合理的设计性豁免（如 edgeclaw inner catch 丢弃陈旧结果带注释）；选豁免机制 + 理由必填 + 冗余豁免即红。
- **D2 真 fail-closed（spill 落盘失败 → turn 失败）** —— 评估被否：现行为已保证「原文不丢 + turn 稳定」，改报错把大结果场景变为失败路径，牵动续算/重试语义与用户体验；维持现状 + 补可观测。
- **候选扫描记目录 / glob 级豁免** —— 会静默整树（目录内新文件永不报）；选文件级精确基线 + 失效/冗余条目报红。
- **静默审计升级为棘轮门禁** —— 真实存量数百处，设棘轮会把「存量可见」变成「红灯疲劳」；维持 DoD/回收工具（口径分工见 runbook §4）。

## Consequences

- **换来**：降级行为成文 + lint 硬门禁（61 条，路径/豁免机器核查）；静默点有发现手段（分档审计）与修复先例；新增依赖漂移 CI 可感知（informational → 将转硬）；豁免有生命周期（冗余/失效即红）。
- **付出**：维护面新增 registry、候选基线两份 YAML + 三个脚本 + runbook；候选基线随代码演进维护（失效条目会红）；已知盲区：文件级扫描不报「已登记文件内部的新增触点」（runbook §5 明示）；44 项 known-unregistered 待后续批次补登记。
- 交叉引用：计划 `docs/degradation-registry-plan.md`、运行手册 `docs/degradation-runbook.md`、基线盘点 `docs/degradation-baseline-inventory.md`。
