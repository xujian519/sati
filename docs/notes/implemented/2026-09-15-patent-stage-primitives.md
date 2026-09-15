# Agent Note: patent 阶段执行原语收敛（graph / manifest 双轨合一）

Status: implemented

## Problem

专利管线有两条执行路径——图路径（`patent/graph/` + `manifestToGraph`）与 manifest 路径（`runWorkflow`）。两者都要回答同一个问题：「**跑一个阶段，并把主输出取出来**」。这个语义原先在**两处各写了一遍**：

- `graph/adapter.ts:makeStageNode`（190 行文件内）↔ `workflow/executor.ts:runStageOnce`；
- 回退清理同样两份：`graph/adapter.ts:makeRetryRouter` ↔ `workflow.ts` 的 rewind 分支。

且**已经漂移**（不只是「将来会」）：图路径缺「已放行审批门占位」分支，于是**同一 manifest 经两条链路得到不同的 `state[gateStageId]`**（图路径 `""`，manifest 路径 `"APPROVED"`）。issue 表格里列的四个要素（主输出键解析 / JSON 序列化兜底 / 空输出回退 / approvedGate 分支）**实核属实**。

核码时另有两处修正，已写入 PR 与 issue 结论：

1. **issue 对影响的一句判断不成立**。issue 称「graph 路径不写占位输出 → 可能被标记 degraded」。实测：图路径的降级只来自 `degradationSummary(state)`（即 `<key>__degradation` 后缀），**空输出本身不会被标记**——引擎只在节点抛错时写标记（`engine.ts` 的 `node_failed`）。故缺占位分支的真实后果只有「输出文本不同」，不是「降级判定不同」。
2. **第三处漂移（issue 未列）**。`makeStageNode` 里 `delta[`${stage.id}__degraded`] = true` 是**写而无人读的死键**：全仓唯一写入点就在这一行，而唯一读取侧 `degradationSummary` 只认 `__degradation` 后缀。同场景 manifest 路径会进 `degradedSteps`。后果是无人值守的图路径上「该阶段根本没有可执行体」被**静默报成成功**。而 `DegradationReason` 枚举里早已声明 `not_implemented` 却零生产者——那个死键显然是想表达它。

## Decision

**抽出共用的阶段执行原语，并把两侧的差异参数化（而非强行归一）**：

1. 新建 `src/patent/workflow/stage-primitives.ts`，导出：
   - `resolveStageOutput({ segment, mainKey, fallbackValue, approvedGate })` —— 主输出键解析（字符串原样 / undefined 视作空 / 其余 `JSON.stringify(…, null, 2)`）→ 空输出回退 `fallbackValue` → 已放行审批门补 `APPROVAL_GRANTED_OUTPUT`。顺序即契约，两侧共用。
   - `clearStageOutputs({ state, stages, atoms })` —— 删被回退阶段的 stage-id 键 **及其 atom 的 `outputSchema` 全部键**。
   - `isApprovalGateStage(handler)` —— `isApprovalGateHandler` 的容空包装（图路径的 handler 可能未注册，两侧不再各写一遍 `!== undefined`）。
   位置沿用仓内既有先例：`workflow/signal.ts` 就是被 `graph/adapter.ts` 复用的语义单一实现。
2. `workflow/executor.ts`、`workflow.ts`、`graph/adapter.ts` 三处改为调用，`adapter.ts` 不再持有输出解析与清理语义。
3. **图路径补齐占位分支**，判据取 `isApprovalGateStage(handler) && Boolean(execState[APPROVAL_GRANTED_KEY])` —— 与 `ApprovalGateHandler` 内部所判的**同一个执行态、同一个键**，故「已放行」与「补占位」恒同时成立（放行判定仍收敛在 handler，本处只把它翻译成输出）。
4. **死键改走引擎已消费的通道**：`markDegraded(delta, stage.id, output, "not_implemented", …, "critical")`，与 manifest 路径的 `degraded: true` 判定同向。
5. 文档同步：`graph/README.md` 的「已知差异」列表（「放行 approval」那条已不成立）、`gate.ts` 的审批闭环契约注释（原写「占位输出仅 manifest 路径需要」）、`APPROVAL_GRANTED_OUTPUT` 的 doc。

