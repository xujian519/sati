# 架构衰减修复执行计划（Brooks-Lint 审计产出）

- 计划日期：2026-08-20
- 来源：Brooks-Lint Architecture Audit（`/brooks-audit`，Health Score 42/100）+ 8 条发现 triage（7 accept / 1 defer）
- 执行深度：架构级 refactor——拆环、拆文件、收敛重复实现，**全部行为保持**；唯一"新增行为"是契约测试对既有行为的锁定
- 范围：`src/`（agent / session / tool / context / gateway / adapters / cli / pilot / patent / workflow / browser / shared / knowledge）
- 周期：约 7–8 周（并行卡片见 §六 依赖说明）
- 关联现状：当前分支 `refactor/code-refinement-c03-c04` 正在改 `src/session/transcript/TranscriptReplay.ts`——**P2a（session→agent 拆依赖）须等该分支合并后再动 session/transcript**，避免重构冲突

---

## 一、目标与成功标准

**目标**：消除审计发现的架构衰减——核心层运行时循环依赖归零、最热路径神函数拆解、重复实现收敛、被 defer 的工作流收敛评估在到期（2026-11-18）前完成。

**成功标准（可量化验收）**：
1. **模块级值依赖环归零**：§二 P2 完成后重跑依赖矩阵脚本（见 §五 工具），`agent/session/tool/context/gateway/adapters/cli/patent/pilot` 之间无任何**值导入（非 type-only）双向边**；仅允许 type-only 弱环（如有，逐一注释理由）
2. **`AgentLoop.run()` 拆解**：主循环方法 ≤200 行，错误恢复分支全部下沉到 `recovery/` 子模块（遵循 `docs/god-function-refactor-plan.md`）
3. **三大渠道有契约测试**：`tests/adapters/` 新增 ≥6 个 spec（WeCom/Weixin/Feishu 各 ≥2：消息接收→回复闭环 + 巨型方法纯函数层）
4. **重复实现收敛**：env 解析助手全仓 ≤1 处、退避/jitter 通用实现全仓 ≤1 处（各模块只留超参）；`pilot/paths` 工具函数移入 `shared/paths` 后，`src/` 内对 `pilot/paths.ts` 的直引为 0
5. **工作流评估产出**：`docs/workflow-convergence-eval.md` 在 2026-11-18 前完成（S2 defer 到期前），给出四引擎能力覆盖矩阵与收敛决策
6. **每卡门禁全绿**：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`，零新增 warning；UI 卡为 `pnpm --filter sati-ui test && pnpm --filter sati-ui typecheck`

---

## 二、修复项清单（按依赖顺序）

### P1（W3）shared 收敛——为拆环提供落点 · 约 4–5 天

**发现**：`pilot/paths.ts` 被 7+ 模块运行时导入且反向依赖 `session/worktree`（4 对路径工具环）；env 解析助手重复 4 处；退避/jitter 散布 12+ 文件。

**改动点**：
1. 新建 `src/shared/paths/`：迁入 `resolvePilotHome` / `resolveProjectStorageId` / `getPilotProjectChatDir` / `createProjectId`（来自 `pilot/paths.ts`）与 `findCanonicalProjectRoot`（来自 `session/worktree/findCanonicalProjectRoot.ts`），零依赖纯函数
2. `pilot/paths.ts` 改为 re-export 兼容层（标注 deprecated），全部调用方（always-on / cron / router / telemetry / session / gateway / adapters / ui/server 白名单路径）改引 `shared/paths`；兼容层在下一轮删除
3. 新建 `src/shared/env/`：统一 `readPositiveIntegerEnv`（createLocalGateway）/ `readOptionalPositiveEnvMs`（streamModel）/ `parsePositiveInt`（patentSearch）/ collector 的 env 读取为 `readIntEnv` / `readBoolEnv` / `readDurationEnvMs`
4. 新建 `src/shared/retry/`：统一指数退避 + jitter（`exponentialBackoff` / `withJitter`），替换 network / mcp / router / model / tool 各站点；**保留 `literature/runtime/http.ts` 的 per-host 礼貌限速器不动**（不同关注点，仅让它的延迟计算调用 shared 函数）

**验证**：grep 残余重复实现 = 0；`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`

**提交**：`refactor(shared): extract shared paths/env/retry utilities`（拆 3 个提交，一个关注点一个）

### P2（C1）打破核心三角环 + 传输层环 · 约 2 周

**发现**：`agent↔session`（28/11）、`agent↔tool`（25/12）为运行时环，`agent↔context` 为 type-only 环；`adapters↔gateway`（57/1）、`adapters↔cli`、`patent↔tool`（45/5）、`pilot↔session` 等 12 对循环边。

**目标状态**：`agent → {session, tool, context}` 单向；传输层、pilot 环解除。

**改动点（按依赖序）**：
- **P2a session→agent 反转**（等 c03-c04 分支合并后）：`session/transcript` 与 `session/storage` 对 `agent/session/createAgentSession`、`agent/runtime/AgentRuntimeDependencies` 的实例化引用改为构造注入——`gateway` / `cli` 组合根在装配时传入 `AgentSessionFactory` 接口；`session` 对 `agent/protocol/*` 仅保留 type-only 导入
- **P2b tool→agent 反转**：`tool/builtin/agent.js` 的团队工具（`agent/team/index` 8 处 + `agent/sub/builtinSubagentTypes`）改为注入 `TeamRuntime` / `SubagentRegistry` 接口，`ToolContext` 携带接口实例而非直接导入实现
- **P2c gateway→adapters 反转**：`gateway → adapters/web/httpRouter` 改为 `web` 定义 `HttpRouter` 接口、gateway 构造注入
- **P2d adapters→cli 反转**：`chatSearch` 核心抽为纯函数库（建议落 `src/session/search/chatSearchCore.ts`），`cli/commands/chatSearch` 与 `adapters/channel/cli` 共同消费核心，双方不再互导
- **P2e patent↔tool 环**：`receiptFromToolExecution`（证据回执协议）所有权归 `src/patent/evidence/protocol/`，tool 反向消费；`NodeShellCommandRunner` 属通用进程执行，迁 `src/shared/process/`
- **P2f pilot 环**：P1 已解（paths 移 shared）；`model↔pilot` type-only 环暂保留，注释理由，或把 `PilotConfigDiagnostic` 类型下沉 `model/config`

**验证**：重跑 §五 依赖矩阵脚本，断言无值导入环；`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`

**红线**：**不改任何工具 `inputSchema`**（LLM replay fixture 请求键含 `toolSchemaDigest`，改即全量失配）；gateway 协议版本零改动（`check:event-matrix` 门禁）

**提交**：`refactor(session): invert agent session dependency via factory injection` 等，每对拆环一个提交

### P3（W5）渠道契约测试——行为锁定 · 约 1 周

**发现**：`src/adapters/` 89 源文件 vs `tests/adapters/` 3 spec；WeCom（1760 行）/ Weixin（1459）/ Feishu（1332）无直接测试，`ChannelStartDeps` seam 未被利用。

**改动点**：
1. WeCom / Weixin / Feishu 各补 ≥2 契约测试：`node:http` 假服务器模拟回调 → 断言回复消息与加解密（微信/企微 AES）行为；先表征（characterization）后重构
2. `sendVideo`（681 行）/ `deliverCronResult`（665 行）内媒体组装与消息分发逻辑抽纯函数层，配套单测（为 P4 拆文件铺路）

**验证**：新增 spec 全绿；`tests/adapters/` 总数 ≥9；`pnpm test` 全量通过

**提交**：`test(adapters): add wecom/weixin/feishu contract tests`

### P4（W1 + C2）巨型文件与神函数拆解 · 约 2–3 周

**发现**：15 个后端文件 >780 行（`createLocalGateway.ts` 2394 居首）；`AgentLoop.run()` 约 1440 行（C2）；渠道类单文件 1300–1760 行。

**改动点**（按风险递增，每步独立提交）：
1. **`createLocalGateway.ts`（2394）**：按子系统拆 4 个 builder（gateway / agent / tool / always-on + approval-store），组合根只做编排与依赖装配
2. **`AgentLoop.run()`（C2）**：按 `docs/god-function-refactor-plan.md` 抽阶段骨架（输入校验 → 模型请求 → 工具执行 → 结果合并 → 收尾），每阶段 ≤60 行；错误恢复分支下沉 `loop/recovery/` 子模块；先补表征测试再动结构
3. **渠道类**：WeCom / Weixin / Feishu 按 `protocol/（发送）→ state/（登录态）→ handlers/（消息分发）→ render/（展示）` 切分（P3 契约测试先锁定行为）
4. **UI（可选延伸，不阻塞）**：`SkillsV2.tsx`（2502）/ `useSessionStore.ts`（1440）按 feature-folder 拆

**验证**：目标文件行数：`createLocalGateway ≤600`、`AgentLoop ≤800`、渠道类 ≤600；全量门禁绿；`docs/god-function-refactor-plan.md` 勾选同步

**提交**：`refactor(cli): split createLocalGateway into subsystem builders` 等

### P5（S1）命名与数据资产 · 约 2–3 天

**发现**：`pilot` 名称与三重职责不符；`src/knowledge/patent/wiki/` 1500+ md 数据资产混入源码树。

**改动点**：
1. `pilot/index.ts` 与 `pilot/config/types.ts` 增加模块职责文档（配置聚合 + 项目定位，命名保留与否在 P2f 评估后决定，当前只补文档）
2. wiki 资产迁移 `src/knowledge/patent/wiki/` → `assets/knowledge/patent/wiki/`：更新 `build` 的 `cpSync` 与 `wiki-card-loader.ts` / `ipc-standards-loader.ts` 的运行时路径解析（**先改 loader 路径再移文件，验证 knowledge 加载测试**）
3. `CLAUDE.md` 目录结构注释同步

**验证**：`tests/knowledge/` 相关测试全绿；`pnpm build` 后 `dist/` 含 wiki 资产

**提交**：`refactor(knowledge): move wiki assets out of src/`、`docs(claude): document pilot module responsibility`

### P6（S2 + W2）工作流收敛——先评估后执行 · 评估 1 周 + 执行 1–2 周

**发现**：四套并行执行模型（`src/workflow` DAG 引擎 / `src/patent/workflow` 单阶段执行器 / `flexible-plan` / `patent/graph` SuperStep）+ `workflow` 撞名；DAG 引擎仅 2 消费者（S2 已 defer，2026-11-18 到期）。

**改动点**：
- **P6a 评估（必须先于一切删除动作）**：产出 `docs/workflow-convergence-eval.md`——四引擎能力覆盖矩阵（checkpoint / 审批门 / 降级 / HITL / resume / 等价性测试现状）、DAG 两消费者的真实需求清单、收敛方向建议（图引擎为长期模型的可行性）
- **P6b 共享执行协议**（无论评估结论，先做）：`src/patent/execution-protocol.ts` 统一 checkpoint / 门禁 / 降级契约，四引擎适配
- **P6c 收敛执行**（依据 P6a 决策二选一）：(a) 图引擎吸收 DAG，删除 `src/workflow` + `SubagentWorkflowAgentFactory` 依赖链；或 (b) 保留 DAG 为主引擎，`patent/workflow` 变薄适配层；消除两套 checkpoint 格式与 `workflow` 撞名

**验证**：`manifestToGraph` vs `runWorkflow` 等价性测试保持全绿；`check:patent-workflow-docs` 通过；`docs/event-producer-consumer.md` 无漂移

**提交**：`docs(patent): workflow convergence evaluation`、`refactor(patent): unify workflow checkpoint protocol` 等

### P7（W4）浏览器后端单一数据源 · 约 3 天

**发现**：4 个浏览器后端（ego-lite / browser-use-python / playwright / browseros-neo）在 `src/browser/backend/*Backend.ts` 类层级与 `extension/plugins/builtin/*/plugin.json` 双份注册。

**改动点**：
1. 让 plugin.json 成为唯一事实源：`src/browser/backend/index.ts` 的后端候选列表从 `loadBuiltinPlugins()` 的贡献点派生，删除类层级中的重复注册表
2. 或（若插件系统承接成本过高）降级方案：保留现状但新增 `scripts/check-browser-backend-drift.mjs` 漂移门禁（对齐 `check-ui-server-boundary.mjs` 模式），挂 `pnpm lint`

**验证**：`sati browsers` 输出与插件启用集一致；新增后端只需改一处

**提交**：`refactor(browser): derive browser backends from plugin manifests`

---

## 三、阶段划分

| 阶段 | 周期 | 内容 | 卡 |
|---|---|---|---|
| 阶段 1 | 第 1 周 | shared 收敛（P1）——拆环前置 | P1 |
| 阶段 2 | 第 2–3 周 | 核心拆环（P2a–P2f，等 c03-c04 合并后动 session） | P2 |
| 阶段 3 | 第 4 周 | 渠道契约测试（P3）→ 为拆文件铺路 | P3 |
| 阶段 4 | 第 5–7 周 | 巨型文件与神函数拆解（P4：createLocalGateway → AgentLoop.run → 渠道类） | P4 |
| 阶段 5 | 第 4 周（可并行） | 命名与资产迁移（P5，wiki 迁移独立于拆环） | P5 |
| 阶段 6 | 第 5–6 周 | 工作流收敛（P6a 评估 → P6b 协议 → P6c 执行） | P6 |
| 阶段 7 | 第 4 周（可并行） | 浏览器后端单一数据源（P7，与核心拆环无依赖） | P7 |

**并行说明**：P5（wiki 迁移部分）、P7 与阶段 1–4 无依赖可并行；P6a 评估可随时启动（只读产出）；P2a 受 c03-c04 分支阻塞。

## 四、进度表

| 卡 | 内容 | 状态 |
|---|---|---|
| P1 | shared/paths + shared/env + shared/retry 收敛 | ✅ 2026-08-20（交付记录见下） |
| P2a | session→agent 依赖反转（factory 注入） | ⬜ |
| P2b | tool→agent 依赖反转（TeamRuntime 注入） | ⬜ |
| P2c | gateway→adapters 反转（HttpRouter 注入） | ⬜ |
| P2d | adapters→cli 反转（chatSearchCore 抽取） | ⬜ |
| P2e | patent↔tool 环（证据协议归位 + commandRunner 迁 shared） | ⬜ |
| P2f | pilot 环收尾（type-only 环处置） | ⬜ |
| P3 | WeCom/Weixin/Feishu 契约测试 + 纯函数层抽取 | ⬜ |
| P4a | createLocalGateway 拆 4 builder | ⬜ |
| P4b | AgentLoop.run() 阶段骨架 + recovery/ 下沉 | ⬜ |
| P4c | 三大渠道类按 protocol/state/handlers/render 切分 | ⬜ |
| P5 | pilot 职责文档 + wiki 资产迁 assets/ | ⬜ |
| P6a | 工作流收敛评估（docs/workflow-convergence-eval.md） | ⬜ |
| P6b | patent 执行协议统一（execution-protocol.ts） | ⬜ |
| P6c | 工作流收敛执行（依 P6a 决策） | ⬜ |
| P7 | 浏览器后端单一数据源（或漂移门禁降级方案） | ⬜ |

### P1 交付记录（2026-08-20）

**已交付**：
1. `src/shared/paths/`：迁入 `pilot/paths.ts` 全部路径函数 + `session/worktree` 簇（LRUMap/findGitRoot/resolveCanonicalRoot/findCanonicalProjectRoot）；`src/` 内对 `pilot/paths.ts` 直引归零（14 处导入方全部改引 shared/paths）；`pilot/paths.ts` 与 `session/worktree/index.ts` 保留 re-export shim（ui/server 纯 JS 移植测试依赖）
2. `src/shared/env/`：统一 parsePositiveInt/parseNonNegativeInt/readIntEnv/readNonNegativeIntEnv/readBoolEnv/readDurationEnvMs，替换 createLocalGateway（6 处）、streamModel（1 处）、telemetry/collector（6 处）本地实现
3. `src/shared/retry/`：`computeBackoffDelay`（exponential/linear 双模式 + jitterRatio + retry-after 封顶），收敛 network/fetch.resolveRetryDelay、router.calculateLiteLLMRetryDelay、model calculateRetryDelay 三处公式（逐字节等价）

**有意保留（非重复公式实现）**：
- `patentSearch.ts` CLI 参数校验（非法即 throw、含错误消息）——与 env 读取（fallback）不同关注点，不合并
- `edgeclaw-memory-core` 子包 `request-retry.ts`（红线：子包独立构建不动）
- `patent/graph/node-policy.ts`、`workflow/runtime/WorkflowEngine.ts` 的 `base × 2^attempt` 单行乘法（无抖动无封顶）——归 W2 工作流收敛卡处置

**过程记录**：
- `docs/event-producer-consumer.md` 随行号漂移重新生成（lint 门禁要求，属本次改动产物）
- 工作树中 `tests/web/*`、`tests/tool/tool-result-workspace-path.spec.ts` 共 6 个文件存在**他方进行中的编辑**（`createAgentProjectSessionStorage` 调用点补 `flushThresholdBytes: 0`，格式未收口），非本卡改动，不触碰；全仓 `pnpm format:check` 因此暂红，本卡文件子集已单独验证通过
- 门禁：`pnpm typecheck` ✅ / `pnpm lint`（6 道）✅ / 本卡文件子集 biome ✅ / 全量 `pnpm test` 见状态

## 五、验证工具与门禁

- **依赖矩阵脚本**（复现审计度量）：`for m in src/*/; do ... done`（§二 P2 验收用），断言值导入环为零——可将断言固化为 `scripts/check-module-cycles.mjs` 挂 `pnpm lint`（对齐 `check-ui-server-boundary.mjs` 模式）
- **每卡门禁**：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`（后端卡）；UI 卡 `pnpm --filter sati-ui test && pnpm --filter sati-ui typecheck`
- **事件面**：`pnpm check:event-matrix`（lint 自动挂接），事件/协议面零改动
- **回放**：改动涉及 model/tool 输入面时 `pnpm record:replay` 校验 fixture 不失配

## 六、红线（与 code-refinement-plan.md 一致并追加）

1. 不改工具 `inputSchema`（LLM replay fixture 请求键含 `toolSchemaDigest`，改即全量失配）
2. 事件面 / gateway 协议面零改动（`check:event-matrix` / 协议版本表保护）
3. `ui/server` 白名单边界不动（`check-ui-server-boundary.mjs`）；`edgeclaw-memory-core` 构建方式与 lib 直连路径不动
4. 全部提交为 `refactor` / `test` / `docs` 类，一个关注点一个提交；发现 P0 行为缺陷不混入 refactor 提交，另开 fix 提交
5. P2a 不早于 c03-c04 分支合并启动（session/transcript 正在重构中）
6. P6c 任何删除动作必须先有 P6a 评估结论（S2 defer 到期 2026-11-18 前完成评估）
