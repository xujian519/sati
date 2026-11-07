# Agent Note: AgentLoop 阶段方法迁入 `phases/`（issue #809 收口）

Status: implemented

## Problem

issue #809 的描述是「`AgentLoop.ts` 扇出 36 个模块（全仓最高），agent 主回路编排职责过重」，并给出一个体量印象：**283 行**。

实测与该描述不符——扇出属实，体量不属实：

- 拆分前 `AgentLoop.ts` **783 行 / 34 条 import**；「283 行」大概是更早某次快照被抄错，783 行里没有任何一段是可以整块搬走的纯函数；
- 真正的病灶不是行数而是**结构形状**：`run()` 已经骨架化（8 月的轮次 4），但骨架调用的阶段实现仍是类内私有方法——**6 个 `private async *` generator**（`runTurnGuards` / `applySteeredMessages` / `prepareModelCall` / `streamModelResponse` / `handleCircuitBreaker` / `finishTurn`），外加 1 个 `private async continueWithSyntheticPrompt`。它们挤压在同一个类体里，与构造器接线、权限/模式覆写、`snapshotFileState` 混排；
- 后果是可测性：每个阶段的入参是 `this`，要为「熔断阶段达阈值后给宽限提示」写一条直测，得先把整台 loop（config / dependencies / 工具运行时 / 事件发射）拼出来，实际只能靠假 router 跑整条回路触发。`loop/` 下的 seam 模块大多在 `tests/agent/loop/` 有专属 spec，唯独这 6 个阶段没有；
- 扇出本身也是症状：阶段实现在类体里，必然把「模型流式」「路由判定」「压缩触发」「工具失败指纹」这些子系统的 import 全拉到主文件。

轮次 8 收口时（`2026-09-14-agentloop-decomposition-closure.md`）的判断是「停在 1133 行是设计使然，继续切阶段方法属改流程」。这个判断在当时成立：那时阶段之间靠 `continue`/`return` 直接交接，抽出去只能改写成回调或返回值协议。此后 `turnExit.ts` 把交接词汇固定成 `TurnStepContinue | TurnStepReturn`（`proceed` / `continue` 哨兵），「逐字搬迁」这条路才第一次真的存在——本次即是走这条路。

## Decision

新增 `src/agent/loop/phases/`，把 6 个阶段方法与合成提示续跑整体外迁为**自由函数 + 依赖袋**，与 `loop/` 既有 seam 同构（`export type XxxDeps` + `export async function*`）：

| 模块 | 行数 | 职责（一句话） |
|---|---|---|
| `phases/turnGuards.ts` | 89 | turn 起始守门：取消检查 → doomLoop 致命状态 → PreStep 生命周期扩展点，任一步终止即返回 `TurnStepReturn` |
| `phases/steering.ts` | 46 | 模型调用边界 drain 插话邮箱：先落库再注入并广播 `steer_applied`，未接线零开销 |
| `phases/modelCall.ts` | 161 | 请求准备：pre-routing 压缩 → 请求装配 → PreModelRequest 生命周期 → 路由判定 → 按路由窗口补 post-routing 压缩 → token caps → `context_budget` |
| `phases/streamResponse.ts` | 131 | 流式执行：请求头快照落盘 → 上下文快照 → 逐事件转发并喂 assembler →（可选）派发点对拍 → 异常/取消收尾 |
| `phases/circuitBreaker.ts` | 123 | invalid_tool_input 指纹熔断：LargeFileRepair 待修优先续跑 → 达阈值给一轮宽限提示 → 再达阈值终止；非全失败轮次复位恢复计数 |
| `phases/finishTurn.ts` | 79 | turn 收尾：结构化输出即停 → maxTurns 上限 → `turn_continued` 进入下一轮 |
| `phases/syntheticPrompt.ts` | 91 | 合成提示续跑：按 `LargeFileRepair` 决策剥离尾部消息 / 压入 transient 提示 / 抬升 `maxOutputTokens` → `turn_continued`；`stop` 则直接构造终止结果 |

合计 720 行。`AgentLoop.ts` 783 → **290 行**，import 34 → **27** 条；类体只剩构造器接线、`run()` 顺序编排、`snapshotFileState`、`applyPermissionOverrides`、`applyRunModeOverride`、`now`。

`run()` 保持「读一处就能看出一轮 turn 的形状」：阶段顺序仍写在同一段里，只是被调用的名字换成了 `runTurnGuards` / `applySteeredMessages` / `prepareModelCall` / `streamModelResponse` / … 这些外部函数。

**判据（供后来者判断新代码放哪）**：

- **阶段函数进 `phases/`**——它回答「一轮 turn 的第 N 步做什么」，入参是 `(deps, state, input)`，出参是 `TurnStepContinue | TurnStepReturn`；
- **恢复 / 装配 seam 仍平铺在 `loop/`**——`modelErrorRecovery` / `responseAssembly` / `turnExit` / `recoveryStrategies` / `modelRequest` / `compactionExecutor` 不是「第 N 步」，而是被多个阶段共同调用的处置链或执行器；给它们加一层目录只会让「阶段」与「策略」的边界变模糊；
- **`phases/` 内禁止 import `AgentLoop.ts`**——阶段只能通过 deps 拿到能力，反向依赖会让 `phases/` 退化成类的一部分（只需 `import type { AgentLoopInput }` 这类协议类型）；
- **导入深度由 `./x.js` 变 `../../x.js`**——`phases/` 是 `src/` 下唯一的 `phases` 子目录，`loop/` 其余 seam 仍是平的；`phases/` 内引用兄弟 seam 一律 `../x.js`。

