# Agent Note: gateway runtime options builder 抽离（P4a 第三刀）

Status: implemented

## Problem

第二刀把 `ProjectRuntimeRegistry` 类挪出后，`createLocalGateway.ts` 仍有 803 行，其中 `createLocalGateway()` 工厂函数本体约 606 行。它内部最大的一块是 `new InProcessGateway(router, {...})` 的**选项对象**（7903 字符 / 约 190 行）：22 个字段、其中 17 个是闭包回调（edit/regenerate 最后一条、团队面板快照与特权直调、配置与扩展热重载、每回合配置复查、回合结束收尾……）。

这 17 个回调的闭包捕获了工厂内的 18 个局部绑定，于是"网关对外能力"的声明被迫与工厂的编排逻辑交织在一起：读组合根要先穿过 190 行的 wire 协议回调清单。P4a 的目标形态里，这一块正是四个 builder 中的 **gateway builder**。

## Decision

把整个选项对象搬进新模块 `src/cli/gatewayRuntimeOptions.ts`，以 `buildGatewayRuntimeOptions(deps: GatewayRuntimeOptionsDeps): InProcessGatewayOptions` 暴露；工厂侧只留一处调用与一个 18 字段的 `deps` 字面量。

捕获绑定的处置：

| 类别 | 处置 |
|---|---|
| 15 个按值可传（`router` / `projectRoot` / `fallbackProjectRoot` / `pilotHome` / `now` / `telemetry` / `kanbanBoardManager` / `skillManager` / `cron` / `sessionPresence` / `registry` / `configStore` / `agentMaxContextTokens` / `agentMaxOutputTokens` / `memoryDiagnosticsEnabled`） | 直接作为 `deps` 字段 |
| 3 个不能按值传 | 改为取数函数，保持原闭包的**延迟求值**语义：`getGateway()`（gateway 正在构造中，edit/regenerate 预检要读它的 approval bus）、`getTeamDb()`（teams.db 声明在 gateway 之后）、`getBoundServer()`（`bindServer` 晚绑定） |

其中 `defaultRuntime.snapshot.config.agent.{maxContextTokens,maxOutputTokens}` 两处不传整个 runtime，而是把两个配置值拍平成 `deps` 字段——builder 因此不依赖 `ProjectRuntime` 类型，也就不必把该私有类型导出。

结果：`createLocalGateway.ts` **803 → 634 行**，新模块 261 行。

**改写方式是 AST 级机械改写**：脚本定位 `new InProcessGateway(router, ARG)` 的第 2 个实参节点，按节点类型规划替换 span（标识符 → `deps.x`；简写属性 → 展开为 `x: deps.x`；`options.cron` / `defaultRuntime…maxContextTokens` 整链替换；`gateway`/`teamDb`/`boundServer` → 取数调用），再从后往前按 span 替换原文——**span 之外一个字符都不动**（注释、缩进、字符串全部保留）。

## Alternatives considered

- **按子系统继续拆类内方法（`prepareSessionRuntime` 537 行等）** — 落选：那是第四刀的内容。组合根 803 行仍高于 P4a 的 ≤600 收敛目标，而 gateway builder 是"四个 builder"里唯一能一次性砍掉近 200 行的块；先满足文件级目标，再进类内。
- **手改（复制出来逐个改 `this.`/局部名）** — 落选：这 190 行里既有简写属性（`{ projectRoot, pilotHome, now }`，直接加前缀会变成非法的 `{ deps.projectRoot }`），又有与捕获变量同名的**属性键**（`{ projectRoot: input.projectKey ?? … }` 的键不能动），手改极易在 55 处替换里错一处，而错一处多半不会立刻报错（属性名写错只是静默丢失配置）。AST 规划 span 后做机械替换，把这 55 处变成可列举、可复核的清单。
- **新增 lazy 包装对象（把整个工厂上下文塞进 deps）** — 落选：会把"网关面向外能力"的输入面重新变成不透明的对象袋，等于把刚拆开的耦合换个位置藏起来。显式 18 字段虽然啰嗦，但每个字段都是 builder 的真实输入，读签名即可知依赖。
- **只把回调拆成多个小组（team 面板组 / 配置组 / 会话组）分散到多个文件** — 落选：它们共享同一批捕获绑定，拆多文件就要把同一份 deps 再传三遍，收益只是文件更小；P4a 要的是"gateway builder"这一层边界。

## Consequences

- 组合根 803 → 634 行，P4a 的 ≤600 只剩一截（第四刀：team 子系统 builder ≈226 行）。
- 行为不变由三重证据支撑：① AST 规范化对比——把 `deps.x`→`x`、简写展开、取数调用与两条配置链归一到同一记号后，基线选项对象与搬移后的选项对象**打印结果完全相同**（两侧均 5439 字符）；② 残余捕获扫描为零（搬移后的文本里不存在未改写的捕获名或 `options.*`）；③ 全量门禁 `pnpm check` + `pnpm test` 绿。
- 一处显式偏离：`const gateway` 补了类型标注 `: InProcessGateway`。`deps.getGateway: () => gateway` 让 gateway 在自身初始化表达式里被间接引用，TS 报 TS7022/TS7023（隐式 any），加标注即解——**语义不变**，只是把原先由推断得到的类型写出来。
- 事件矩阵无漂移（搬移块内无 event 生产者/消费者，`pnpm gen:event-matrix` 重跑后 `docs/event-producer-consumer.md` 无 diff）。
- P4a 剩余：第四刀 team 子系统 builder（`teamDb` / `TeamApprovalForwarder` / `runMemberScan` / `TeamScheduler` / `runStrandedScan` / `startupScanDone`，约 226 行）把组合根压进 ≤600；随后是类内 `prepareSessionRuntime` / `resolve` / `createAgentConfig` 的 builder 化。
