# Agent Note: InProcessGateway.submitTurn 三段式拆分（#646 sweep P2.1）

Status: implemented

## Problem

`src/gateway/client/InProcessGateway.ts` 的 `submitTurn` 是 gateway 客户端的 turn 主链路入口：归一化输入 → `/plan` 用法兜底 → 预刷新配置 → 占位（`session_busy`）→ 装每 turn 状态 → 起硬超时定时器 → 装配权限/附件/提交选项 → 消费 `session.submit` 的 agent 事件流、映射成 `GatewayEvent` 并进队列 → 收尾清理。全部塞在**一个 301 行的 async generator**里（`docs/technical-debt/backlog.md` §38.1 的 P2 批次首位，计划 §5 P2.1）。

问题不在"长"本身，而在于这条链路**三类关注点的生命周期互相缠绕**：

- 消费者（`for await … yield`）**随时可能提前 `return`**（abort / 客户端断开 / cron 超时），而此时后台的 pump 与 timeout 定时器仍在跑；
- 硬超时是**另一个并发源**，它在回调里要同时改状态（`timedOut`）、合成失败事件、拒绝两条 bus、关队列、abort session；
- 收尾（清 `emitSinks` / `activeTurnReplays` / 两条 bus、`router.endTurn`、释放 `turnCompletions`）必须**恰好一次**，无论正常读完还是异常退出。

读这段代码的人要同时跟踪这三个时间线才能确认"不会泄漏 / 不会重复放流"。P2.1 的通过判据是「`submitTurn` ≤150 行，**契约不变**」——契约指对外暴露的事件序列、队列关闭时机、状态清理次数、`turnCompletions` 的所有权语义。

## Decision

**按生命周期三段切成三个私有方法 + 一个显式共享上下文**，入口只留"放流与收尾"：

| 段 | 位置 | 行数 | 职责 |
|---|---|---|---|
| `submitTurn`（入口） | `InProcessGateway.ts:434` | **16** | 起启动段；`rejected` 只放流；否则起 pump，`for await` 放流，`finally` 收尾 |
| `startSubmitTurn` | `:455` | 57 | 归一化 / 预刷新 / 占位判定 / 装状态（deferred、重放槽、emit sink、`workspaceCwd`） |
| `emitTurnFailure` | `:519` | 18 | 状态落盘 + 「`agent_status` → `error`」依次进重放与队列 |
| `pumpSubmitTurn` | `:542` | 125 | 后台泵：`getOrCreate` → 硬超时 → 权限/附件/提交选项装配 → 消费 + 映射 + 入队 → 异常兜底 |
| `finishSubmitTurn` | `:672` | 34 | 清 sink/重放槽、拒绝两条 bus、`endTurn`、按 `timedOut` 决定是否 `router.close`、释放 deferred |

关键决策点（写下是因为它们看着像"随手的选择"，其实各有约束）：