**附带收拾**（同一次搬迁里顺手，均为零行为变化）：删掉死代码 `createTurnResult`；`responseAssembly.ts` 里「实现留在 AgentLoop」的过期注释改为指向 `phases/syntheticPrompt.ts`；`SteeringDeps` 由构造期快照 `steerSource` 改为传 `dependencies`，保持原有的**调用期读取**语义（`steerSource` 非 readonly，后接线仍要生效）。

## Alternatives considered

- **继续平铺在 `src/agent/loop/*.ts`，不开子目录** — 落选：这与 `loop/` 既有 seam 的平铺风格一致，代价最小，但 `loop/` 会变成 37 个同级文件、30+ 个 import 邻居，而读者需要区分的是三类东西——阶段（一轮 turn 的 N 步）、恢复/装配 seam（被多步共用的处置链）、执行器（压缩/请求/子代理）。平铺让这三类在目录列表里视觉等价，「加代码该加在哪」只能靠记住文件名。子目录把「阶段」这一层变成可枚举的 7 个文件，代价是多一层相对路径。
- **把构造器接线搬进工厂函数，把 import 压到 ≤20** — 落选：这条能达标（27 条里约 10 条只为构造期建立依赖袋服务），但会把「编排顺序」和「依赖装配」拆到两个文件：读 `run()` 时看到 `deps.dispatchLifecycle`，得跳到工厂才知道它是什么、什么时候被覆写。issue #809 抱怨的是「编排职责过重」，不是 import 条数本身；为了一个数字把 wiring 挪走，等于把「一轮 turn 依赖哪些能力」这个最有信息量的清单藏起来。import 数下降是搬迁的**副作用**，不是目标。
- **保持类内方法，只抽 helper 出来** — 落选：这是最小改动，也能减少类体行数，但阶段方法的入参仍是 `this`，单测仍要构造整个 `AgentLoop` 实例（config + dependencies + 各执行器），本次要解决的「阶段无法直测」一点没动。抽 helper 只搬走纯计算，搬不走「这一步要不要终止 turn」的判定。
- **让 `AgentLoop` 保留薄包装方法（`private runTurnGuards() { return runTurnGuards(this.deps, …) }`）** — 落选：调用点各只有一处，包装层只会让 `run()` 里出现一个与外部函数同名的私有方法，读者要多确认一次「这个是不是真的搬走了」。

## Consequences

- `AgentLoop.ts` **783 → 290 行**，import **34 → 27**；`phases/` 7 个模块共 720 行，**没有新增一行逻辑**——是搬家，不是重写。
- 阶段可直测：6 个阶段 + 续跑函数的依赖袋都是显式对象，测试可以只喂它需要的那几项，不必拼整台 loop。既有 480 项 agent 测试（含 274 项 `tests/agent/loop/`）全部通过，说明搬迁后行为未变。
- 判据落在目录结构里：新代码「放 `phases/` 还是 `loop/`」有了可执行的回答（见 Decision 末四条），不再依赖「这次感觉像哪个」。
- **代价一：import 27 条没到 ≤20，且仍居全仓前列**。同时点实测：`DefaultContextRuntime.ts` 25、`createAgentSession.ts` 22——差 2 条。剩下 27 条里 9 条是 `import type`（协议/配置/各类 `XxxDeps`），其余是被 `run()` 与两个私有辅助直接使用的东西。要继续压只能动构造器接线本身（被否的方案 b），而 import 条数与“编排是否可读”并不正相关。
- **代价二：`phases/` 是 `src/` 下唯一的 `phases` 子目录**。`loop/` 其余 seam 仍平铺，所以「`phases/` 一层、其余零层」的深浅不一致会长期存在；这是有意的（阶段是一等概念，seam 不是），但新人第一次会问。
- **代价三：`missingToolResultRecoveryContext` 落在了 `phases/syntheticPrompt.ts`**。它读的是 `AgentRuntimeConfig`（cwd + 权限模式），本质是「恢复链缺工具结果时的执行上下文」，与合成提示续跑只是**调用方关系**，不是同一职责。审查已建议后续移到 `modelErrorRecovery.ts`（真正的主人）；本次为保持零行为变化没有连带搬。
- 文档面：`docs/agentloop-refactor-plan.md` 追加轮次 9 并修正 §10.2 的收口判断；`docs/technical-debt/backlog.md` 的 PS-13 / BF-20 / TD-R2-001 回填现况。事件矩阵按 `file:line` 硬编码，`AgentLoop.ts` 里若干 emit 点随迁到 `phases/*.ts`，须由交付位跑 `pnpm gen:event-matrix` 回填（本轮文档侧未跑）。

## 验证证据（来源需区分）

- **开发位 / 审查位执行**：`tsc --noEmit` 0 error；480 项 agent 测试通过（含 274 项 `tests/agent/loop/`）；`pnpm check:runtime-cycles` green；迁出的 8 个函数逐 token 对照无行为差异。
- **文档侧未独立复跑**：本次只核对源码与 diff。本机 Node 为 v24.19.0，`pnpm build` 在 `check-node-runtime` 处即被拦下（要求 Node 22），因此全量 `pnpm test` 与 tsc 均未在文档侧重跑——上面三项计数转述自开发位/审查位结论，不作为文档侧独立验证。
- **未跑的门禁**：`gen:doc-claims` / `gen:event-matrix` / `measure:update` 按约定由交付位统一执行（存在顺序依赖）。其中 `check:doc-claims` 在本次改动后会因 `src/agent/` 的文件计数变化而红，`check:event-matrix` 会因生产者文件行号变化而红——两者都属「生成物未再生」，不是断言失败。
