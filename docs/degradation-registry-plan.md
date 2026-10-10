# 计划：fail-open / fail-closed 分级语义立规 + 负向演练

> 状态：**v2**（已按独立评审退回清单修订，2026-10-10）；D1–D3 决策已定（见 T0）；待开工
> 基线：全仓静态盘点快照 → `docs/degradation-baseline-inventory.md`（2026-10-10，HEAD）
> 缘起：对比研究外部项目 TianGong（`ai-tools-mtl/TianGong` 仓库，fail-open/fail-closed 分级语义成文立规 + doctor 负向演练）后，筛选出适合引入 Sati 的设计。

## 修订记录

**v2（2026-10-10，依据 oracle 评审 FAIL: 退回修订）**

1. **T0-D2 事实倒置修正**：spill 落盘失败的真实语义是 **fail-open 回退 + 无人消费的诊断**（`ToolResultBudget.ts:199-205` 上抛 → `DefaultContextRuntime.ts:429-453` 捕获并回退原始投影、:444-450 产诊断 `tool_result_persistence_failed` 全仓零消费 → `AgentLoop.ts:859-874` 二重兜底「保证工具结果不丢」），**非**隐式 fail-closed；用户已拍板**维持现状语义**，任务改为「登记 open + 补可观测性」。
2. **T3b 修复点下沉**至 `TokenStatsCollector.writePayload`（`:254-266`，回调忽略 err 参数，异步失败全部 resolve）——仅在 `:249` 加 warn 不可达；并纳入 `drainSync:280` 与同文件同类注释型 catch 处置。
3. **T3a 范围纳入宿主侧** `ProjectRuntimeRegistry.ts:507-519`（逐会话失败无日志，:518 另有静默 catch）。
4. **DoD 静默审计空转修正**：原 `grep catch {}` 命令在主干实测零命中（三类静默点均不可匹配）→ 改为脚本化审计（`scripts/audit-silent-catches.mjs`，T1 交付）。
5. **T4 订正**：worker-gate 已有测试锁（任务删除，registry 改指向既有 spec）；ProviderHealthTracker 拆 tracker/router 两条 spec；checkpoint spec 目标订正为行为实体（`AgentLoop.ts:754-757` / `TurnRunner.ts:358-360`）。
6. **补入 4 项既有门禁维护步骤**：`pnpm gen:doc-claims`（lint/CI 计数回填）、`pnpm measure:update`、`test:pr-tooling` 显式清单手动追加、自测文件命名 `.test.mjs`（避开 `.gitignore` 的 `*.test.ts` 陷阱）。
7. **T2 验收改为与基线 artifact 一一对账**，删除内部不自洽的分布数字（原 15+10+2≈27≠37）。
8. **T7 升级为规范之家三件套**（义务条款 + 门禁表 + 命令速查），不再只是「加一行链接」。

## 一、目标与非目标

**目标**

1. 每个外部/软依赖的 fail 方向（open / closed / mixed）成文立规，含「降级行为 + 谁漏了什么 + 可观测性 + 负向演练测试」五要素；
2. 消灭静默吞错（当前 3 处 + 同族同类 catch 的逐项处置）；
3. 新增依赖未登记即 CI 可感知（漂移门禁）；
4. 全部接入 Sati 既有「声明式资产 + 生成物/check + lint 挂接」文化。

**非目标**：不改任何降级行为的运行时语义（T0 均已拍板为维持现状）；不引入 TianGong 的 GOTCHAS 文档模式（纯文档会腐烂，见 Alternatives considered）。

## 二、立规设计（载体与格式）

**载体**：

- `assets/degradation/registry.yaml`（声明式资产，单一事实源）
- `assets/degradation/degradation.schema.json`（文档/编辑器用途；**硬校验以脚本手写为准**——仓库无 JSON Schema 校验器，先例 `rule-pack.ts:92-95` 为手写校验 + 注释声明同步）
- `scripts/check-degradation-registry.mjs`（五要素校验 + 路径存在 + drill 存在或豁免 + observability 非空或豁免；`--stats` 输出计数与分布；`--check` 挂 `pnpm lint`，范式参考 `sync-labels.mjs --check`）
- `scripts/audit-silent-catches.mjs`（静默审计：枚举 `catch {` / `.catch(` 体内无日志、无 rethrow/return、无诊断、无豁免注释的站点，输出可对账清单）

**条目格式**（五要素 + 双类豁免，样例）：

```yaml
- id: knowledge-db-missing
  component: src/knowledge/assemble.ts        # 代码位置（脚本硬校验存在）
  dependency: knowledge.db（运行期外部文件）
  failDirection: open                          # open | closed | mixed
  degradedBehavior: 该源不建 resolver，逐源 try/catch 互不影响
  degradedImpact: 缺哪个源漏哪个源的召回（warn 日志可见）
  observability: warn log                      # 不得为空——铁律 11 的机器化
  negativeDrill: tests/knowledge/kg-store-knowledge-db.spec.ts
  # waiver:                                    # 可选；两类豁免语义分离
  #   kind: drill_missing | intentional_silence
  #   reason: <必填>
```