1. **共享上下文用显式类型 `SubmitTurnContext`，不用 `this` 上的临时字段。** `timedOut` 由 pump 的回调写、由 finish 读；跨段共享的可变状态只有它一个，其余是句柄（`queue` / `turnDone` / `resolveTurnDone` / `telemetryContext`）。放 `this` 上会造出"同一 session 两次 turn 互相覆盖"的隐式通道。
2. **`turnDone` 的所有权检查原样保留**（`this.turnCompletions.get(key) === turnDone`）。它防的是"后一个 turn 已接管，前一个还在写"；拆段时最容易被顺手简化成 `delete(key)`——那会让后一个 turn 的 deferred 被前一个删掉，`abortTurn` 的等待者永不 resolve。三处（pump 的循环守卫、pump 的异常分支、finish 的 `delete`）条件**不得合并**。
3. **超时回调必须把 `input.timeoutMs` 捕获成局部常量**（`:553-554`）再进闭包。属性窄化不跨回调边界，闭包里直读会退回 `number | undefined`（TS2322）。
4. **`rejected` 两种结局合成一个 `SubmitTurnStartup` 联合类型**，而不是让 `startSubmitTurn` 自己 `yield`（它是普通 async 方法，不能 yield）。`planCommandUsageEvents()` / `sessionBusyEvents()` 因此成为**纯函数**（落在 `normalizers.ts`），可被单测直接钉事件序列——拆分前这两段只能靠端到端跑 `submitTurn` 才能碰到。
5. **顺带消除"两份同文案字面量"**：超时与提交失败各有一对「status 文案 + error 文案」，拆分前是两处独立字面量，改一边漏一边不红。`telemetry.ts` 新增私有 `createTurnFailure` 由同一份 `message`/`userHint` 产出两者，两个导出只留各自的差异化字段（`turn_timeout` 带 `detail.timeoutMs`，`gateway_submit_failed` 不带）。
6. **纯逻辑外迁到 `normalizers.ts`**（而非就地内联）：`buildSyntheticTurnMessages` / `resolveSubmitTurnPermissions` / `buildSubmitOptions` / `planCommandUsageEvents` / `sessionBusyEvents`。这既是为了单测接缝，也是为了**不撑爆文件行数棘轮**（见 §Consequences 第 2 条）。

**事件序列的等价性由三条独立判据保证**：拆分后事件矩阵 `docs/event-producer-consumer.md` 的 86 行**生产者/消费者数量逐行不变**，仅 4 行（`agent_status` / `assistant_text_delta` / `error` / `turn_completed`）的生产者归属从 `InProcessGateway.ts` 改指 `normalizers.ts`；`tests/gateway/client/submitTurn.spec.ts` 钉端到端顺序与清理次数；`normalizers.spec.ts` 钉被判据纯函数的序列与字段。

## Alternatives considered

- **把三段写成 `submitTurn` 内的局部闭包（不新增方法）**：god-function 度量按**最外层函数**计长，闭包内联仍然算 301 行，指标不动——等于只改了阅读形状没改判据；且闭包内 `yield*` 桥接与 `this` 捕获比私有方法更绕。否决。
- **靠内联压缩把 301 行硬压到 ≤150（不切结构）**：≤150 是"单一职责"的代理指标，不是目的；压注释、合并语义块能过数但要读者对照旧版才能读懂。这与 M1/M2 的意图相反。否决。
- **连 attachments / telemetry 一起抽成新模块**：这两件事已有归属（`buildAgentInputWithAttachments`、`emitSessionTelemetry`），剩下的行是**编排**——编排属于 gateway，抽出去会得到一个只有本类消费的模块，纯粹搬运。否决。
- **新增 `registerTurnHandles` API + 自动枚举守卫**：pump/finish 的活性已经由 `turnCompletions` 的所有权检查覆盖（"后一个 turn 接管"即视为放弃写）。再引入一张待清理句柄表就是**第二个枚举面**，需要与现有检查保持同步，却不带来新不变量。否决。
- **`startSubmitTurn` 也返回事件流（统一成 generator）**：会让"预刷新/占位"这些**有副作用、必须只跑一次**的步骤落进可被消费者提前 `return` 的 generator 语义里（Python/TS 的 generator 在 close 时的执行点很微妙），把"恰好一次的副作用"变成"取决于消费方"。否决。

## Verification