## Alternatives considered

- **把所有差异都归一**（含回退清理范围、`state[stage.id]` 的写入位置）— 落选。清理范围的两侧取值（图：`slice(rewindIndex, currentIndex+1)`；manifest：`slice(rewindIndex)` 到清单末尾）在语义上不可观察（两者都只触及尚无结果的阶段键），但 manifest 侧「清到末尾」在**理论上**能删掉与 ctx 同名的键（`state` 由 `{ ...ctx }` 初始化；阶段 id 与 `input`/`text` 同名是病态配置，非不可能）——强行归一等于引入一个无收益的行为变更。故保留为参数：**单一实现 + 各自声明范围**。
- **把共用原语放 `graph/`，让 `workflow/` 反向 import** — 落选。与本仓既有方向相反（`signal.ts` 在 `workflow/` 且被 graph 复用），且 `graph/` 是引擎实现细节，`workflow/` 才是语义层。
- **让 `ApprovalGateHandler` 自己写占位输出** — 落选。handler 拿不到自己的 stage id（`StageExecuteInput` 只有 `state`/`provider`），且会污染 `Object.assign(delta, segment)` 的语义——占位是「外层对空产出的补写」，不是 handler 的产出。
- **图路径的放行判据改用「本阶段 id 在放行集合内」**（与 manifest 路径同构）— 落选。图路径没有 stageId 粒度的放行集合，它的契约就是检查点 state 里的放行标记（`grantApproval`）；另找一处状态作判据等于引入第二份真相。
- **只删死键、不补降级标记** — 落选。删掉后「阶段未执行」在图路径彻底无痕，与项目「诚实降级」的信条相反；改用引擎已消费的通道才让两条链路的判定同向。
- **顺手统一 executor 分支是否写 `state[stage.id]`**（图路径写、manifest 路径不写，README 已记为已知差异）— 落选。超范围，且改的是 `runWorkflow` 的既有行为，会牵动依赖「不写」的断言，应单独立项。

## Consequences

漂移点被**结构性**消除：新增/调整阶段输出语义只需改一个文件，且有直接单测钉住（`tests/patent/workflow/stage-primitives.spec.ts`）。

**两处可观察变更**（均在 PR 里显式声明）：

1. 已放行审批门在图路径的 `state[gateStageId]` 由 `""` 变为 `"APPROVED"`——包括 `patent_workflow_run(graph=…)` 的结果渲染（原先显示 `- review_gate: (空)`）。
2. 无 handler 无 executor 的阶段在图路径出现 `not_implemented` 降级标记（severity `critical`），`result.degraded` 随之非空、渲染出「⚠️ 降级标记」。

**残留差异（本次未动，已逐条写进 `graph/README.md`）**：

- 错误重试的表示：manifest 路径写 `[WORKFLOW_DEGRADED] <id>: <msg>` 文本且重试 `maxRetries` 次；图路径只执行一次、错误转 `node_failed` 标记。统一表示会同时改变两条链路的输出，属另一个专项。
- 阶段级 `degraded` / `completed` 通道：manifest 路径空输出即 `degraded: true → completed=false`；图路径 `completed` **不看**降级标记。故同一 no-executor manifest 两路径仍一个 `completed=false`、一个 `completed=true`（新用例已把这个残留断言出来，免得误以为已归一）。
- executor 分支：图路径额外写 `state[stage.id]`。

**风险登记（本 PR 不改语义，但值得单独立项）**：图路径的放行是**全局 state 键**（`grantApproval` 写检查点，永不清理），故一次批准会让同一 run 内**后续所有**审批门一起静默放行；manifest 路径按 stageId 粒度不受影响。`patent_drafting_v1` 有六个审批门，经 `manifestToGraph` 跑时该语义值得复核。

**阈值**：新增 `stage-primitives.ts`（约 95 行）+ 单测 14 例；`adapter.ts` 净减（输出解析与清理逻辑移出）。