**负向演练的判定标准**（一个测试算「负向演练」须同时满足）：

- mock/断开该依赖的失败路径；
- 断言**降级产物**（不是只断言没崩）；
- 断言**可观测痕迹**（日志 / diagnostics / 事件 / 错误码之一）。

**漂移门禁分两档**：

- 硬门禁 = registry 内部一致性（schema 五要素、component/drill 路径存在、豁免理由必填）；
- 软门禁 = `scripts/gen-degradation-candidates.mjs` 扫描 `networkFetch`、`spawn`、`new WebSocket`、`mcp` import 等模式，与 registry diff 产出「疑似未登记依赖」报告——独立 CI job + `continue-on-error: true`，**不进 required checks**；连续 4 次 CI 运行（约 2 周）候选报告为空后转 `--check` 硬门禁（转换时刻记录于 PR 描述）。

## 三、任务清单

### 阶段 0：归类决策（T0，已定稿）

| # | 决策点 | 现状（v2 事实修正后） | 决策 |
|---|---|---|---|
| D1 | 派生库 schema 版本低于程序 | 放行重建（fail-open）；重建期该源不可用**已有 warn**（`assemble.ts:78`） | 维持 open，**仅登记不改码** |
| D2 | spill 落盘失败 | **fail-open 回退**：异常被 `DefaultContextRuntime.ts:429-453` 捕获 → 回退原始投影 + 产诊断 `tool_result_persistence_failed`（:444-450，全仓零消费）→ `AgentLoop.ts:859-874` 二重兜底（原文不丢、turn 不失败）。实质静默点 = 诊断无人消费 | **维持现状语义（用户已拍板）**：登记 open + 补可观测（消费诊断或落 warn）+ spec |
| D3 | router 吐出内容后遇错 | 不再 fallback，截断（fail-closed，`executeRouterDecision.ts:58`） | 维持 closed，立规 **mixed**：吐内容前 open、吐内容后 closed |

**产出**：三条决策写入 registry 条目 + `docs/notes/implemented/` 决策记录（含 Alternatives considered，铁律 7）。

### 阶段 1：立规载体（T1，1.5–2 天）

- 建 `assets/degradation/`（registry.yaml 骨架 + schema）；
- 写 `scripts/check-degradation-registry.mjs`（五要素 + 路径硬校验 + `--stats`）与 `scripts/audit-silent-catches.mjs`（静默审计，替换原空转 grep）；
- 挂 `package.json` lint 链；脚本自测（check 好坏 fixture + 审计正负样例）——`test:pr-tooling` 是**显式文件清单需手动追加**，自测文件命名 `.test.mjs`（避开 `.gitignore:211-214` 的 `*.test.ts` 陷阱）；
- **门禁维护**：lint 链变更后跑 `pnpm gen:doc-claims`（`lint_gate_count` 12→13）；新增文件后跑 `pnpm measure:update`。

### 阶段 2：存量登记（T2，1–2 天）

- 按 `docs/degradation-baseline-inventory.md` 逐项对账录入（40 个已盘点行为单元 + 6 项待深挖占位，见 T5）；`mixed` 类按子语义拆两条（router 执行层、patent_metadata、patent_search、team 转派、schema 版本）；
- 3 处静默点标 `waiver.kind: intentional_silence` 并注明「T3 修复后解除豁免」；
- 验收以基线 artifact 对账表为准（对账结果存 PR 描述），**不设分布目标值**（分布由 `--stats` 输出为准）。

### 阶段 3：静默点修复（T3，1.5 天）

- **T3a** `TaskResumeScanner.ts:98-100`：catch 补日志/注入 logger；结果对象补 `failed` 字段（类注释 59-60 声称「失败仅计数」与实现不符）；**宿主侧** `ProjectRuntimeRegistry.ts:507-519`：无条件记 summary + 移除 `:518` 静默 catch；补 spec（断言日志 sink）；
- **T3b** `TokenStatsCollector`：`writePayload`（`:254-266`）错误传播改为 `(err) => err ? reject(err) : resolve()`；`:249` catch 补 warn；`drainSync:280`（同步失败丢缓冲）处置（补日志或登记豁免）；同文件 ≥9 处同类注释型 catch 逐项「补日志或登记豁免」；spec 用真实写失败（fd 关闭 / 只读目录）；
- **T3c** `EdgeClawMemoryProvider.ts:167-169` inner 空 catch：不改码，登记豁免（设计注释：丢弃陈旧结果），理由引用注释原文。