- **指标**：`pnpm measure:update` → god function `63 → 62`，`submitTurn | 301 | method` 行从榜单移除；`InProcessGateway.ts` 在「Top 30 大文件」`1518 → 1512`（棘轮基线 `architecture-baseline.json:53` 仍为 1518，**未下调**，只增余量）。
- **文件规模 before/after**：`InProcessGateway.ts` 1517 → 1511 行；`normalizers.ts` 60 → 169；`telemetry.ts` 404 → 474。
- **事件矩阵**：`pnpm check:event-matrix` fresh；86 行生产者/消费者**计数全部不变**，4 行归属改写为 `normalizers.ts`。
- **定向测试**：`tests/gateway/client/{normalizers,submitTurn,telemetry}.spec.ts` = **23 例（12 + 4 + 7）全绿**；新增接缝 = `resolveSubmitTurnPermissions`（plan 覆盖 / skipPermissions+legacy runMode / session 授权前插）、`buildSubmitOptions`（空 `syntheticMessages` 不出键）、`createTurnTimeoutFailure` / `createSubmitFailedFailure`（status 与 event 同源同文案）、以及 `session.submit` 抛错时的 `gateway_submit_failed` 事件序 + 落盘次数。
- **负控制**：10 处**串行**变异（每次只改一处、跑完即 `cp` 还原）**全部按预测转红且只红预测的那条**，相邻用例保持绿、还原后 23/23 绿。含两类易漏点：`turnCompletions` 所有权检查（3 处各自变异）、`buildSyntheticTurnMessages` 的 guard 头。
- **门禁**：`pnpm check` 链的每一步单独复跑均 exit 0 —— `check:freshness` · `check:config` · `typecheck`（root）· `sati-ui typecheck` · root `eslint src tests scripts apps/desktop` · `format:check` · `check-ui-server-boundary.mjs`，以及 `package.json` 里 **全部 16 条 `check:*`**（含 `check:architecture-boundaries` 42 条豁免不变、`check:event-matrix`、`check:techdebt-metrics`、`check:doc-claims`）。唯一无法整包复跑的是 `ui` 的 `eslint src/ server/`——环境垫片断管，见下条。

## Consequences

- **换来了**：`submitTurn` 从"要同时跟踪三条时间线"变成 16 行的放流骨架；两个被判据的失败出口（`session_busy` / `/plan` 用法）从"只能端到端触发"变成可单测的纯函数；超时与提交失败的文案对从两处字面量收敛为一处构造点。
- **付出了**：`normalizers.ts` 从 60 行涨到 169 行，承担了一类新的职责（"被拒绝的输入 → 事件序列"+"提交选项装配"）——它现在不是纯归一化模块了，**下次再往里塞东西前应先看是否需要第三个模块**。
- **文件行数棘轮的一个反直觉后果**：拆分本身**增加**行数（多出的方法签名 + 段首 JSDoc + `SubmitTurnContext`/`SubmitTurnStartup` 类型）。首版拆完 `InProcessGateway.ts` 是 **1568 行**，直接超过 1518 的棘轮基线 ⇒ 必须在**同一次改动里**把纯逻辑外迁（`normalizers.ts`）并消掉重复文案（`telemetry.ts`）才算完。也就是说本项交付的形态不是"怎么拆最干净"，而是"怎么拆到干净**且不涨文件**"——记录在此，避免后人把外迁误读为多余的顺带重构。
- **未改变**：`submitTurn` 的对外契约（事件序列、队列关闭时机、清理次数、`turnCompletions` 语义）逐条不变；`src/gateway/protocol` 无新增/变更方法，不触发 `pnpm check:protocol-version`。
- **已知环境噪声（非本项回归）**：本机 `pnpm check` / `pnpm lint` 会停在 `ui` 侧 `eslint src/ server/ --max-warnings 0`，以 `Error: write EPIPE` 退出 2，**不打印任何 lint 诊断**。栈顶指向执行环境的 IPC 垫片（`…/cli/vendor/shim/broker-ipc-client.cjs:185` 的 `Socket._write`），即**沙箱管道断管**，与 ESLint 规则无关——触发条件是**整包规模**：单文件、单目录、以及按 `server/* + src/*` 分 35 块的逐块运行全部 exit 0。分块聚合 `-f json` 结果 = **220 文件 / 0 error / 0 warning**，与 `eslint src/ server/` 的覆盖面等价（`src/index.css`、`src/assets` 的报错是显式传路径导致的垫片/忽略产物，整包运行不会出现）。CI runner 不受此垫片影响：本分支基点 `cbaf9c150` 的 `Typecheck, Lint & Test` 为 success。