### 阶段 4：测试缺口补齐（T4，1.5 天）

- **ProviderHealthTracker 拆两条 spec**：① 单元 spec——状态机迁移（`openDurationMs: 0` 构造 half_open，类无时钟注入）；② router 侧 spec——「open 跳过候选」实为 router 行为（`executeRouterDecision.ts:350-356`），现零覆盖；
- **worker-gate**：已有测试锁（`tests/patent/team-worker-gate.spec.ts:28-45` + `scheduler.spec.ts:672-684`）→ 不做新测试，registry 条目 `negativeDrill` 指向既有 spec；
- webFetch 独立 spec（结构化错误 + `EGRESS_BLOCKED` 路径）；
- agent 输入落盘 spec：断言行为实体 `AgentLoop.ts:754-757`（抛出即中止本步）/ `TurnRunner.ts:358-360`；`input.ts:47` 仅作 registry component 引用。

### 阶段 5：深挖补登记（T5，2–3 天，可并行）

基线 artifact「待深挖清单」6 项逐项深挖后「补登记 or 书面豁免」：

1. egoBrowser 工具失败行为（完全未盘点）；
2. gateway 服务端 WebSocket 断连/重连语义（此前只盘了 ui/server 桥侧）；
3. edgeclaw-memory-core vendored 内部故障矩阵（LLM extraction / dream / heartbeat 各路径）；
4. SessionTitleGenerator / searchChatHistory 的 catch 行为；
5. `ui/server/websocket/chat.js` 重连策略；
6. scripts/ 其余 fetch 类脚本的失败处理。

### 阶段 6：漂移门禁（T6，1–2 天）

- `gen-degradation-candidates.mjs`：模式扫描产出候选清单，与 registry diff；
- CI：独立 informational job（`continue-on-error: true`，不进 required checks），产出报告 artifact；
- runbook：`docs/degradation-runbook.md`——候选确认流程、误报处理、退出判据（连续 4 次 CI 运行零报告）、**与 `metrics.md:34`「无注释无参 catch」指标的口径分工**（该指标为噪声口径且现恒为 0；新审计为「有实质后果的静默站点台账」口径，防止两套静默口径长期分叉）；
- **门禁维护**：CI job 增加后跑 `pnpm gen:doc-claims`（`ci_job_count` 3→4）。

### 阶段 7：文档衔接（T7，1 天）

- `docs/development-standards.md`（规范之家三件套，按仓库元规则 §5.1）：
  - §6 新增义务条款：「新增外部依赖必须登记 registry（含『谁漏了什么』必填）」；
  - §3 门禁表加 `check:degradation` 行；
  - 附录 A 命令速查加对应条目；
- AGENTS.md 铁律 11 末尾加链接（义务主文在 §6，避免双重事实源）；
- CONTRIBUTING.md「代码规范/测试」节（现文 :130/:174 引用附录 A）加落点；
- `docs/notes/implemented/` 决策记录落库（docs/notes/README.md:7-23 纪律），含 D1–D3 + Alternatives considered；
- **门禁维护**：`pnpm measure:update` + `pnpm gen:doc-claims`。

## 四、可验证的检查清单

### 每任务验收

**T0**
- [ ] D2 条目按 v2 事实登记（引 `AgentLoop.ts:859-874` / `DefaultContextRuntime.ts:444-450`，注明诊断无消费者）
- [ ] D1/D3 条目登记（D1 注明 warn 已存在、仅登记不改码）
- [ ] `docs/notes/implemented/` 决策记录含 Alternatives considered

**T1**
- [ ] `pnpm check:degradation` 对格式错误 fixture **exit 1** 且报错定位到条目 id；对合法 fixture **exit 0**
- [ ] `--stats` 输出计数与分布（供 T2 对账）
- [ ] `audit-silent-catches.mjs` 对三个已知静默点**正样例命中**；对已修复/已豁免站点**不输出**（负样例）
- [ ] `pnpm lint 2>&1 | grep degradation` 有输出；`pnpm test:pr-tooling` green 且清单已手动追加自测文件
- [ ] `pnpm gen:doc-claims` 已跑（`lint_gate_count` 回填为 13）；`pnpm check:doc-claims` green

**T2**
- [ ] registry 条目与 `docs/degradation-baseline-inventory.md` 逐项对账（对账表存 PR 描述），零 unclassified、零悬空
- [ ] 每条 `component` 路径存在（脚本硬校验）；每条 `negativeDrill` 存在或 `waiver.reason` 必填齐全
- [ ] 3 处静默点 `waiver.kind: intentional_silence` 标注 + 「T3 修复后解除」

**T3**
- [ ] `TaskResumeScanner` catch 体内有日志调用；`ProjectRuntimeRegistry` 宿主侧接线：模拟单会话续算失败出现 warn/计数（spec 断言日志 sink）；:518 静默 catch 移除
- [ ] `writePayload` 错误传播（err→reject）；`:249` warn 可达；`drainSync:280` 与同文件同类 catch 逐项处置（补日志或豁免登记）
- [ ] 真实写失败（fd 关闭/只读目录）驱动的新 spec green；registry 临时豁免解除
- [ ] `pnpm test` 相关 spec green

**T4**
- [ ] tracker 单元 spec（`openDurationMs: 0` 构造 half_open + 状态迁移断言）+ router 侧 spec（open 跳过候选）存在且 green
- [ ] webFetch spec 存在（或豁免理由入库）
- [ ] onFlushCheckpoint spec 打在 `AgentLoop.ts:754-757` / `TurnRunner.ts:358-360` 行为上
- [ ] worker-gate 已从本任务删除（registry 指向 `tests/patent/team-worker-gate.spec.ts`）
- [ ] `pnpm test` 全绿

**T5**
- [ ] 待深挖 6 项逐一：补登记条目或书面豁免（文件级证据）
- [ ] 新增条目与深挖报告一致（对账表）

**T6**
- [ ] 候选扫描在当前 HEAD 输出与 registry diff 仅含已知未登记/豁免项
- [ ] CI informational job（continue-on-error、非 required）产出报告 artifact
- [ ] runbook 存在：误报处理 + 退出判据 + 与 metrics.md 口径分工
- [ ] `pnpm gen:doc-claims` 已跑（`ci_job_count` 回填为 4）；`pnpm check:doc-claims` green

**T7**
- [ ] `development-standards.md` 三处更新齐全（§6 义务条款 / §3 门禁表 / 附录 A）
- [ ] AGENTS.md 铁律 11 链接、CONTRIBUTING 落点、`docs/notes/implemented/` 决策记录
- [ ] `pnpm measure:update` 已跑 + `pnpm check:techdebt-metrics` green
- [ ] `pnpm check` 聚合 green

### 总体完成定义（DoD）

- [ ] `pnpm check:degradation` exit 0
- [ ] `pnpm test` 全绿（含本期新增 spec）
- [ ] `pnpm check` 聚合门禁 green（含 `check:techdebt-metrics`、`check:doc-claims`）
- [ ] `node scripts/audit-silent-catches.mjs` 输出清单逐项对应 registry（已修复 / 已豁免 / 已登记三态互斥且完备）——**不使用原空转 grep**
- [ ] registry 与基线 artifact 全量对账，零悬空
- [ ] `docs/notes/implemented/` 决策记录入库（铁律 7）
- [ ] 修订确认抽查点：B1（D2 事实与登记一致）、B2（`writePayload` 修复）两处经抽查通过即可，无需整体重审

## 五、风险与开放项

1. **D2 已拍板维持现状**（fail-open 回退 + 补可观测性）；真 fail-closed 为已评估被否的备选（见 Alternatives #5），如未来重启须按行为变更单列评估：大结果场景 turn 失败，涉续算/重试语义与用户体验。
2. **T6 误报**：模式扫描必然误报（如 `catch {}` 合法模式），先 informational；退出判据已量化为「连续 4 次 CI 运行零报告」，量测主体 = CI artifact 留存。
3. **T5 体量不可控**：edgeclaw-memory-core 内部矩阵可能再挖出多项，各子项独立小 PR，不阻塞 T1–T4 主线与 DoD。
4. **基线 artifact 为静态快照**：可能与 HEAD 漂移；T2 对账时以脚本硬校验（component 路径存在）兜底，路径失效即报错而非静默。

## Alternatives considered

1. **纯 Markdown 表格（TianGong GOTCHAS 模式）** —— 成本最低，但无机器核查、必然腐烂；Sati 已有「声明式资产 + check」成熟范式，弃。
2. **只在代码注释立规** —— worker-gate 现状即反例（已有 spec 锁是正例，但对无锁的可观测性无强制）；弃。
3. **一步到位把漂移扫描做硬门禁** —— 误报未量化前硬门禁制造红灯疲劳；选 informational 起步 + 量化退出判据。
4. **每条强制 negativeDrill** —— 存量中设计注释豁免项（edgeclaw inner catch）合理存在；选豁免机制 + 理由必填。
5. **D2 真 fail-closed（spill 落盘失败 → turn 失败）** —— 评估被否：现行为（回退原始投影 + 诊断）已保证「原文不丢 + turn 稳定」；改报错把大结果场景变为失败路径，牵动续算/重试语义与用户体验。维持现状 + 补可观测性。

---

**总工作量预估**：约 7–11 个工作日（T0 完成 + 主线 T1–T4 约 5–7 天 + T5 2–3 天 + T6–T7 约 2 天），主线与 T5 可并行。
